use super::*;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};
use turso_core::{io::PlatformIO, storage::sqlite3_ondisk::read_varint};

#[path = "snapshots.rs"]
#[cfg(unix)]
mod snapshots;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::current_dir()?.join(".local").join(format!(
            "disk-shadow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root)?;
        Ok(Self(root))
    }
    fn path(&self, name: &str) -> String {
        self.0.join(name).to_str().unwrap().into()
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn open_disk(path: &str, image: &[u8]) -> Result<Native> {
    let native = Native::open_at(Arc::new(PlatformIO::new()?), path.into(), image, None, true)?;
    native.conn.pragma_update("cache_size", -2048)?;
    native.conn.pragma_update("synchronous", "FULL")?;
    if std::env::var("DISK_FULLFSYNC").as_deref() == Ok("1") {
        native.conn.pragma_update("fullfsync", "ON")?;
    }
    Ok(native)
}
fn disk_writer(path: &str, image: &[u8]) -> Result<Writer> {
    disk_writer_using(path, image, Arc::new(PlatformIO::new()?))
}
fn disk_writer_using(path: &str, image: &[u8], base: Arc<dyn IO>) -> Result<Writer> {
    let recorder = Arc::new(Mutex::new(Recorder::default()));
    let io = Arc::new(WalIO {
        inner: base,
        recorder: recorder.clone(),
    });
    let native = Native::open_at(io, path.into(), image, None, true)?;
    native.conn.pragma_update("cache_size", -2048)?;
    native.conn.pragma_update("synchronous", "FULL")?;
    if std::env::var("DISK_FULLFSYNC").as_deref() == Ok("1") {
        native.conn.pragma_update("fullfsync", "ON")?;
    }
    let state = State {
        native,
        image: Vec::new(),
    };
    let cursor = state.milestone()?.parse()?;
    *recorder.lock().unwrap() = Recorder::default();
    let bootstrap = if cursor == BigUint::from(0u8) {
        Some(image.to_vec())
    } else {
        None
    };
    Ok(Writer {
        state,
        recorder,
        cursor,
        bootstrap,
        store: None,
    })
}

fn changes(logical: &LogicalFrames) -> Result<BTreeMap<(i64, i64), Option<Blob>>> {
    logical.validated_bytes()?;
    let mut result = BTreeMap::new();
    for frame in &logical.frames {
        let bytes = &frame.0;
        ensure!(
            bytes.len() >= 48 && bytes[..4] == 0x5845564du32.to_le_bytes(),
            "expected unencrypted portable MVCC frame"
        );
        let payload = usize::try_from(u64::from_le_bytes(bytes[4..12].try_into()?))?;
        let count = u32::from_le_bytes(bytes[12..16].try_into()?);
        let extension = usize::try_from(u64::from_le_bytes(bytes[24..32].try_into()?))?;
        ensure!(
            bytes.len() == 40 + extension + payload + 8,
            "logical frame length mismatch"
        );
        let mut at = 40 + extension;
        let end = at + payload;
        for _ in 0..count {
            let header = bytes
                .get(at..at + 6)
                .ok_or_else(|| anyhow::anyhow!("truncated op"))?;
            let tag = header[0];
            let flags = header[1];
            let table = i32::from_le_bytes(header[2..6].try_into()?) as i64;
            ensure!(tag <= 4 && flags & !3 == 0, "unknown logical op");
            at += 6;
            let (size, n) = read_varint(&bytes[at..end])?;
            at += n;
            let size = usize::try_from(size)?;
            let body = bytes
                .get(at..at + size)
                .filter(|_| at + size <= end)
                .ok_or_else(|| anyhow::anyhow!("truncated op payload"))?;
            if tag <= 1 {
                ensure!(
                    table < 0 && table != -1,
                    "schema changes are outside the prototype"
                );
                let (rowid, prefix) = read_varint(body)?;
                result.insert(
                    (table, rowid as i64),
                    if tag == 0 {
                        Some(Blob(body[prefix..].to_vec()))
                    } else {
                        None
                    },
                );
            }
            at += size;
            if flags & 2 != 0 {
                let (len, n) = read_varint(&bytes[at..end])?;
                at += n + usize::try_from(len)?;
            }
            ensure!(at <= end, "op exceeds payload");
        }
        ensure!(at == end, "trailing logical ops");
    }
    Ok(result)
}

fn read_rows(
    native: &Native,
    schema: &Tables,
    keys: &BTreeSet<(i64, i64)>,
    weight: i64,
) -> Result<Feed> {
    read_conn_rows(&native.conn, schema, keys, weight)
}
fn read_conn_rows(
    conn: &Arc<Connection>,
    schema: &Tables,
    keys: &BTreeSet<(i64, i64)>,
    weight: i64,
) -> Result<Feed> {
    let mut feed = Feed::default();
    for &(id, rowid) in keys {
        let Some(table) = schema.get(&id) else {
            continue;
        };
        let rowid_column = if let Some(alias) = table.alias {
            table.columns[alias].as_str()
        } else {
            ["_rowid_", "rowid", "oid"]
                .into_iter()
                .find(|alias| !table.columns.iter().any(|c| c.eq_ignore_ascii_case(alias)))
                .ok_or_else(|| anyhow::anyhow!("all rowid aliases are shadowed"))?
        };
        let sql = format!(
            "SELECT * FROM \"{}\" WHERE \"{}\"=?1",
            table.name.replace('"', "\"\""),
            rowid_column.replace('"', "\"\"")
        );
        let mut query = conn.prepare(&sql)?;
        query.bind_at(NonZeroUsize::new(1).unwrap(), Value::from_i64(rowid))?;
        match query.step()? {
            StepResult::Row => {
                let values = (0..table.columns.len())
                    .map(|i| query.row().unwrap().get::<&Value>(i).cloned())
                    .collect::<turso_core::Result<Vec<_>>>()?;
                feed.add(table, cells(values), weight);
                ensure!(matches!(query.step()?, StepResult::Done), "duplicate rowid");
            }
            StepResult::Done => {}
            other => anyhow::bail!("shadow read {other:?}"),
        }
    }
    Ok(feed)
}

struct Shadow {
    native: Native,
    schema: Tables,
    cursor: BigUint,
    checkpoint_every: usize,
    pending: usize,
}

const ROWS: redb::TableDefinition<&[u8], &[u8]> = redb::TableDefinition::new("rows");
const META: redb::TableDefinition<&str, &str> = redb::TableDefinition::new("meta");
struct RedbCache {
    db: redb::Database,
    schema: Tables,
    real: BTreeMap<i64, Vec<usize>>,
    cursor: BigUint,
    durability: redb::Durability,
}
impl RedbCache {
    fn open(path: &str, source: &Native) -> Result<Self> {
        use redb::ReadableDatabase;
        let db = redb::Database::builder()
            .set_cache_size(2 * 1024 * 1024)
            .create(path)?;
        let schema = tables(source)?;
        let mut real = BTreeMap::new();
        for (&id, table) in &schema {
            let native_schema = source.conn.current_schema();
            let native = native_schema.get_btree_table(&table.name).unwrap();
            real.insert(
                id,
                native
                    .columns()
                    .iter()
                    .enumerate()
                    .filter_map(|(i, column)| (column.affinity().aff_mask() == 'E').then_some(i))
                    .collect(),
            );
        }
        let cursor = if db.begin_read()?.open_table(META).is_ok() {
            let transaction = db.begin_read()?;
            let meta = transaction.open_table(META)?;
            let value = meta
                .get("cursor")?
                .ok_or_else(|| anyhow::anyhow!("missing cache cursor"))?;
            value.value().parse()?
        } else {
            let mut transaction = db.begin_write()?;
            transaction.set_durability(redb::Durability::Immediate)?;
            {
                let mut rows = transaction.open_table(ROWS)?;
                for (&id, table) in &schema {
                    let key = key_column(table)?;
                    let mut query = source
                        .conn
                        .query(format!(
                            "SELECT \"{}\",* FROM \"{}\"",
                            key.replace('"', "\"\""),
                            table.name.replace('"', "\"\"")
                        ))?
                        .unwrap();
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
                            turso_core::types::ImmutableRecord::from_values(&values, values.len())?
                                .into_payload();
                        rows.insert(cache_key(id, rowid).as_slice(), record.as_slice())?;
                    }
                }
            }
            let mut query = source
                .conn
                .prepare("SELECT milestone FROM basin WHERE id=1")?;
            ensure!(
                matches!(query.step()?, StepResult::Row),
                "missing initial cursor"
            );
            let cursor: String = query.row().unwrap().get(0)?;
            ensure!(
                matches!(query.step()?, StepResult::Done),
                "duplicate cursor"
            );
            {
                let mut meta = transaction.open_table(META)?;
                meta.insert("cursor", cursor.as_str())?;
            }
            transaction.commit()?;
            cursor.parse()?
        };
        Ok(Self {
            db,
            schema,
            real,
            cursor,
            durability: redb::Durability::Immediate,
        })
    }
    fn apply(&mut self, delta: &Delta) -> Result<Feed> {
        use redb::ReadableTable;
        delta.validate_version()?;
        ensure!(
            delta.physical.base == self.cursor.to_string(),
            "redb prefix mismatch"
        );
        let changes = changes(&delta.logical)?;
        let mut transaction = self.db.begin_write()?;
        transaction.set_durability(self.durability)?;
        let mut feed = Feed::default();
        {
            let mut rows = transaction.open_table(ROWS)?;
            for ((id, rowid), record) in changes {
                let Some(table) = self.schema.get(&id) else {
                    continue;
                };
                let key = cache_key(id, rowid);
                if let Some(old) = rows.get(key.as_slice())? {
                    feed.add(
                        table,
                        cache_cells(table, &self.real[&id], rowid, old.value())?,
                        -1,
                    );
                }
                if let Some(record) = record {
                    feed.add(
                        table,
                        cache_cells(table, &self.real[&id], rowid, &record.0)?,
                        1,
                    );
                    rows.insert(key.as_slice(), record.0.as_slice())?;
                } else {
                    rows.remove(key.as_slice())?;
                }
            }
        }
        let next = &self.cursor + 1u8;
        {
            let mut meta = transaction.open_table(META)?;
            meta.insert("cursor", next.to_string().as_str())?;
        }
        transaction.commit()?;
        self.cursor = next;
        Ok(feed)
    }
}
fn cache_key(table: i64, row: i64) -> [u8; 16] {
    let mut key = [0; 16];
    key[..8].copy_from_slice(&table.to_be_bytes());
    key[8..].copy_from_slice(&row.to_be_bytes());
    key
}
fn cache_cells(table: &Table, real: &[usize], rowid: i64, record: &[u8]) -> Result<Vec<Cell>> {
    let mut row = cells(ImmutableRecordRef::from_bin_record(record).get_values_owned()?);
    ensure!(row.len() == table.columns.len(), "record layout mismatch");
    if let Some(alias) = table.alias {
        row[alias] = Cell::Integer(rowid);
    }
    for &column in real {
        if let Cell::Integer(value) = row[column] {
            row[column] = Cell::Real(value as f64);
        }
    }
    Ok(row)
}
fn key_column(table: &Table) -> Result<&str> {
    Ok(if let Some(alias) = table.alias {
        table.columns[alias].as_str()
    } else {
        ["_rowid_", "rowid", "oid"]
            .into_iter()
            .find(|alias| !table.columns.iter().any(|c| c.eq_ignore_ascii_case(alias)))
            .ok_or_else(|| anyhow::anyhow!("all rowid aliases are shadowed"))?
    })
}
enum Capture {
    None,
    Shadow(Box<Shadow>),
    Redb(Box<RedbCache>),
    #[cfg(unix)]
    Cow {
        store: Arc<snapshots::cow::Store>,
        schema: Tables,
    },
}
impl Capture {
    fn apply(&mut self, delta: &Delta) -> Result<Option<Feed>> {
        match self {
            Self::None => Ok(None),
            Self::Shadow(shadow) => shadow.apply(delta).map(Some),
            Self::Redb(cache) => cache.apply(delta).map(Some),
            #[cfg(unix)]
            Self::Cow { .. } => anyhow::bail!("COW capture requires pinned views"),
        }
    }
    #[cfg(unix)]
    fn apply_views(
        &mut self,
        delta: &Delta,
        views: Option<&(Arc<snapshots::cow::View>, Arc<snapshots::cow::View>)>,
    ) -> Result<Option<Feed>> {
        if let Self::Cow { schema, .. } = self {
            let (before, after) = views.ok_or_else(|| anyhow::anyhow!("missing COW views"))?;
            let before = before.connect()?;
            let after = after.connect()?;
            ensure!(
                snapshots::cursor(&before)? == delta.physical.base
                    && snapshots::cursor(&after)? == delta.physical.milestone,
                "COW prefix mismatch"
            );
            let keys = changes(&delta.logical)?.into_keys().collect();
            let mut feed = read_conn_rows(&before, schema, &keys, -1)?;
            add(&mut feed, read_conn_rows(&after, schema, &keys, 1)?);
            return Ok(Some(feed));
        }
        self.apply(delta)
    }
    fn finish(&mut self) -> Result<()> {
        match self {
            Self::Shadow(shadow) if shadow.pending > 0 => shadow.native.checkpoint()?,
            Self::Redb(cache) if matches!(cache.durability, redb::Durability::None) => {
                let mut transaction = cache.db.begin_write()?;
                transaction.set_durability(redb::Durability::Immediate)?;
                transaction.commit()?;
            }
            _ => {}
        }
        Ok(())
    }
}
impl Shadow {
    fn open(path: &str, image: &[u8]) -> Result<Self> {
        let native = open_disk(path, image)?;
        let schema = tables(&native)?;
        let cursor = native.conn.pragma_query("page_size")?;
        ensure!(
            cursor == vec![vec![Value::from_i64(PAGE_SIZE as i64)]],
            "wrong page size"
        );
        let state = State {
            native,
            image: Vec::new(),
        };
        let cursor = state.milestone()?.parse()?;
        Ok(Self {
            native: state.native,
            schema,
            cursor,
            checkpoint_every: 1,
            pending: 0,
        })
    }
    fn apply(&mut self, delta: &Delta) -> Result<Feed> {
        delta.validate_version()?;
        ensure!(
            delta.physical.base == self.cursor.to_string(),
            "shadow prefix mismatch"
        );
        delta.physical.pages()?;
        let keys = changes(&delta.logical)?.into_keys().collect();
        let mut feed = read_rows(&self.native, &self.schema, &keys, -1)?;
        self.native.conn.wal_insert_begin()?;
        let imported = (|| -> Result<()> {
            let mut next = self.native.conn.wal_state()?.max_frame + 1;
            for segment in &delta.physical.segments {
                for frame in segment.0[32..].chunks_exact(PAGE_SIZE + 24) {
                    self.native.conn.wal_insert_frame(next, frame)?;
                    next += 1;
                }
            }
            Ok(())
        })();
        let end = self.native.conn.wal_insert_end(false);
        imported?;
        end?;
        add(&mut feed, read_rows(&self.native, &self.schema, &keys, 1)?);
        self.pending += 1;
        if self.pending >= self.checkpoint_every {
            self.native.checkpoint()?;
            self.pending = 0;
        }
        self.cursor += 1u8;
        let mut query = self
            .native
            .conn
            .prepare("SELECT milestone FROM basin WHERE id=1")?;
        ensure!(
            matches!(query.step()?, StepResult::Row)
                && query.row().unwrap().get::<String>(0)? == self.cursor.to_string(),
            "shadow cursor mismatch"
        );
        ensure!(
            matches!(query.step()?, StepResult::Done),
            "duplicate cursor"
        );
        Ok(feed)
    }
}

#[test]
fn vfs_capture_sees_checkpoint_not_each_mvcc_commit() -> Result<()> {
    let dir = Directory::new()?;
    let path = dir.path("primary.turso");
    let writer = disk_writer(&path, &seed(8, false)?)?;
    let before = fs::read(&path)?;
    for milestone in ["1", "2"] {
        writer.state.native.conn.execute(format!(
            "UPDATE basin SET milestone='{milestone}' WHERE id=1"
        ))?;
        let recorder = writer.recorder.lock().unwrap();
        assert!(recorder.current.is_empty() && recorder.segments.is_empty());
        assert_eq!(fs::read(&path)?, before);
    }
    assert_eq!(writer.state.native.storage.frames.lock().unwrap().len(), 2);
    assert_eq!(writer.state.milestone()?, "2");
    writer.state.native.checkpoint()?;
    let recorder = writer.recorder.lock().unwrap();
    assert!(!recorder.current.is_empty() || !recorder.segments.is_empty());
    assert_ne!(fs::read(&path)?, before);
    Ok(())
}

#[test]
fn file_backed_shadow_generates_changes_and_reopens() -> Result<()> {
    let dir = Directory::new()?;
    let image = seed(8, false)?;
    let mut writer = disk_writer(&dir.path("primary.turso"), &image)?;
    let mut shadow = Shadow::open(&dir.path("shadow.turso"), &image)?;
    let mut reference = snapshot(&writer.state.native, &tables(&writer.state.native)?)?;
    for n in 0..6 {
        let commands = input(n * 32, 32, 8, &[0, 255]);
        let base = writer.cursor.clone();
        let delta = writer.prepare(&base, Some("prior"), &commands)?;
        let feed = shadow.apply(&delta)?;
        add(&mut reference, feed);
        assert_eq!(
            consolidated(&reference)?,
            consolidated(&snapshot(&writer.state.native, &shadow.schema)?)?
        );
        assert_eq!(shadow.native.image()?, writer.image()?);
        if n % 2 == 0 {
            drop(shadow);
            shadow = Shadow::open(&dir.path("shadow.turso"), &[])?;
        }
    }
    Ok(())
}

#[test]
fn shadow_uses_sql_old_values_for_generic_rows() -> Result<()> {
    let dir = Directory::new()?;
    let initial = State::genesis()?;
    initial.native.conn.execute("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT,n REAL,b BLOB); CREATE INDEX items_value ON items(value); CREATE TABLE bag(rowid TEXT,value TEXT); CREATE TABLE turso_app(value TEXT); INSERT INTO turso_app VALUES('before'); INSERT INTO items VALUES(1,'old',2.0,x'00ff'),(2,NULL,1.5,zeroblob(70000)); INSERT INTO bag VALUES('shadowed','same'),('shadowed','same');")?;
    initial.native.checkpoint()?;
    let image = initial.native.image()?;
    let mut writer = disk_writer(&dir.path("primary"), &image)?;
    writer
        .state
        .native
        .conn
        .set_portable_logical_changes_enabled(true);
    let mut shadow = Shadow::open(&dir.path("shadow"), &image)?;
    assert!(
        shadow
            .schema
            .values()
            .any(|table| table.name == "turso_app")
    );
    let mut cache = RedbCache::open(&dir.path("cache.redb"), &shadow.native)?;
    let mut integrated = snapshot(&writer.state.native, &shadow.schema)?;
    for (n,sql) in [
        "INSERT INTO items VALUES(1,'new',3.0,x'ff00') ON CONFLICT(id) DO UPDATE SET value=excluded.value,n=excluded.n,b=excluded.b; UPDATE turso_app SET value='after';",
        "DELETE FROM items WHERE id=2; UPDATE items SET id=3; DELETE FROM bag WHERE _rowid_=1;",
        "SAVEPOINT s; UPDATE items SET value='discarded'; ROLLBACK TO s; UPDATE items SET value='kept'; RELEASE s;",
        "INSERT INTO items VALUES(-9,'temporary',1.0,NULL); DELETE FROM items WHERE id=-9; UPDATE bag SET value=value;",
    ].iter().enumerate(){
        let base=writer.cursor.clone();let milestone=&base+1u8;
        writer.state.native.conn.execute(format!("BEGIN CONCURRENT; {sql} UPDATE basin SET milestone='{milestone}'; COMMIT;"))?;
        let delta=writer.capture(&base,None,milestone)?;
        let feed=shadow.apply(&delta)?;
        assert_eq!(consolidated(&feed)?,consolidated(&cache.apply(&delta)?)?);
        add(&mut integrated,feed);
        assert_eq!(consolidated(&integrated)?,consolidated(&snapshot(&writer.state.native,&shadow.schema)?)?,"transaction {n}");
        assert_eq!(shadow.native.image()?,writer.image()?);
        drop(shadow);shadow=Shadow::open(&dir.path("shadow"),&[])?;
        drop(cache);cache=RedbCache::open(&dir.path("cache.redb"),&shadow.native)?;
    }
    Ok(())
}

fn disk_seed(path: &str, event_path: &str, flows: usize, payload: usize) -> Result<()> {
    let initial = State::genesis()?;
    if payload > 0 {
        initial.native.conn.execute(format!(
            "ALTER TABLE flows ADD COLUMN payload BLOB NOT NULL DEFAULT x'{}'",
            "ab".repeat(payload)
        ))?;
        initial.native.checkpoint()?;
    }
    let image = initial.native.image()?;
    let mut writer = disk_writer(path, &image)?;
    let commands = vec![FlowCommand {
        markers: (0..flows)
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
            .collect(),
    }];
    let delta = writer.prepare(&0u8.into(), None, &commands)?;
    fs::write(event_path, event::encode_wal(commands, delta)?)?;
    Ok(())
}

#[test]
#[ignore = "file-backed benchmark seed"]
fn seed_disk() -> Result<()> {
    disk_seed(
        &std::env::var("DISK_SEED")?,
        &std::env::var("DISK_SEED_EVENT")?,
        std::env::var("DISK_FLOWS")?.parse()?,
        std::env::var("DISK_ROW_BYTES")?.parse()?,
    )
}

struct Draft {
    commands: Vec<FlowCommand>,
    delta: Delta,
    feed: Option<Feed>,
    #[cfg(unix)]
    views: Option<(Arc<snapshots::cow::View>, Arc<snapshots::cow::View>)>,
    group: usize,
    started: Instant,
    admission_us: f64,
    primary_us: f64,
    shadow_us: f64,
    primary_done: Instant,
    shadow_queued_us: f64,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
#[derive(Clone, Serialize)]
struct DiskSample {
    group: usize,
    latency_us: f64,
    admission_us: f64,
    primary_us: f64,
    shadow_us: f64,
    shadow_queued_us: f64,
    encode_us: f64,
    put_us: f64,
    event_bytes: usize,
}
struct RunResult {
    samples: Vec<DiskSample>,
    primary_seconds: f64,
    primary_finished_us: f64,
    shadow_finished_us: f64,
    total_seconds: f64,
    admitted_peak: u64,
}

fn strided_input(index: usize, batch: usize, flows: usize, blob: &[u8]) -> Vec<FlowCommand> {
    let digest = event::digest(blob);
    (index..index + batch)
        .map(|n| FlowCommand {
            markers: BTreeMap::from([(
                format!("flow-{:06}", (n * 7919) % flows),
                Marker {
                    viewpoint: (n / flows + 1).to_string(),
                    sha384: digest.clone(),
                    blob: blob.to_vec(),
                },
            )]),
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn run_pipeline(
    primary_path: String,
    mut capture: Capture,
    flows: usize,
    batch: usize,
    groups: usize,
    warmup: usize,
    window: usize,
    initial_head: String,
    shadow_delay: Duration,
    progress: Arc<AtomicU64>,
    mut publish: impl FnMut(u64, Vec<u8>) -> Result<()>,
) -> Result<RunResult> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()?;
    let handle = runtime.handle().clone();
    let admission = Arc::new(tokio::sync::Semaphore::new(window));
    let stopped = Arc::new(AtomicBool::new(false));
    let inflight = Arc::new(AtomicU64::new(0));
    let peak = Arc::new(AtomicU64::new(0));
    let (source, mut prepared) = tokio::sync::mpsc::channel::<Draft>(1);
    let (output, mut completed) = tokio::sync::mpsc::channel::<Draft>(1);
    let origin = Instant::now();
    #[cfg(unix)]
    let cow = match &capture {
        Capture::Cow { store, .. } => Some(store.clone()),
        _ => None,
    };
    let producer = {
        let admission = admission.clone();
        let stopped = stopped.clone();
        let inflight = inflight.clone();
        let peak = peak.clone();
        let handle = handle.clone();
        std::thread::spawn(move || -> Result<(f64, f64)> {
            #[cfg(unix)]
            let mut writer = match &cow {
                Some(store) => disk_writer_using(&primary_path, &[], store.io())?,
                None => disk_writer(&primary_path, &[])?,
            };
            #[cfg(not(unix))]
            let mut writer = disk_writer(&primary_path, &[])?;
            let blob: Vec<_> = (0..4096).map(|n| (n % 251) as u8).collect();
            let mut elapsed = 0.0;
            for group in 0..groups {
                let waiting = Instant::now();
                let permit = handle.block_on(admission.clone().acquire_owned())?;
                let admission_us = waiting.elapsed().as_secs_f64() * 1e6;
                ensure!(!stopped.load(Ordering::Acquire), "pipeline stopped");
                let started = Instant::now();
                let commands = strided_input(group * batch, batch, flows, &blob);
                let base = writer.cursor.clone();
                #[cfg(unix)]
                let before = cow.as_ref().map(|store| store.pin()).transpose()?;
                let delta = writer.prepare(&base, Some("unlinked"), &commands)?;
                #[cfg(unix)]
                let views = match (&cow, before) {
                    (Some(store), Some(before)) => {
                        store.seal();
                        Some((before, store.pin()?))
                    }
                    _ => None,
                };
                let primary_us = started.elapsed().as_secs_f64() * 1e6;
                progress.fetch_add(1, Ordering::Release);
                if group >= warmup {
                    elapsed += primary_us / 1e6;
                }
                let now = inflight.fetch_add(1, Ordering::AcqRel) + 1;
                peak.fetch_max(now, Ordering::AcqRel);
                source
                    .blocking_send(Draft {
                        commands,
                        delta,
                        feed: None,
                        #[cfg(unix)]
                        views,
                        group,
                        started,
                        admission_us,
                        primary_us,
                        shadow_us: 0.0,
                        primary_done: Instant::now(),
                        shadow_queued_us: 0.0,
                        _permit: permit,
                    })
                    .map_err(|_| anyhow::anyhow!("shadow stopped"))?;
            }
            Ok((elapsed, origin.elapsed().as_secs_f64() * 1e6))
        })
    };
    let shadow_worker = {
        let stopped = stopped.clone();
        std::thread::spawn(move || -> Result<f64> {
            while let Some(mut draft) = prepared.blocking_recv() {
                ensure!(!stopped.load(Ordering::Acquire), "pipeline stopped");
                draft.shadow_queued_us = draft.primary_done.elapsed().as_secs_f64() * 1e6;
                let start = Instant::now();
                if !matches!(capture, Capture::None) && !shadow_delay.is_zero() {
                    std::thread::sleep(shadow_delay);
                }
                #[cfg(unix)]
                {
                    draft.feed = capture.apply_views(&draft.delta, draft.views.take().as_ref())?;
                }
                #[cfg(not(unix))]
                {
                    draft.feed = capture.apply(&draft.delta)?;
                }
                if draft.feed.is_some() {
                    draft.shadow_us = start.elapsed().as_secs_f64() * 1e6;
                }
                output
                    .blocking_send(draft)
                    .map_err(|_| anyhow::anyhow!("uploader stopped"))?;
            }
            capture.finish()?;
            Ok(origin.elapsed().as_secs_f64() * 1e6)
        })
    };
    let mut parent = initial_head;
    let mut cursor = 1u64;
    let mut samples = Vec::new();
    let mut measured_start = (warmup == 0).then_some(origin);
    let uploaded = (|| -> Result<()> {
        while let Some(mut draft) = runtime.block_on(completed.recv()) {
            ensure!(
                draft.delta.physical.base == cursor.to_string()
                    && draft.delta.physical.milestone == (cursor + 1).to_string(),
                "upload prefix gap"
            );
            let encoding = Instant::now();
            draft.delta.physical.parent = Some(parent.clone());
            draft
                .delta
                .physical
                .validate_binding(&cursor.into(), Some(&parent))?;
            let bytes = encode(&draft.commands, &draft.delta, draft.feed.as_ref())?;
            let digest = event::digest(&bytes);
            let event_bytes = bytes.len();
            let encode_us = encoding.elapsed().as_secs_f64() * 1e6;
            let put = Instant::now();
            publish(cursor + 1, bytes)?;
            let put_us = put.elapsed().as_secs_f64() * 1e6;
            if draft.group + 1 == warmup {
                measured_start = Some(Instant::now());
            }
            cursor += 1;
            parent = digest;
            let sample = DiskSample {
                group: draft.group,
                latency_us: draft.started.elapsed().as_secs_f64() * 1e6,
                admission_us: draft.admission_us,
                primary_us: draft.primary_us,
                shadow_us: draft.shadow_us,
                shadow_queued_us: draft.shadow_queued_us,
                encode_us,
                put_us,
                event_bytes,
            };
            if draft.group >= warmup {
                samples.push(sample);
            }
            inflight.fetch_sub(1, Ordering::AcqRel);
        }
        Ok(())
    })();
    let finished = Instant::now();
    if uploaded.is_err() {
        stopped.store(true, Ordering::Release);
        admission.close();
    }
    drop(completed);
    let primary = producer
        .join()
        .map_err(|_| anyhow::anyhow!("primary panicked"))?;
    let shadow = shadow_worker
        .join()
        .map_err(|_| anyhow::anyhow!("shadow panicked"))?;
    uploaded?;
    let (primary_seconds, primary_finished_us) = primary?;
    ensure!(samples.len() == groups - warmup, "incomplete pipeline");
    Ok(RunResult {
        samples,
        primary_seconds,
        primary_finished_us,
        shadow_finished_us: shadow?,
        total_seconds: finished
            .duration_since(measured_start.unwrap())
            .as_secs_f64(),
        admitted_peak: peak.load(Ordering::Acquire),
    })
}

fn make_capture(
    kind: &str,
    dir: &Directory,
    seed_path: &str,
    primary_path: &str,
) -> Result<Capture> {
    match kind {
        "none" => Ok(Capture::None),
        #[cfg(unix)]
        "cow" => Ok(Capture::Cow {
            store: snapshots::cow::Store::open(primary_path, &dir.path("history.pages"))?,
            schema: tables(&open_disk(seed_path, &[])?)?,
        }),
        "shadow" | "shadow-normal" | "shadow-off" | "shadow-off-periodic" => {
            let path = dir.path("shadow.turso");
            fs::copy(seed_path, &path)?;
            let mut shadow = Shadow::open(&path, &[])?;
            if kind == "shadow-normal" {
                shadow.native.conn.pragma_update("synchronous", "NORMAL")?;
            }
            if kind.starts_with("shadow-off") {
                shadow.native.conn.pragma_update("synchronous", "OFF")?;
            }
            if kind == "shadow-off-periodic" {
                shadow.checkpoint_every = 32;
            }
            Ok(Capture::Shadow(Box::new(shadow)))
        }
        "redb" | "redb-none" => {
            let source = dir.path("source-snapshot.turso");
            fs::copy(seed_path, &source)?;
            let native = open_disk(&source, &[])?;
            let mut cache = RedbCache::open(&dir.path("cache.redb"), &native)?;
            if kind == "redb-none" {
                cache.durability = redb::Durability::None;
            }
            drop(native);
            for entry in fs::read_dir(&dir.0)? {
                let entry = entry?;
                if entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("source-snapshot.turso")
                {
                    fs::remove_file(entry.path())?;
                }
            }
            Ok(Capture::Redb(Box::new(cache)))
        }
        _ => anyhow::bail!("unknown capture strategy"),
    }
}

fn decoded_event(bytes: &[u8]) -> Result<(Vec<FlowCommand>, Delta, Option<Feed>)> {
    let root = flexbuffers::Reader::get_root(bytes)?.get_vector()?;
    let mut commands = Vec::new();
    let mut delta = None;
    let mut feed = None;
    for n in 0..root.len() {
        let tuple = root.index(n)?.get_vector()?;
        ensure!(
            tuple.len() == 4
                && crate::flexbuffer::read(tuple.index(0)?)?
                    == crate::flexbuffer::Extension::WellKnownSymbol("species".into())
                && tuple.index(1)?.get_str()? == event::NAMESPACE,
            "invalid command"
        );
        if n + 1 < root.len() {
            ensure!(
                tuple.index(2)?.get_str()? == event::COMMIT_FLOW,
                "invalid command order"
            );
            commands.push(FlowCommand::deserialize(tuple.index(3)?)?);
        } else {
            ensure!(
                tuple.index(2)?.get_str()? == event::INGEST_TURSO,
                "missing ingestturso"
            );
            let map = tuple
                .index(3)?
                .get_map()?
                .index("turso")?
                .get_map()?
                .index(ID)?
                .get_map()?;
            delta = Some(Delta {
                version: map.index("version")?.get_str()?.into(),
                logical: LogicalFrames::deserialize(map.index("logical")?)?,
                physical: Frames::deserialize(map.index("physical")?)?,
            });
            if let Ok(value) = map.index("zsets") {
                feed = Some(decoded_feed(value)?);
            }
        }
    }
    Ok((
        commands,
        delta.ok_or_else(|| anyhow::anyhow!("empty event"))?,
        feed,
    ))
}
fn decoded_feed(value: flexbuffers::Reader<&[u8]>) -> Result<Feed> {
    use flexbuffers::FlexBufferType as T;
    let map = value.get_map()?;
    ensure!(
        map.index("format")?.get_str()? == "row-zset/1",
        "unknown zset format"
    );
    let mut feed = Feed::default();
    let tables = map.index("tables")?.get_map()?;
    for (name, value) in tables.iter_keys().zip(tables.iter_values()) {
        let relation = value.get_map()?;
        let columns = relation
            .index("columns")?
            .get_vector()?
            .iter()
            .map(|v| v.get_str().map(String::from))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut rows = Vec::new();
        for value in relation.index("rows")?.get_vector()?.iter() {
            let weighted = value.get_map()?;
            let mut row = Vec::new();
            for value in weighted.index("row")?.get_vector()?.iter() {
                row.push(match value.flexbuffer_type() {
                    T::Null => Cell::Null,
                    T::Int => Cell::Integer(value.get_i64()?),
                    T::UInt => Cell::Integer(i64::try_from(value.get_u64()?)?),
                    T::Float => Cell::Real(value.get_f64()?),
                    T::String => Cell::Text(value.get_str()?.into()),
                    T::Blob => Cell::Blob(value.get_blob()?.0.to_vec()),
                    _ => anyhow::bail!("unknown SQL cell type"),
                });
            }
            rows.push(WeightedRow {
                row,
                weight: weighted.index("weight")?.get_i64()?,
            });
        }
        feed.tables.insert(name.into(), Relation { columns, rows });
    }
    Ok(feed)
}

fn verify_history(
    seed: &[u8],
    events: impl IntoIterator<Item = Vec<u8>>,
    expected_final: &Path,
    has_feed: bool,
) -> Result<usize> {
    let mut basin = crate::timeline::Basin::default();
    basin.apply_entry(1u8.into(), seed)?;
    let schema = tables(&basin.database.as_ref().unwrap().native)?;
    let mut integrated = consolidated(&snapshot(
        &basin.database.as_ref().unwrap().native,
        &schema,
    )?)?;
    let mut n = 1;
    for bytes in events {
        n += 1;
        let (commands, delta, feed) = decoded_event(&bytes)?;
        ensure!(feed.is_some() == has_feed, "missing/unexpected zset feed");
        if let Some(feed) = feed {
            for (key, weight) in consolidated(&feed)? {
                let entry = integrated.entry(key).or_default();
                *entry += weight;
                ensure!(*entry >= 0, "retraction of absent row");
            }
            integrated.retain(|_, weight| *weight != 0);
        }
        basin.apply_entry(n.into(), &event::encode_wal(commands, delta)?)?;
        basin.head = Some(event::digest(&bytes));
    }
    let state = basin.database.unwrap();
    ensure!(
        state.image == fs::read(expected_final)?,
        "replayed file differs from primary"
    );
    if has_feed {
        ensure!(
            integrated == consolidated(&snapshot(&state.native, &schema)?)?,
            "captured zsets differ from SQL state"
        );
    }
    Ok(n - 1)
}

#[test]
fn pipeline_overlap_is_bounded_and_publication_gates_completion() -> Result<()> {
    let dir = Directory::new()?;
    let seed_path = dir.path("seed");
    let seed_event = dir.path("seed.event");
    disk_seed(&seed_path, &seed_event, 8, 0)?;
    for kind in [
        "shadow",
        "redb",
        "shadow-normal",
        "shadow-off",
        "shadow-off-periodic",
        "redb-none",
    ]
    .into_iter()
    .chain(cfg!(unix).then_some("cow"))
    {
        let work = Directory::new()?;
        let primary = work.path("primary");
        fs::copy(&seed_path, &primary)?;
        let capture = make_capture(kind, &work, &seed_path, &primary)?;
        let progress = Arc::new(AtomicU64::new(0));
        let observe = progress.clone();
        let (entered, waiting) = std::sync::mpsc::channel();
        let (release, gate) = std::sync::mpsc::channel();
        let bytes = fs::read(&seed_event)?;
        let head = event::digest(&bytes);
        let (done, result) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut stored = Vec::new();
            let run = run_pipeline(
                primary.clone(),
                capture,
                8,
                8,
                8,
                1,
                4,
                head,
                Duration::ZERO,
                progress,
                |milestone, bytes| {
                    if milestone == 2 {
                        entered.send(())?;
                        gate.recv()?;
                    }
                    stored.push(bytes);
                    Ok(())
                },
            )
            .and_then(|run| {
                ensure!(
                    run.admitted_peak <= 4 && run.admitted_peak > 1,
                    "unbounded/serial execution"
                );
                verify_history(&bytes, stored, Path::new(&primary), true)?;
                Ok(())
            });
            done.send(run).unwrap();
            drop(work);
        });
        waiting.recv_timeout(Duration::from_secs(5))?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while observe.load(Ordering::Acquire) < 4 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(
            observe.load(Ordering::Acquire),
            4,
            "primary did not prepare ahead of blocked S3"
        );
        assert!(
            matches!(result.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)),
            "completed before S3 release"
        );
        release.send(())?;
        result.recv_timeout(Duration::from_secs(10))??;
        worker.join().unwrap();
    }
    Ok(())
}

#[test]
fn publication_failure_discards_speculation_and_keeps_recoverable_prefix() -> Result<()> {
    let seed_dir = Directory::new()?;
    let seed_path = seed_dir.path("seed");
    let seed_event = seed_dir.path("seed.event");
    disk_seed(&seed_path, &seed_event, 8, 0)?;
    let seed = fs::read(&seed_event)?;
    for kind in [
        "shadow",
        "redb",
        "shadow-normal",
        "shadow-off",
        "shadow-off-periodic",
        "redb-none",
    ]
    .into_iter()
    .chain(cfg!(unix).then_some("cow"))
    {
        let dir = Directory::new()?;
        let primary = dir.path("primary");
        fs::copy(&seed_path, &primary)?;
        let capture = make_capture(kind, &dir, &seed_path, &primary)?;
        let mut stored = Vec::new();
        let result = run_pipeline(
            primary,
            capture,
            8,
            8,
            16,
            1,
            4,
            event::digest(&seed),
            Duration::ZERO,
            Arc::new(AtomicU64::new(0)),
            |milestone, bytes| {
                stored.push(bytes);
                if milestone == 3 {
                    anyhow::bail!("stored, but reply lost");
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(stored.len(), 2);
        let recover = dir.path("recovered");
        fs::copy(&seed_path, &recover)?;
        let mut shadow = Shadow::open(&recover, &[])?;
        for event in &stored {
            let (_, delta, _) = decoded_event(event)?;
            shadow.apply(&delta)?;
        }
        drop(shadow);
        assert_eq!(verify_history(&seed, stored, Path::new(&recover), true)?, 2);
    }
    Ok(())
}

#[test]
fn reduced_stores_checkpoint_flush_and_reopen_at_the_same_prefix() -> Result<()> {
    let dir = Directory::new()?;
    let image = seed(8, false)?;
    let mut writer = disk_writer(&dir.path("primary"), &image)?;
    let mut shadow = Shadow::open(&dir.path("shadow"), &image)?;
    shadow.native.conn.pragma_update("synchronous", "OFF")?;
    shadow.checkpoint_every = 32;
    let mut cache = RedbCache::open(&dir.path("cache.redb"), &shadow.native)?;
    cache.durability = redb::Durability::None;
    for n in 0..9 {
        let commands = input(n * 32, 32, 8, &[0]);
        let base = writer.cursor.clone();
        let delta = writer.prepare(&base, Some("prior"), &commands)?;
        assert_eq!(
            consolidated(&shadow.apply(&delta)?)?,
            consolidated(&cache.apply(&delta)?)?
        );
    }
    assert!(shadow.native.conn.wal_state()?.max_frame > 0);
    shadow.native.checkpoint()?;
    assert_eq!(shadow.native.image()?, writer.image()?);
    let mut capture = Capture::Redb(Box::new(cache));
    capture.finish()?;
    drop(capture);
    drop(shadow);
    let mut shadow = Shadow::open(&dir.path("shadow"), &[])?;
    let mut cache = RedbCache::open(&dir.path("cache.redb"), &shadow.native)?;
    assert_eq!(cache.cursor, writer.cursor);
    assert_eq!(shadow.cursor, writer.cursor);
    let base = writer.cursor.clone();
    let delta = writer.prepare(&base, Some("prior"), &input(9 * 32, 32, 8, &[0]))?;
    assert_eq!(
        consolidated(&shadow.apply(&delta)?)?,
        consolidated(&cache.apply(&delta)?)?
    );
    Ok(())
}

#[test]
#[ignore = "explicit on-disk shadow/cache performance experiment"]
fn measure_disk() -> Result<()> {
    use std::env;
    let kind = env::var("DISK_CAPTURE")?;
    let mode = env::var("DISK_MODE")?;
    let flows = env::var("DISK_FLOWS")?.parse()?;
    let batch = env::var("DISK_BATCH")?.parse()?;
    let groups: usize = env::var("DISK_GROUPS")?.parse()?;
    let warmup: usize = env::var("DISK_WARMUP")?.parse()?;
    let window: usize = env::var("DISK_WINDOW")?.parse()?;
    ensure!(
        flows > 0 && batch > 0 && groups > warmup && window > 0,
        "invalid benchmark parameters"
    );
    let dir = Directory::new()?;
    let primary = dir.path("primary.turso");
    fs::copy(env::var("DISK_SEED")?, &primary)?;
    let initial_bytes = fs::metadata(&primary)?.len();
    let seed = fs::read(env::var("DISK_SEED_EVENT")?)?;
    let setup = Instant::now();
    let capture = make_capture(&kind, &dir, &env::var("DISK_SEED")?, &primary)?;
    let put_delay_ms: u64 = env::var("DISK_PUT_DELAY_MS")
        .unwrap_or_else(|_| "0".into())
        .parse()?;
    let setup_us = setup.elapsed().as_secs_f64() * 1e6;
    let before = fs::read_dir(&dir.0)?
        .map(|p| p.and_then(|p| p.metadata()).map(|m| m.len()))
        .sum::<std::io::Result<u64>>()?;
    let archive = dir.0.join("events");
    fs::create_dir(&archive)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    s3::set_retries(0);
    let bucket = if mode == "s3" {
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
    if let Some(bucket) = &bucket {
        runtime.block_on(async {
            let r = bucket
                .put_object_with_headers(
                    crate::diffuse16::key(&1u8.into())?,
                    &seed,
                    Some(axum::http::HeaderMap::from_iter([(
                        axum::http::header::IF_NONE_MATCH,
                        axum::http::HeaderValue::from_static("*"),
                    )])),
                )
                .await?;
            ensure!((200..300).contains(&r.status_code()), "seed PUT");
            Ok::<_, anyhow::Error>(())
        })?;
    }
    let result = run_pipeline(
        primary.clone(),
        capture,
        flows,
        batch,
        groups,
        warmup,
        window,
        event::digest(&seed),
        Duration::ZERO,
        Arc::new(AtomicU64::new(0)),
        |milestone, bytes| {
            if put_delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(put_delay_ms));
            }
            if let Some(bucket) = &bucket {
                runtime.block_on(async {
                    let r = bucket
                        .put_object_with_headers(
                            crate::diffuse16::key(&milestone.into())?,
                            &bytes,
                            Some(axum::http::HeaderMap::from_iter([(
                                axum::http::header::IF_NONE_MATCH,
                                axum::http::HeaderValue::from_static("*"),
                            )])),
                        )
                        .await?;
                    ensure!((200..300).contains(&r.status_code()), "event PUT");
                    Ok::<_, anyhow::Error>(())
                })?;
            } else {
                let mut file = fs::File::create(archive.join(milestone.to_string()))?;
                std::io::Write::write_all(&mut file, &bytes)?;
                file.sync_all()?;
            }
            Ok(())
        },
    )?;
    let mut events = Vec::new();
    for n in 2..groups + 2 {
        events.push(if let Some(bucket) = &bucket {
            let r = runtime.block_on(bucket.get_object(crate::diffuse16::key(&n.into())?))?;
            ensure!(r.status_code() == 200, "missing stored event");
            r.as_slice().to_vec()
        } else {
            fs::read(archive.join(n.to_string()))?
        });
    }
    ensure!(
        verify_history(&seed, events, Path::new(&primary), kind != "none")? == groups,
        "missing prefix"
    );
    let sizes = fs::read_dir(&dir.0)?
        .map(|entry| {
            let entry = entry?;
            Ok((
                entry.file_name().to_string_lossy().into_owned(),
                entry.metadata()?.len(),
            ))
        })
        .collect::<std::io::Result<BTreeMap<_, _>>>()?;
    fs::write(
        env::var("DISK_OUTPUT")?,
        serde_json::to_vec(
            &serde_json::json!({"capture":kind,"mode":mode,"flows":flows,"batch":batch,"window":window,"groups":groups,"warmup":warmup,"put_delay_ms":put_delay_ms,"initial_bytes":initial_bytes,"setup_us":setup_us,"setup_disk_bytes":before,"final_files":sizes,"primary_seconds":result.primary_seconds,"primary_finished_us":result.primary_finished_us,"shadow_finished_us":result.shadow_finished_us,"total_seconds":result.total_seconds,"requests_per_second":((groups-warmup)*batch)as f64/result.total_seconds,"admitted_peak":result.admitted_peak,"samples":result.samples}),
        )?,
    )?;
    Ok(())
}
