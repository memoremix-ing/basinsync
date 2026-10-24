use super::*;
use crate::event::{self, FlowCommand};
use std::time::Instant;
use turso_core::{Numeric, mvcc::database::RowVersion, types::ImmutableRecordRef};

#[derive(Clone, Debug, PartialEq)]
enum Cell {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}
impl Serialize for Cell {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_none(),
            Self::Integer(n) => serializer.serialize_i64(*n),
            Self::Real(n) => serializer.serialize_f64(*n),
            Self::Text(s) => serializer.serialize_str(s),
            Self::Blob(b) => serializer.serialize_bytes(b),
        }
    }
}
fn cells(values: impl IntoIterator<Item = Value>) -> Vec<Cell> {
    values
        .into_iter()
        .map(|value| match value {
            Value::Null => Cell::Null,
            Value::Numeric(Numeric::Integer(n)) => Cell::Integer(n),
            Value::Numeric(Numeric::Float(n)) => Cell::Real(f64::from(n)),
            Value::Text(s) => Cell::Text(s.as_str().into()),
            Value::Blob(b) => Cell::Blob(b.to_vec()),
        })
        .collect()
}

#[derive(Clone)]
struct Table {
    name: String,
    columns: Vec<String>,
    alias: Option<usize>,
}
type Tables = BTreeMap<i64, Table>;
fn tables(native: &Native) -> Result<Tables> {
    let mut result = BTreeMap::new();
    let mut rows = native
        .conn
        .query("SELECT name,rootpage FROM sqlite_schema WHERE type='table' AND rootpage>0")?
        .unwrap();
    while matches!(rows.step()?, StepResult::Row) {
        let row = rows.row().unwrap();
        let name: String = row.get(0)?;
        if name.starts_with("sqlite_")
            || name.starts_with("turso_")
            || name.starts_with("__turso_internal_")
        {
            continue;
        }
        let schema = native.conn.current_schema();
        let table = schema.get_btree_table(&name).unwrap();
        ensure!(
            !table.has_virtual_columns
                && table
                    .logical_to_physical_map
                    .iter()
                    .enumerate()
                    .all(|(i, &physical)| i == physical),
            "prototype requires ordinary stored columns"
        );
        result.insert(
            -row.get::<i64>(1)?,
            Table {
                name,
                columns: table
                    .columns()
                    .iter()
                    .map(|c| c.name.clone().unwrap())
                    .collect(),
                alias: table.get_rowid_alias_column().map(|(i, _)| i),
            },
        );
    }
    Ok(result)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct WeightedRow {
    row: Vec<Cell>,
    weight: i64,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
struct Relation {
    columns: Vec<String>,
    rows: Vec<WeightedRow>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
struct Feed {
    format: &'static str,
    tables: BTreeMap<String, Relation>,
}
impl Default for Feed {
    fn default() -> Self {
        Self {
            format: "row-zset/1",
            tables: BTreeMap::new(),
        }
    }
}
impl Feed {
    fn add(&mut self, table: &Table, row: Vec<Cell>, weight: i64) {
        self.tables
            .entry(table.name.clone())
            .or_insert_with(|| Relation {
                columns: table.columns.clone(),
                rows: Vec::new(),
            })
            .rows
            .push(WeightedRow { row, weight });
    }
}
fn from_versions(versions: &[RowVersion], schema: &Tables) -> Result<Feed> {
    let mut feed = Feed::default();
    for version in versions {
        let Some(table) = schema.get(&i64::from(version.row.id.table_id)) else {
            continue;
        };
        let mut row =
            cells(ImmutableRecordRef::from_bin_record(version.row.payload()).get_values_owned()?);
        if let Some(alias) = table.alias {
            row[alias] = Cell::Integer(version.row.id.row_id.to_int_or_panic());
        }
        ensure!(
            row.len() == table.columns.len(),
            "record/schema column mismatch"
        );
        feed.add(table, row, if version.end().is_some() { -1 } else { 1 });
    }
    Ok(feed)
}

#[derive(Serialize)]
struct RecordRelation {
    columns: Vec<String>,
    rowid_alias: Option<usize>,
    rows: Vec<(i64, Blob, i64)>,
}
#[derive(Serialize)]
struct RecordFeed {
    format: &'static str,
    tables: BTreeMap<String, RecordRelation>,
}
struct RowIndex {
    rows: BTreeMap<(i64, i64), Blob>,
}
impl RowIndex {
    fn load(native: &Native, schema: &Tables) -> Result<Self> {
        let mut index = Self {
            rows: BTreeMap::new(),
        };
        for (&id, table) in schema {
            let sql = format!(
                "SELECT rowid,* FROM \"{}\"",
                table.name.replace('"', "\"\"")
            );
            let mut query = native.conn.query(&sql)?.unwrap();
            while matches!(query.step()?, StepResult::Row) {
                let row = query.row().unwrap();
                let rowid = row.get::<i64>(0)?;
                let mut values = (1..=table.columns.len())
                    .map(|i| row.get::<&Value>(i).cloned())
                    .collect::<turso_core::Result<Vec<_>>>()?;
                if let Some(alias) = table.alias {
                    values[alias] = Value::Null;
                }
                let record =
                    turso_core::types::ImmutableRecord::from_values(&values, values.len())?;
                index.rows.insert((id, rowid), Blob(record.into_payload()));
            }
        }
        Ok(index)
    }
    fn apply(&mut self, versions: &[RowVersion], schema: &Tables) -> RecordFeed {
        let mut final_rows = BTreeMap::new();
        for version in versions {
            let id = i64::from(version.row.id.table_id);
            if schema.contains_key(&id) {
                final_rows.insert(
                    (id, version.row.id.row_id.to_int_or_panic()),
                    version.end().is_none().then_some(version),
                );
            }
        }
        let mut feed = RecordFeed {
            format: "sqlite-record-zset/1",
            tables: BTreeMap::new(),
        };
        for ((id, rowid), version) in final_rows {
            let table = &schema[&id];
            let relation =
                feed.tables
                    .entry(table.name.clone())
                    .or_insert_with(|| RecordRelation {
                        columns: table.columns.clone(),
                        rowid_alias: table.alias,
                        rows: Vec::new(),
                    });
            if let Some(old) = self.rows.remove(&(id, rowid)) {
                relation.rows.push((rowid, old, -1));
            }
            if let Some(version) = version {
                let record = Blob(version.row.payload().to_vec());
                relation.rows.push((rowid, record.clone(), 1));
                self.rows.insert((id, rowid), record);
            }
        }
        feed
    }
    fn bytes(&self) -> usize {
        self.rows.values().map(|v| v.0.len()).sum()
    }
}
fn decoded(records: &RecordFeed) -> Result<Feed> {
    let mut feed = Feed::default();
    for (name, relation) in &records.tables {
        let table = Table {
            name: name.clone(),
            columns: relation.columns.clone(),
            alias: relation.rowid_alias,
        };
        for (rowid, record, weight) in &relation.rows {
            let mut row = cells(ImmutableRecordRef::from_bin_record(&record.0).get_values_owned()?);
            if let Some(alias) = table.alias {
                row[alias] = Cell::Integer(*rowid);
            }
            feed.add(&table, row, *weight);
        }
    }
    Ok(feed)
}
fn enable_cdc(writer: &mut Writer) -> Result<()> {
    writer
        .state
        .native
        .conn
        .pragma_update("capture_data_changes_conn", "'full'")?;
    writer.state.native.checkpoint()?;
    writer.state.native.storage.frames.lock().unwrap().clear();
    *writer.recorder.lock().unwrap() = Recorder::default();
    Ok(())
}
fn prepare_cdc(
    writer: &mut Writer,
    parent: Option<&str>,
    commands: &[FlowCommand],
) -> Result<Delta> {
    let base = writer.cursor.clone();
    let milestone = &base + 1u8;
    let mut values = BTreeMap::new();
    let mut expected: BTreeMap<String, Viewpoint> = BTreeMap::new();
    for command in commands {
        for (flow, marker) in &command.markers {
            let next = match expected.get(flow) {
                Some(next) => next.clone(),
                None => writer
                    .latest(flow)?
                    .map_or_else(Viewpoint::zero, |v| v.next()),
            };
            let vp = marker.validate()?;
            ensure!(vp == next, "Viewpoint gap");
            expected.insert(flow.clone(), vp.next());
            values.insert(flow.as_str(), marker.viewpoint.as_str());
        }
    }
    State::transact_values(
        &writer.state.native,
        &milestone.to_string(),
        values.into_iter(),
    )?;
    let native = &writer.state.native;
    let bytes = read_file(&*native.io, &*native.storage.get_logical_log_file())?;
    let frames = std::mem::take(&mut *native.storage.frames.lock().unwrap());
    ensure!(
        !frames.is_empty()
            && frames
                .iter()
                .flat_map(|f| f.0.iter())
                .copied()
                .eq(bytes[LOG_HDR_SIZE..].iter().copied()),
        "CDC log capture mismatch"
    );
    let mut reader = StreamingLogicalLogReader::new(native.storage.get_logical_log_file(), None);
    reader.read_header(&native.io)?;
    let mut count = 0;
    while native
        .io
        .block(|| reader.next_portable_change_frame())?
        .is_some()
    {
        count += 1;
    }
    ensure!(
        count == frames.len() && reader.last_valid_offset() == bytes.len(),
        "invalid CDC logical frames"
    );
    let logical = LogicalFrames {
        base: None,
        header: Blob(bytes[..LOG_HDR_SIZE].to_vec()),
        frames,
    };
    native.checkpoint()?;
    let mut recorder = writer.recorder.lock().unwrap();
    if !recorder.current.is_empty() {
        let current = std::mem::take(&mut recorder.current);
        recorder.segments.push(Blob(current));
    }
    let physical = Frames {
        format: "sqlite-wal/1".into(),
        base: base.to_string(),
        milestone: milestone.to_string(),
        parent: parent.map(str::to_owned),
        base_sha384: None,
        segments: std::mem::take(&mut recorder.segments),
    };
    physical.validate_binding(&base, parent)?;
    physical.pages()?;
    writer.cursor = milestone;
    Ok(Delta {
        version: VERSION.into(),
        logical,
        physical,
    })
}
fn enable(native: &Native) {
    native
        .storage
        .capture_versions
        .store(true, Ordering::Relaxed);
    native.storage.versions.lock().unwrap().clear();
}
fn take(native: &Native) -> Vec<RowVersion> {
    std::mem::take(&mut *native.storage.versions.lock().unwrap())
}

fn application_feed(
    writer: &Writer,
    commands: &[FlowCommand],
    schema: &Tables,
    read: bool,
) -> Result<Feed> {
    let mut feed = Feed::default();
    let basin = schema.values().find(|t| t.name == "basin").unwrap();
    let flows = schema.values().find(|t| t.name == "flows").unwrap();
    feed.add(
        basin,
        vec![Cell::Integer(1), Cell::Text(writer.cursor.to_string())],
        -1,
    );
    feed.add(
        basin,
        vec![
            Cell::Integer(1),
            Cell::Text((&writer.cursor + 1u8).to_string()),
        ],
        1,
    );
    let mut last = BTreeMap::new();
    for command in commands {
        for (flow, marker) in &command.markers {
            if !last.contains_key(flow) {
                let old = if read {
                    writer.latest(flow)?
                } else {
                    let vp: BigUint = marker.viewpoint.parse()?;
                    if vp > 0u8.into() {
                        Some(Viewpoint::parse(&(vp - 1u8).to_string())?)
                    } else {
                        None
                    }
                };
                if let Some(old) = old {
                    feed.add(
                        flows,
                        vec![Cell::Text(flow.clone()), Cell::Text(old.decimal())],
                        -1,
                    );
                }
            }
            last.insert(flow, marker);
        }
    }
    for (flow, marker) in last {
        feed.add(
            flows,
            vec![
                Cell::Text(flow.clone()),
                Cell::Text(marker.viewpoint.clone()),
            ],
            1,
        );
    }
    Ok(feed)
}

fn snapshot(native: &Native, schema: &Tables) -> Result<Feed> {
    let mut feed = Feed::default();
    for table in schema.values() {
        let sql = format!("SELECT * FROM \"{}\"", table.name.replace('"', "\"\""));
        let mut rows = native.conn.query(&sql)?.unwrap();
        loop {
            match rows.step()? {
                StepResult::Row => feed.add(
                    table,
                    cells(
                        (0..table.columns.len())
                            .map(|i| rows.row().unwrap().get::<&Value>(i).cloned())
                            .collect::<turso_core::Result<Vec<_>>>()?,
                    ),
                    1,
                ),
                StepResult::Done => break,
                StepResult::IO => native.io.step()?,
                other => anyhow::bail!("snapshot {other:?}"),
            }
        }
    }
    Ok(feed)
}
fn consolidated(feed: &Feed) -> Result<BTreeMap<(String, Vec<u8>), i64>> {
    let mut result = BTreeMap::new();
    for (table, relation) in &feed.tables {
        for row in &relation.rows {
            *result
                .entry((table.clone(), flexbuffers::to_vec(&row.row)?))
                .or_default() += row.weight;
        }
    }
    result.retain(|_, weight| *weight != 0);
    Ok(result)
}
fn add(a: &mut Feed, b: Feed) {
    for (table, relation) in b.tables {
        a.tables
            .entry(table)
            .or_insert_with(|| Relation {
                columns: relation.columns,
                rows: Vec::new(),
            })
            .rows
            .extend(relation.rows);
    }
}

#[test]
fn row_version_hook_captures_old_values_and_transaction_net_changes() -> Result<()> {
    let genesis = State::genesis()?;
    let native = Native::open(&genesis.image, None)?;
    native.conn.execute("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT, n REAL, b BLOB); CREATE INDEX items_value ON items(value); INSERT INTO items VALUES(1,'old',1.5,x'00ff'),(2,NULL,2.5,NULL);")?;
    native.conn.execute("CREATE TABLE bag(value TEXT); INSERT INTO bag VALUES('duplicate'),('duplicate'); INSERT INTO items VALUES(5,printf('%080000d',0),NULL,zeroblob(80000));")?;
    native.checkpoint()?;
    let schema = tables(&native)?;
    let mut integrated = snapshot(&native, &schema)?;
    enable(&native);
    for sql in [
        "BEGIN CONCURRENT; UPDATE items SET value='middle' WHERE id=1; UPDATE items SET value='next' WHERE id=1; COMMIT;",
        "BEGIN CONCURRENT; DELETE FROM items WHERE id=2; INSERT INTO items VALUES(3,'transient',NULL,NULL); DELETE FROM items WHERE id=3; COMMIT;",
        "BEGIN CONCURRENT; UPDATE items SET id=4 WHERE id=1; COMMIT;",
        "BEGIN CONCURRENT; UPDATE items SET value='rolled back'; ROLLBACK;",
        "BEGIN CONCURRENT; SAVEPOINT s; UPDATE items SET value='discarded'; ROLLBACK TO s; UPDATE items SET value='kept'; RELEASE s; COMMIT;",
        "BEGIN CONCURRENT; DELETE FROM items WHERE id=4; INSERT INTO items VALUES(4,'replacement',-3.5,x'ff00'); COMMIT;",
        "BEGIN CONCURRENT; UPDATE items SET value=value; COMMIT;",
        "BEGIN CONCURRENT; UPDATE items SET b=x'00' WHERE id=5; DELETE FROM items WHERE id=5; DELETE FROM bag WHERE rowid=1; UPDATE bag SET value='changed'; COMMIT;",
    ] {
        native.conn.execute(sql)?;
        let versions = take(&native);
        let delta = from_versions(&versions, &schema)?;
        add(&mut integrated, delta);
        assert_eq!(
            consolidated(&integrated)?,
            consolidated(&snapshot(&native, &schema)?)?,
            "{sql}"
        );
        native.checkpoint()?;
    }
    let row = integrated.tables["items"]
        .rows
        .iter()
        .find(|r| r.weight == -1)
        .unwrap();
    assert_eq!(row.row[1], Cell::Text("old".into()));
    Ok(())
}

#[test]
fn hook_alone_misses_checkpointed_upsert_retractions() -> Result<()> {
    let mut writer = Writer::open(&seed(8, false)?)?;
    let schema = tables(&writer.state.native)?;
    let commands = input(0, 8, 8, &[]);
    let expected = application_feed(&writer, &commands, &schema, true)?;
    enable(&writer.state.native);
    let mut index = RowIndex::load(&writer.state.native, &schema)?;
    writer.prepare(&1u8.into(), Some("seed"), &commands)?;
    let versions = take(&writer.state.native);
    let bare = from_versions(&versions, &schema)?;
    assert!(!bare.tables["flows"].rows.iter().any(|row| row.weight < 0));
    assert_ne!(consolidated(&expected)?, consolidated(&bare)?);
    assert_eq!(
        consolidated(&expected)?,
        consolidated(&decoded(&index.apply(&versions, &schema))?)?
    );
    Ok(())
}

fn cdc_feed(native: &Native, schema: &Tables, after: &mut i64) -> Result<Feed> {
    let mut feed = Feed::default();
    let mut query=native.conn.prepare("SELECT change_id,table_name,before,after,id FROM turso_cdc WHERE change_id>?1 AND change_type!=2 ORDER BY change_id")?;
    query.bind_at(NonZeroUsize::new(1).unwrap(), Value::from_i64(*after))?;
    loop {
        match query.step()? {
            StepResult::Row => {
                let row = query.row().unwrap();
                *after = row.get(0)?;
                let name: String = row.get(1)?;
                let Some(table) = schema.values().find(|t| t.name == name) else {
                    continue;
                };
                for (column, weight) in [(2, -1), (3, 1)] {
                    match row.get::<&Value>(column)? {
                        Value::Null => {}
                        Value::Blob(blob) => {
                            let mut values = cells(
                                ImmutableRecordRef::from_bin_record(blob).get_values_owned()?,
                            );
                            if let Some(alias) = table.alias {
                                values[alias] = Cell::Integer(row.get(4)?);
                            }
                            feed.add(table, values, weight);
                        }
                        _ => anyhow::bail!("invalid CDC record"),
                    }
                }
            }
            StepResult::Done => break,
            StepResult::IO => native.io.step()?,
            other => anyhow::bail!("CDC result {other:?}"),
        }
    }
    Ok(feed)
}

#[derive(Serialize)]
struct Extra<'a, Z: Serialize> {
    version: &'a str,
    logical: &'a LogicalFrames,
    physical: &'a Frames,
    #[serde(skip_serializing_if = "Option::is_none")]
    zsets: Option<&'a Z>,
}
#[derive(Serialize)]
#[serde(untagged)]
enum Body<'a, Z: Serialize> {
    Flow(&'a FlowCommand),
    Ingest {
        turso: BTreeMap<&'static str, Extra<'a, Z>>,
    },
}
fn encode<Z: Serialize>(
    commands: &[FlowCommand],
    delta: &Delta,
    feed: Option<&Z>,
) -> Result<Vec<u8>> {
    let mut tuples = Vec::new();
    for command in commands {
        tuples.push((
            b"#species".to_vec(),
            event::NAMESPACE,
            event::COMMIT_FLOW,
            Body::Flow(command),
        ));
    }
    tuples.push((
        b"#species".to_vec(),
        event::NAMESPACE,
        event::INGEST_TURSO,
        Body::Ingest {
            turso: BTreeMap::from([(
                ID,
                Extra {
                    version: &delta.version,
                    logical: &delta.logical,
                    physical: &delta.physical,
                    zsets: feed,
                },
            )]),
        },
    ));
    Ok(flexbuffers::to_vec(tuples)?)
}

fn seed(flows: usize, cdc: bool) -> Result<Vec<u8>> {
    let initial = State::genesis()?;
    let markers = (0..flows)
        .map(|n| {
            (
                format!("flow-{n:06}"),
                Marker {
                    viewpoint: "0".into(),
                    sha384: event::digest(&[]),
                    blob: Vec::new(),
                },
            )
        })
        .collect();
    State::transact(&initial.native, "1", &markers)?;
    if cdc {
        initial
            .native
            .conn
            .pragma_update("capture_data_changes_conn", "'full'")?;
    }
    initial.native.checkpoint()?;
    initial.native.image()
}
fn input(index: usize, batch: usize, flows: usize, blob: &[u8]) -> Vec<FlowCommand> {
    let digest = event::digest(blob);
    (index..index + batch)
        .map(|n| FlowCommand {
            markers: BTreeMap::from([(
                format!("flow-{:06}", n % flows),
                Marker {
                    viewpoint: (n / flows + 1).to_string(),
                    sha384: digest.clone(),
                    blob: blob.to_vec(),
                },
            )]),
        })
        .collect()
}

#[test]
fn command_reads_and_hook_agree_for_repeated_flow_batches() -> Result<()> {
    let mut writer = Writer::open(&seed(8, false)?)?;
    let schema = tables(&writer.state.native)?;
    enable(&writer.state.native);
    let mut row_index = RowIndex::load(&writer.state.native, &schema)?;
    let mut parent = Some("seed".into());
    for n in 0..5 {
        let commands = input(n * 32, 32, 8, &[0, 255]);
        let app = application_feed(&writer, &commands, &schema, false)?;
        let reads = application_feed(&writer, &commands, &schema, true)?;
        let base = writer.cursor.clone();
        let before = writer.image()?;
        let delta = writer.prepare(&base, parent.as_deref(), &commands)?;
        let versions = take(&writer.state.native);
        let hook = decoded(&row_index.apply(&versions, &schema))?;
        assert_eq!(consolidated(&app)?, consolidated(&hook)?);
        assert_eq!(consolidated(&reads)?, consolidated(&hook)?);
        let mut integrated = snapshot(&Native::open(&before, None)?, &schema)?;
        add(&mut integrated, hook.clone());
        assert_eq!(
            consolidated(&integrated)?,
            consolidated(&snapshot(&writer.state.native, &schema)?)?
        );
        let bytes = encode(&commands, &delta, Some(&hook))?;
        let feed = flexbuffers::Reader::get_root(bytes.as_slice())?
            .get_vector()?
            .index(commands.len())?
            .get_vector()?
            .index(3)?
            .get_map()?
            .index("turso")?
            .get_map()?
            .index(ID)?
            .get_map()?
            .index("zsets")?
            .get_map()?;
        assert_eq!(feed.index("format")?.get_str()?, "row-zset/1");
        let plain = encode::<Feed>(&commands, &delta, None)?;
        assert_eq!(plain, event::encode_wal(commands, delta.clone())?);
        assert_eq!(
            delta.physical.ingest(&before, &base, parent.as_deref())?,
            writer.image()?
        );
        parent = Some(event::digest(&bytes));
    }
    Ok(())
}

#[test]
fn cdc_and_hook_agree_for_current_schema() -> Result<()> {
    let mut writer = Writer::open(&seed(8, true)?)?;
    enable_cdc(&mut writer)?;
    let schema = tables(&writer.state.native)?;
    enable(&writer.state.native);
    let mut watermark = 0;
    let mut row_index = RowIndex::load(&writer.state.native, &schema)?;
    for n in 0..3 {
        let commands = input(n * 32, 32, 8, &[0]);
        let before = writer.image()?;
        let delta = prepare_cdc(&mut writer, Some("prior"), &commands)?;
        let log = delta
            .logical
            .header
            .0
            .iter()
            .chain(delta.logical.frames.iter().flat_map(|f| f.0.iter()))
            .copied()
            .collect::<Vec<_>>();
        let replayed = Native::open(&before, Some(&log))?;
        replayed.checkpoint()?;
        assert_eq!(replayed.image()?, writer.image()?);
        assert!(delta.logical.frames.len() > 1);
        let hook = decoded(&row_index.apply(&take(&writer.state.native), &schema))?;
        let cdc = cdc_feed(&writer.state.native, &schema, &mut watermark)?;
        assert_eq!(consolidated(&hook)?, consolidated(&cdc)?);
    }
    Ok(())
}

proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config::with_cases(32))]
    #[test]
    fn weighted_changes_reconstruct_every_transaction(ops in proptest::collection::vec((0u8..5,0i64..16,proptest::option::of(".{0,32}")),1..60)){
        let native=Native::open(&State::genesis().unwrap().image,None).unwrap();
        native.conn.execute("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT)").unwrap();
        native.checkpoint().unwrap();
        let schema=tables(&native).unwrap();
        let mut integrated=snapshot(&native,&schema).unwrap();
        enable(&native);
        let mut row_index=RowIndex::load(&native,&schema).unwrap();
        for (index,(op,id,value)) in ops.into_iter().enumerate(){
            native.conn.execute("BEGIN CONCURRENT").unwrap();
            let mut stmt=native.conn.prepare(if op==0{"DELETE FROM items WHERE id=?1"}else{"INSERT INTO items VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value"}).unwrap();
            stmt.bind_at(NonZeroUsize::new(1).unwrap(),Value::from_i64(id)).unwrap();
            if op!=0{stmt.bind_at(NonZeroUsize::new(2).unwrap(),value.map_or(Value::Null,Value::build_text)).unwrap();}
            stmt.run_ignore_rows().unwrap();drop(stmt);
            native.conn.execute(if op==4{"ROLLBACK"}else{"COMMIT"}).unwrap();
            let changes=decoded(&row_index.apply(&take(&native),&schema)).unwrap();
            if op==4{proptest::prop_assert!(changes.tables.is_empty());}
            add(&mut integrated,changes);
            proptest::prop_assert_eq!(consolidated(&integrated).unwrap(),consolidated(&snapshot(&native,&schema).unwrap()).unwrap());
            if index%3==0{native.checkpoint().unwrap();}
        }
    }
}

