use super::*;
use turso_core::{
    Clock, MonotonicInstant, WallClockInstant,
    io::{FileId, FileSyncType},
};

pub(super) struct Store {
    path: String,
    state: Mutex<History>,
}
struct History {
    base: fs::File,
    history: fs::File,
    generation: u64,
    versions: BTreeMap<(u64, u64), u64>,
    pins: BTreeMap<u64, usize>,
    free: Vec<u64>,
    highwater: u64,
}
impl Store {
    pub(super) fn open(path: &str, history: &str) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            path: path.into(),
            state: Mutex::new(History {
                base: fs::OpenOptions::new().read(true).write(true).open(path)?,
                history: fs::OpenOptions::new()
                    .create(true)
                    .truncate(true)
                    .read(true)
                    .write(true)
                    .open(history)?,
                generation: 0,
                versions: BTreeMap::new(),
                pins: BTreeMap::new(),
                free: Vec::new(),
                highwater: 0,
            }),
        }))
    }
    pub(super) fn pin(self: &Arc<Self>) -> Result<Arc<View>> {
        let mut s = self.state.lock().unwrap();
        let generation = s.generation;
        let size = s.base.metadata()?.len();
        *s.pins.entry(generation).or_default() += 1;
        Ok(Arc::new(View {
            store: self.clone(),
            generation,
            size,
        }))
    }
    pub(super) fn seal(&self) {
        self.state.lock().unwrap().generation += 1;
    }
    pub(super) fn retained(&self) -> (usize, u64) {
        let s = self.state.lock().unwrap();
        (s.versions.len(), s.highwater)
    }
    pub(super) fn io(self: &Arc<Self>) -> Arc<dyn IO> {
        Arc::new(CowIO {
            inner: Arc::new(PlatformIO::new().unwrap()),
            store: self.clone(),
        })
    }
    fn preserve(s: &mut History, start: u64, len: u64) -> turso_core::Result<()> {
        if s.pins.is_empty() || len == 0 {
            return Ok(());
        }
        let size = s.base.metadata().map_err(error)?.len();
        for page in start / PAGE_SIZE as u64..(start + len).div_ceil(PAGE_SIZE as u64) {
            let key = (page, s.generation);
            if page * PAGE_SIZE as u64 >= size || s.versions.contains_key(&key) {
                continue;
            }
            let mut bytes = vec![0; PAGE_SIZE];
            let count = PAGE_SIZE.min((size - page * PAGE_SIZE as u64) as usize);
            s.base
                .read_exact_at(&mut bytes[..count], page * PAGE_SIZE as u64)
                .map_err(error)?;
            let offset = s.free.pop().unwrap_or_else(|| {
                let n = s.highwater;
                s.highwater += PAGE_SIZE as u64;
                n
            });
            s.history.write_all_at(&bytes, offset).map_err(error)?;
            s.versions.insert(key, offset);
        }
        Ok(())
    }
}
pub(super) struct View {
    store: Arc<Store>,
    generation: u64,
    size: u64,
}
impl Drop for View {
    fn drop(&mut self) {
        let mut s = self.store.state.lock().unwrap();
        let pins = s.pins.get_mut(&self.generation).unwrap();
        *pins -= 1;
        if *pins == 0 {
            s.pins.remove(&self.generation);
        }
        let oldest = s.pins.first_key_value().map(|(&g, _)| g);
        let obsolete: Vec<_> = s
            .versions
            .keys()
            .filter(|(_, g)| oldest.is_none_or(|oldest| *g < oldest))
            .copied()
            .collect();
        for key in obsolete {
            let offset = s.versions.remove(&key).unwrap();
            s.free.push(offset);
        }
    }
}
impl View {
    pub(super) fn connect(self: &Arc<Self>) -> Result<Arc<Connection>> {
        let path = format!("{}.snapshot-{}", self.store.path, self.generation);
        let io: Arc<dyn IO> = Arc::new(ViewIO {
            view: self.clone(),
            path: path.clone(),
            sidecars: Arc::new(MemoryIO::new()),
        });
        let db = Database::open(
            io,
            &path,
            OpenOptions::new(Arc::new(SqliteDialect)).flags(OpenFlags::ReadOnly),
        )?;
        let conn = db.connect(ConnectOpts::new())?;
        conn.pragma_update("cache_size", -2048)?;
        Ok(conn)
    }
}
struct CowIO {
    inner: Arc<dyn IO>,
    store: Arc<Store>,
}
impl Clock for CowIO {
    fn current_time_monotonic(&self) -> MonotonicInstant {
        self.inner.current_time_monotonic()
    }
    fn current_time_wall_clock(&self) -> WallClockInstant {
        self.inner.current_time_wall_clock()
    }
}
impl IO for CowIO {
    fn open_file(
        &self,
        path: &str,
        flags: OpenFlags,
        direct: bool,
    ) -> turso_core::Result<Arc<dyn File>> {
        let inner = self.inner.open_file(path, flags, direct)?;
        if path == self.store.path {
            Ok(Arc::new(CowFile {
                inner,
                io: self.inner.clone(),
                store: self.store.clone(),
            }))
        } else {
            Ok(inner)
        }
    }
    fn remove_file(&self, path: &str) -> turso_core::Result<()> {
        self.inner.remove_file(path)
    }
    fn file_id(&self, path: &str) -> turso_core::Result<FileId> {
        self.inner.file_id(path)
    }
    fn step(&self) -> turso_core::Result<()> {
        self.inner.step()
    }
}
struct CowFile {
    inner: Arc<dyn File>,
    io: Arc<dyn IO>,
    store: Arc<Store>,
}
impl File for CowFile {
    fn lock_file(&self, e: bool) -> turso_core::Result<()> {
        self.inner.lock_file(e)
    }
    fn unlock_file(&self) -> turso_core::Result<()> {
        self.inner.unlock_file()
    }
    fn pread(&self, pos: u64, c: Completion) -> turso_core::Result<Completion> {
        self.inner.pread(pos, c)
    }
    fn size(&self) -> turso_core::Result<u64> {
        self.inner.size()
    }
    fn sync(&self, c: Completion, kind: FileSyncType) -> turso_core::Result<Completion> {
        self.inner.sync(c, kind)
    }
    fn pwrite(&self, pos: u64, b: Arc<Buffer>, c: Completion) -> turso_core::Result<Completion> {
        let mut s = self.store.state.lock().unwrap();
        Store::preserve(&mut s, pos, b.len() as u64)?;
        let done = self.inner.pwrite(pos, b, c)?;
        self.io.wait_for_completion(done.clone())?;
        Ok(done)
    }
    fn truncate(&self, len: u64, c: Completion) -> turso_core::Result<Completion> {
        let mut s = self.store.state.lock().unwrap();
        let size = self.inner.size()?;
        if len < size {
            Store::preserve(&mut s, len, size - len)?;
        }
        let done = self.inner.truncate(len, c)?;
        self.io.wait_for_completion(done.clone())?;
        Ok(done)
    }
}
struct ViewIO {
    view: Arc<View>,
    path: String,
    sidecars: Arc<MemoryIO>,
}
impl Clock for ViewIO {
    fn current_time_monotonic(&self) -> MonotonicInstant {
        self.sidecars.current_time_monotonic()
    }
    fn current_time_wall_clock(&self) -> WallClockInstant {
        self.sidecars.current_time_wall_clock()
    }
}
impl IO for ViewIO {
    fn open_file(
        &self,
        path: &str,
        flags: OpenFlags,
        direct: bool,
    ) -> turso_core::Result<Arc<dyn File>> {
        if path == self.path {
            Ok(Arc::new(ViewFile(self.view.clone())))
        } else {
            self.sidecars
                .open_file(path, flags | OpenFlags::Create, direct)
        }
    }
    fn remove_file(&self, _: &str) -> turso_core::Result<()> {
        Err(turso_core::LimboError::ReadOnly)
    }
    fn file_id(&self, path: &str) -> turso_core::Result<FileId> {
        Ok(FileId::from_path_hash(path))
    }
}
struct ViewFile(Arc<View>);
impl File for ViewFile {
    fn lock_file(&self, _: bool) -> turso_core::Result<()> {
        Ok(())
    }
    fn unlock_file(&self) -> turso_core::Result<()> {
        Ok(())
    }
    fn size(&self) -> turso_core::Result<u64> {
        Ok(self.0.size)
    }
    fn sync(&self, c: Completion, _: FileSyncType) -> turso_core::Result<Completion> {
        c.complete(0);
        Ok(c)
    }
    fn pwrite(&self, _: u64, _: Arc<Buffer>, _: Completion) -> turso_core::Result<Completion> {
        Err(turso_core::LimboError::ReadOnly)
    }
    fn truncate(&self, _: u64, _: Completion) -> turso_core::Result<Completion> {
        Err(turso_core::LimboError::ReadOnly)
    }
    fn pread(&self, pos: u64, c: Completion) -> turso_core::Result<Completion> {
        let b = c.as_read().buf();
        let count = (b.len() as u64).min(self.0.size.saturating_sub(pos)) as usize;
        let s = self.0.store.state.lock().unwrap();
        let mut written = 0;
        while written < count {
            let at = pos + written as u64;
            let page = at / PAGE_SIZE as u64;
            let offset = at % PAGE_SIZE as u64;
            let n = (PAGE_SIZE - offset as usize).min(count - written);
            let old = s
                .versions
                .range((page, self.0.generation)..=(page, u64::MAX))
                .next()
                .map(|(_, offset)| *offset);
            let (file, at) = old.map_or((&s.base, at), |old| (&s.history, old + offset));
            file.read_exact_at(&mut b.as_mut_slice()[written..written + n], at)
                .map_err(error)?;
            written += n;
        }
        c.complete(count as i32);
        Ok(c)
    }
}
fn error(e: std::io::Error) -> turso_core::LimboError {
    turso_core::LimboError::InternalError(e.to_string())
}

