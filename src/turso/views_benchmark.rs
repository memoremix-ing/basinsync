use super::*;
use std::sync::{Condvar, OnceLock};

struct ReadView {
    page: Option<Arc<cow::View>>,
    conn: OnceLock<Arc<Connection>>,
}
impl ReadView {
    fn pin(db: &Arc<Database>, store: Option<&Arc<cow::Store>>) -> Result<Arc<Self>> {
        let result = Self {
            page: store.map(|s| s.pin()).transpose()?,
            conn: OnceLock::new(),
        };
        if result.page.is_none() {
            let conn = db.connect(ConnectOpts::new())?;
            conn.pragma_update("cache_size", -2048)?;
            conn.execute("BEGIN CONCURRENT")?;
            cursor(&conn)?;
            result.conn.set(conn).ok().unwrap();
        }
        Ok(Arc::new(result))
    }
    fn connection(&self) -> Result<Arc<Connection>> {
        if let Some(conn) = self.conn.get() {
            return Ok(conn.clone());
        }
        let conn = self.page.as_ref().unwrap().connect()?;
        self.conn.set(conn.clone()).ok().unwrap();
        Ok(conn)
    }
}
impl Drop for ReadView {
    fn drop(&mut self) {
        if self.page.is_none() {
            self.conn
                .get()
                .unwrap()
                .execute("ROLLBACK")
                .expect("release pinned read transaction");
        }
    }
}
#[derive(Default)]
struct Gate {
    count: Mutex<usize>,
    changed: Condvar,
    peak: std::sync::atomic::AtomicUsize,
}
impl Gate {
    fn acquire(self: &Arc<Self>, limit: usize) -> Permit {
        let mut count = self.count.lock().unwrap();
        while *count >= limit {
            count = self.changed.wait(count).unwrap();
        }
        *count += 1;
        self.peak.fetch_max(*count, Ordering::Relaxed);
        Permit(self.clone())
    }
    fn drain(&self) {
        let mut count = self.count.lock().unwrap();
        while *count > 0 {
            count = self.changed.wait(count).unwrap();
        }
    }
}
struct Permit(Arc<Gate>);
impl Drop for Permit {
    fn drop(&mut self) {
        *self.0.count.lock().unwrap() -= 1;
        self.0.changed.notify_all();
    }
}
struct Job {
    before: Arc<ReadView>,
    after: Arc<ReadView>,
    keys: BTreeSet<(i64, i64)>,
    group: usize,
    started: Instant,
    primary_us: f64,
    expected: Option<Feed>,
    _permit: Permit,
}
#[derive(Serialize)]
struct ViewSample {
    primary_us: f64,
    view_us: f64,
    feed_us: f64,
    latency_us: f64,
}
#[derive(Serialize)]
struct ViewRun {
    kind: String,
    flows: usize,
    row_bytes: usize,
    window: usize,
    batch: usize,
    groups: usize,
    rows_per_second: f64,
    samples: Vec<ViewSample>,
    history_bytes: u64,
    peak_history_pages: usize,
    peak_wal_bytes: u64,
    peak_logical_bytes: u64,
    peak_mvcc_versions: usize,
    reader_delay_ms: u64,
    admitted_peak: usize,
}