#[test]
#[ignore = "explicit Z-set performance experiment"]
fn measure() -> Result<()> {
    use std::{env, fs};
    let variant = env::var("ZSET_VARIANT")?;
    ensure!(
        [
            "baseline",
            "app-reuse",
            "point-read",
            "hook-cache-record",
            "hook-cache-values",
            "cdc"
        ]
        .contains(&variant.as_str()),
        "unknown variant"
    );
    let flows: usize = env::var("ZSET_FLOWS")?.parse()?;
    let batch: usize = env::var("ZSET_BATCH")?.parse()?;
    let count: usize = env::var("ZSET_COUNT")?.parse()?;
    let warmup: usize = env::var("ZSET_WARMUP")?.parse()?;
    ensure!(
        flows > 0
            && batch > 0
            && count > 0
            && count.is_multiple_of(batch)
            && warmup.is_multiple_of(batch),
        "invalid benchmark sizes"
    );
    let initial = seed(flows, variant == "cdc")?;
    let initial_hash = event::digest(&initial);
    let mut writer = Writer::open(&initial)?;
    if variant == "cdc" {
        enable_cdc(&mut writer)?;
    }
    let schema = tables(&writer.state.native)?;
    let cache_start = Instant::now();
    let mut row_index = if variant.starts_with("hook-") {
        enable(&writer.state.native);
        Some(RowIndex::load(&writer.state.native, &schema)?)
    } else {
        None
    };
    let cache_init_us = cache_start.elapsed().as_secs_f64() * 1e6;
    let cache_rows = row_index.as_ref().map_or(0, |index| index.rows.len());
    let cache_record_bytes = row_index.as_ref().map_or(0, RowIndex::bytes);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    s3::set_retries(0);
    let bucket = if env::var("ZSET_MODE").as_deref() == Ok("s3") {
        Some(
            s3::Bucket::new(
                &env::var("S3_BUCKET")?,
                s3::Region::Custom {
                    region: "us-east-1".into(),
                    endpoint: env::var("S3_ENDPOINT")?,
                },
                s3::creds::Credentials::new(
                    Some(&env::var("AWS_ACCESS_KEY_ID")?),
                    Some(&env::var("AWS_SECRET_ACCESS_KEY")?),
                    None,
                    None,
                    None,
                )?,
            )?
            .with_path_style(),
        )
    } else {
        None
    };
    let blob: Vec<_> = (0..4096).map(|n| (n % 251) as u8).collect();
    let mut parent = Some("seed".into());
    let mut samples = Vec::new();
    let mut watermark = 0;
    let mut image = initial.clone();
    let mut integrated = snapshot(&writer.state.native, &schema)?;
    let mut measured = std::time::Duration::ZERO;
    let mut stored = Vec::new();
    for index in (0..warmup + count).step_by(batch) {
        let commands = input(index, batch, flows, &blob);
        let base = writer.cursor.clone();
        let start = Instant::now();
        let mut feed = if variant == "app-reuse" || variant == "point-read" {
            Some(application_feed(
                &writer,
                &commands,
                &schema,
                variant == "point-read",
            )?)
        } else {
            None
        };
        let delta = if variant == "cdc" {
            prepare_cdc(&mut writer, parent.as_deref(), &commands)?
        } else {
            writer.prepare(&base, parent.as_deref(), &commands)?
        };
        let versions = if variant.starts_with("hook-") {
            take(&writer.state.native)
        } else {
            Vec::new()
        };
        let record_feed = row_index
            .as_mut()
            .map(|index| index.apply(&versions, &schema));
        if variant == "hook-cache-values" {
            feed = Some(decoded(record_feed.as_ref().unwrap())?);
        }
        if variant == "cdc" {
            feed = Some(cdc_feed(&writer.state.native, &schema, &mut watermark)?);
        }
        let encoded = if variant == "hook-cache-record" {
            encode(&commands, &delta, record_feed.as_ref())?
        } else {
            encode(&commands, &delta, feed.as_ref())?
        };
        let digest = event::digest(&encoded);
        let cpu = start.elapsed();
        let put = Instant::now();
        if let Some(bucket) = &bucket {
            runtime.block_on(async {
                let response = bucket
                    .put_object_with_headers(
                        crate::diffuse16::key(&(&base + 1u8))?,
                        &encoded,
                        Some(axum::http::HeaderMap::from_iter([(
                            axum::http::header::IF_NONE_MATCH,
                            axum::http::HeaderValue::from_static("*"),
                        )])),
                    )
                    .await?;
                ensure!((200..300).contains(&response.status_code()), "PUT failed");
                Ok::<_, anyhow::Error>(())
            })?;
        }
        let put = put.elapsed();
        let total = start.elapsed();
        if index >= warmup {
            measured += total;
            samples.push(serde_json::json!({"cpu_us":cpu.as_secs_f64()*1e6,"put_us":put.as_secs_f64()*1e6,"latency_us":total.as_secs_f64()*1e6,"event_bytes":encoded.len(),"logical_bytes":delta.logical.frames.iter().map(|b|b.0.len()).sum::<usize>(),"physical_bytes":delta.physical.segments.iter().map(|b|b.0.len()).sum::<usize>()}));
        }
        // Verification is outside the measured interval, at every prefix.
        image = delta.physical.ingest(&image, &base, parent.as_deref())?;
        if variant == "hook-cache-record" {
            feed = Some(decoded(record_feed.as_ref().unwrap())?);
        }
        if let Some(feed) = feed {
            add(&mut integrated, feed);
        }
        parent = Some(digest);
        if bucket.is_some() {
            stored.push((&base + 1u8, encoded));
        }
    }
    ensure!(image == writer.image()?, "physical reconstruction mismatch");
    if let Some(bucket) = &bucket {
        runtime.block_on(async {
            for (milestone, bytes) in stored {
                let response = bucket
                    .get_object(crate::diffuse16::key(&milestone)?)
                    .await?;
                ensure!(
                    response.status_code() == 200 && response.as_slice() == bytes,
                    "stored event mismatch"
                );
            }
            Ok::<_, anyhow::Error>(())
        })?;
    }
    if variant != "baseline" {
        ensure!(
            consolidated(&integrated)? == consolidated(&snapshot(&writer.state.native, &schema)?)?,
            "Z-set reconstruction mismatch"
        );
    }
    let final_rows = writer.state.flows()?;
    for n in 0..flows {
        let requests = (warmup + count) / flows + usize::from(n < (warmup + count) % flows);
        ensure!(
            final_rows[&format!("flow-{n:06}")].decimal() == requests.to_string(),
            "final state mismatch"
        );
    }
    fs::write(
        env::var("ZSET_OUTPUT")?,
        serde_json::to_vec(
            &serde_json::json!({"variant":variant,"flows":flows,"batch":batch,"count":count,"warmup":warmup,"cache_init_us":cache_init_us,"cache_rows":cache_rows,"cache_record_bytes":cache_record_bytes,"initial_sha384":initial_hash,"initial_bytes":initial.len(),"final_bytes":image.len(),"requests_per_second":count as f64/measured.as_secs_f64(),"samples":samples}),
        )?,
    )?;
    Ok(())
}