#[test]
fn cow_views_survive_primary_checkpoints_without_rebuild() -> Result<()> {
    let dir = Directory::new()?;
    let path = dir.path("primary.turso");
    fs::write(&path, seed(8, false)?)?;
    let store = Store::open(&path, &dir.path("history.pages"))?;
    let db = Database::open(store.io(), &path, OpenOptions::new(Arc::new(SqliteDialect)))?;
    let primary = db.connect(ConnectOpts::new())?;
    primary.pragma_update("mvcc_checkpoint_threshold", -1)?;
    primary.execute("CREATE TABLE items(id INTEGER PRIMARY KEY,b BLOB); CREATE INDEX items_b ON items(b); INSERT INTO items VALUES(1,zeroblob(70000)),(2,NULL)")?;
    primary.checkpoint(CheckpointMode::Truncate {
        upper_bound_inclusive: None,
    })?;
    store.seal();
    let before = store.pin()?;
    let reader = before.connect()?;
    assert_eq!(cursor(&reader)?, "1");
    primary.execute("UPDATE basin SET milestone='2' WHERE id=1; UPDATE items SET b=x'ff' WHERE id=1; DELETE FROM items WHERE id=2")?;
    primary.checkpoint(CheckpointMode::Truncate {
        upper_bound_inclusive: None,
    })?;
    store.seal();
    let after = store.pin()?;
    let next = after.connect()?;
    assert_eq!(cursor(&reader)?, "1");
    assert_eq!(cursor(&next)?, "2");
    primary.execute(
        "UPDATE basin SET milestone='3' WHERE id=1; INSERT INTO items VALUES(3,zeroblob(160000))",
    )?;
    primary.checkpoint(CheckpointMode::Truncate {
        upper_bound_inclusive: None,
    })?;
    store.seal();
    assert_eq!(cursor(&reader)?, "1");
    assert_eq!(cursor(&next)?, "2");
    assert_eq!(cursor(&store.pin()?.connect()?)?, "3");
    let lengths = |conn: &Arc<Connection>| -> Result<Vec<(i64, Option<i64>)>> {
        let mut q = conn.prepare("SELECT id,length(b) FROM items ORDER BY id")?;
        let mut result = Vec::new();
        while matches!(q.step()?, StepResult::Row) {
            let r = q.row().unwrap();
            let length = if matches!(r.get::<&Value>(1)?, Value::Null) {
                None
            } else {
                Some(r.get::<i64>(1)?)
            };
            result.push((r.get(0)?, length));
        }
        Ok(result)
    };
    assert_eq!(lengths(&reader)?, vec![(1, Some(70000)), (2, None)]);
    assert_eq!(lengths(&next)?, vec![(1, Some(1))]);
    assert_eq!(
        lengths(&store.pin()?.connect()?)?,
        vec![(1, Some(1)), (3, Some(160000))]
    );
    Ok(())
}

#[test]
fn cow_preserves_partial_writes_growth_truncation_and_reuses_history() -> Result<()> {
    let dir = Directory::new()?;
    let path = dir.path("raw.pages");
    let original = vec![7; PAGE_SIZE * 3];
    fs::write(&path, &original)?;
    let store = Store::open(&path, &dir.path("history"))?;
    let io = store.io();
    let file = io.open_file(&path, OpenFlags::default(), false)?;
    for _ in 0..50 {
        let old = store.pin()?;
        let b = Arc::new(Buffer::new_temporary(PAGE_SIZE + 100));
        b.as_mut_slice().fill(9);
        io.wait_for_completion(file.pwrite(
            (PAGE_SIZE - 50) as u64,
            b,
            Completion::new_write(|_| {}),
        )?)?;
        io.wait_for_completion(file.truncate(10, Completion::new_write(|_| {}))?)?;
        store.seal();
        let bytes = read_file(&*io, &ViewFile(old.clone()))?;
        assert_eq!(bytes, original);
        write_file(&*io, &*file, &original)?;
        store.seal();
        drop(old);
        assert_eq!(store.retained().0, 0);
    }
    assert!(store.retained().1 <= PAGE_SIZE as u64 * 6);
    Ok(())
}