fn run(
    kind: &str,
    flows: usize,
    row_bytes: usize,
    window: usize,
    groups: usize,
    reader_delay: Duration,
    verify_each_prefix: bool,
) -> Result<ViewRun> {
    let batch = 32;
    let warmup = 8;
    let dir = Directory::new()?;
    let path = dir.path("primary.turso");
    let initial = Native::open(&seed(flows, false)?, None)?;
    if row_bytes > 0 {
        initial.conn.execute(format!(
            "ALTER TABLE flows ADD COLUMN pad BLOB; UPDATE flows SET pad=zeroblob({row_bytes})"
        ))?;
        initial.checkpoint()?;
    }
    let image = initial.image()?;
    fs::write(&path, &image)?;
    let store = (kind == "cow")
        .then(|| cow::Store::open(&path, &dir.path("history.pages")))
        .transpose()?;
    let io: Arc<dyn IO> = match &store {
        Some(s) => s.io(),
        None => Arc::new(PlatformIO::new()?),
    };
    let log = io.open_file(&format!("{path}-log"), OpenFlags::default(), false)?;
    let storage = Arc::new(CapturedStorage {
        inner: Arc::new(Storage::new(log, io.clone(), None)),
        frames: Mutex::default(),
        capture_versions: AtomicBool::new(true),
        versions: Mutex::default(),
    });
    storage.set_checkpoint_threshold(-1);
    let db = Database::open(
        io.clone(),
        &path,
        OpenOptions::new(Arc::new(SqliteDialect))
            .db_opts(
                turso_core::DatabaseOpts::new()
                    .with_experimental_mvcc_passive_checkpoint(kind == "rolling"),
            )
            .durable_storage(storage.clone() as Arc<dyn DurableStorage>),
    )?;
    let conn = db.connect(ConnectOpts::new())?;
    conn.pragma_update("cache_size", -2048)?;
    conn.pragma_update("synchronous", "FULL")?;
    let native = Native {
        conn,
        io,
        storage,
        path: path.clone(),
    };
    let schema = tables(&native)?;
    let expected_schema = schema.clone();
    let mut integrated = snapshot(&native, &schema)?;
    let gate = Arc::new(Gate::default());
    let (send, recv) = std::sync::mpsc::sync_channel::<Job>(1);
    let measured = Arc::new(Mutex::new(None));
    let start_measured = measured.clone();
    let origin = Instant::now();
    let source_gate = gate.clone();
    let source_kind = kind.to_string();
    let source_store = store.clone();
    let source = std::thread::spawn(move || -> Result<(u64, u64, usize, usize, Instant)> {
        let mut current = Some(ReadView::pin(&db, source_store.as_ref())?);
        let (mut wal_peak, mut log_peak, mut versions_peak, mut history_peak) = (0, 0, 0, 0);
        for group in 0..groups + warmup {
            if group > 0 && group % 32 == 0 {
                drop(current.take());
                source_gate.drain();
                native.checkpoint()?;
                current = Some(ReadView::pin(&db, source_store.as_ref())?);
            }
            let permit = source_gate.acquire(window);
            let started = Instant::now();
            let before = current.take().unwrap();
            let commands = strided_input(group * batch, batch, flows, &[]);
            State::transact_values(
                &native,
                &(group + 2).to_string(),
                commands.iter().flat_map(|c| {
                    c.markers
                        .iter()
                        .map(|(flow, m)| (flow.as_str(), m.viewpoint.as_str()))
                }),
            )?;
            let keys = std::mem::take(&mut *native.storage.versions.lock().unwrap())
                .into_iter()
                .map(|v| {
                    (
                        i64::from(v.row.id.table_id),
                        v.row.id.row_id.to_int_or_panic(),
                    )
                })
                .collect();
            native.storage.frames.lock().unwrap().clear();
            if source_kind == "rolling" {
                native.conn.checkpoint(CheckpointMode::Passive {
                    upper_bound_inclusive: None,
                })?;
            } else {
                native.checkpoint()?;
                source_store.as_ref().unwrap().seal();
            }
            let after = ReadView::pin(&db, source_store.as_ref())?;
            current = Some(after.clone());
            let primary_us = started.elapsed().as_secs_f64() * 1e6;
            let expected = if verify_each_prefix {
                Some(snapshot(&native, &expected_schema)?)
            } else {
                None
            };
            for (suffix, peak) in [("-wal", &mut wal_peak), ("-log", &mut log_peak)] {
                if let Ok(m) = fs::metadata(format!("{path}{suffix}")) {
                    *peak = (*peak).max(m.len());
                }
            }
            versions_peak = versions_peak.max(
                db.get_mv_store()
                    .as_ref()
                    .unwrap()
                    .live_version_count_approx(),
            );
            if let Some(s) = &source_store {
                history_peak = history_peak.max(s.retained().0);
            }
            send.send(Job {
                before,
                after,
                keys,
                group,
                started,
                primary_us,
                expected,
                _permit: permit,
            })?;
        }
        drop(current);
        drop(send);
        source_gate.drain();
        native.checkpoint()?;
        let finished = Instant::now();
        let final_image = native.image()?;
        let restored = Native::open(&final_image, None)?;
        assert_eq!(
            consolidated(&snapshot(&native, &expected_schema)?)?,
            consolidated(&snapshot(&restored, &expected_schema)?)?
        );
        Ok((wal_peak, log_peak, versions_peak, history_peak, finished))
    });
    let mut samples = Vec::new();
    while let Ok(job) = recv.recv() {
        if !reader_delay.is_zero() {
            std::thread::sleep(reader_delay);
        }
        let opening = Instant::now();
        let before = job.before.connection()?;
        let after = job.after.connection()?;
        assert_eq!(cursor(&before)?, (job.group + 1).to_string());
        assert_eq!(cursor(&after)?, (job.group + 2).to_string());
        let view_us = opening.elapsed().as_secs_f64() * 1e6;
        let start = Instant::now();
        let mut feed = read_conn_rows(&before, &schema, &job.keys, -1)?;
        add(&mut feed, read_conn_rows(&after, &schema, &job.keys, 1)?);
        let feed_us = start.elapsed().as_secs_f64() * 1e6;
        add(&mut integrated, feed);
        if let Some(expected) = &job.expected {
            assert_eq!(
                consolidated(&integrated)?,
                consolidated(expected)?,
                "prefix {}",
                job.group + 2
            );
        }
        if job.group + 1 == warmup {
            *start_measured.lock().unwrap() = Some(Instant::now());
        }
        if job.group >= warmup {
            samples.push(ViewSample {
                primary_us: job.primary_us,
                view_us,
                feed_us,
                latency_us: job.started.elapsed().as_secs_f64() * 1e6,
            });
        }
    }
    let (peak_wal_bytes, peak_logical_bytes, peak_mvcc_versions, peak_history_pages, finished) =
        source
            .join()
            .map_err(|_| anyhow::anyhow!("snapshot producer panicked"))??;
    let elapsed = finished
        .duration_since(measured.lock().unwrap().unwrap_or(origin))
        .as_secs_f64();
    let expected = Native::open(&fs::read(dir.path("primary.turso"))?, None)?;
    assert_eq!(
        consolidated(&integrated)?,
        consolidated(&snapshot(&expected, &schema)?)?
    );
    ensure!(samples.len() == groups, "missing samples");
    let history_bytes = store.as_ref().map_or(0, |s| s.retained().1);
    let admitted_peak = gate.peak.load(Ordering::Relaxed);
    assert!(admitted_peak <= window);
    if window > 1 && reader_delay >= Duration::from_millis(10) {
        assert!(admitted_peak > 1);
    }
    Ok(ViewRun {
        kind: kind.into(),
        flows,
        row_bytes,
        window,
        batch,
        groups,
        rows_per_second: (groups * batch) as f64 / elapsed,
        samples,
        history_bytes,
        peak_history_pages,
        peak_wal_bytes,
        peak_logical_bytes,
        peak_mvcc_versions,
        reader_delay_ms: reader_delay.as_millis() as u64,
        admitted_peak,
    })
}

#[test]
fn bounded_views_fold_old_and_new_rows_to_primary_state() -> Result<()> {
    for kind in ["cow", "rolling"] {
        for window in [1, 4] {
            run(kind, 128, 1024, window, 40, Duration::from_millis(10), true)?;
        }
    }
    Ok(())
}

#[test]
#[ignore]
fn measure_snapshot_readers() -> Result<()> {
    for round in 0..3 {
        for row_bytes in [0, 1024] {
            for window in [1, 4] {
                for kind in if round % 2 == 0 {
                    ["cow", "rolling"]
                } else {
                    ["rolling", "cow"]
                } {
                    let run = run(kind, 8192, row_bytes, window, 64, Duration::ZERO, false)?;
                    println!(
                        "VIEWS_BENCH {}",
                        serde_json::json!({"round":round,"result":run})
                    );
                }
            }
        }
    }
    Ok(())
}
