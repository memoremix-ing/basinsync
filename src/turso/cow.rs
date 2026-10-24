use super::*;
#[cfg(unix)]
use std::os::unix::fs::FileExt;
use std::{fs, io::Write};
use turso_core::io::PlatformIO;
use turso_core::{
    Clock, MonotonicInstant, WallClockInstant,
    io::{FileId, FileSyncType},
};

pub(crate) struct Store {
    path: String,
    state: Mutex<History>,
    _directory: Option<tempfile::TempDir>,
}
struct Pin {
    count: usize,
    size: u64,
}
struct History {
    base: fs::File,
    history: fs::File,
    generation: u64,
    versions: BTreeMap<(u64, u64), u64>,
    pins: BTreeMap<u64, Pin>,
    free: Vec<u64>,
    highwater: u64,
}
impl Store {
    pub(crate) fn open(path: &str, history: &str) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            path: path.into(),
            _directory: None,
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
    pub(crate) fn temporary(image: &[u8]) -> Result<Arc<Self>> {
        let root = std::env::var_os("BASINSYNC_DATA_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(".local/state"));
        fs::create_dir_all(&root)?;
        let directory = tempfile::Builder::new()
            .prefix("basinsync-")
            .tempdir_in(root)?;
        let path = directory.path().join("default.turso");
        fs::write(&path, image)?;
        let mut store = Self::open(
            path.to_str()
                .ok_or_else(|| anyhow::anyhow!("non-UTF8 database path"))?,
            directory.path().join("history.pages").to_str().unwrap(),
        )?;
        Arc::get_mut(&mut store).unwrap()._directory = Some(directory);
        Ok(store)
    }
    pub(crate) fn path(&self) -> &str {
        &self.path
    }
    pub(crate) fn pin(self: &Arc<Self>) -> Result<Arc<View>> {
        let mut s = self.state.lock().unwrap();
        let generation = s.generation;
        let size = s.base.metadata()?.len();
        let pin = s.pins.entry(generation).or_insert(Pin { count: 0, size });
        ensure!(
            pin.size == size,
            "pinning a generation before sealing its checkpoint"
        );
        pin.count += 1;
        Ok(Arc::new(View {
            store: self.clone(),
            generation,
            size,
        }))
    }
    pub(crate) fn seal(&self) {
        self.state.lock().unwrap().generation += 1;
    }
    #[cfg(test)]
    pub(crate) fn retained(&self) -> (usize, u64) {
        let s = self.state.lock().unwrap();
        (s.versions.len(), s.highwater)
    }
    pub(crate) fn io(self: &Arc<Self>) -> Arc<dyn IO> {
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
            let previous = s
                .versions
                .range((page, 0)..=(page, s.generation))
                .next_back()
                .map(|((_, g), _)| *g);
            let lower = previous.map_or(std::ops::Bound::Unbounded, std::ops::Bound::Excluded);
            let needs_page = s
                .pins
                .range((lower, std::ops::Bound::Included(s.generation)))
                .any(|(_, pin)| pin.size > page * PAGE_SIZE as u64);
            if !needs_page {
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
pub struct View {
    store: Arc<Store>,
    generation: u64,
    size: u64,
}
impl Drop for View {
    fn drop(&mut self) {
        let mut s = self.store.state.lock().unwrap();
        let pins = s.pins.get_mut(&self.generation).unwrap();
        pins.count -= 1;
        if pins.count == 0 {
            s.pins.remove(&self.generation);
        }
        // Keep only versions selected by a live pin. An old, slow upload must
        // not retain every intervening generation of frequently rewritten pages.
        let mut previous = None;
        let obsolete: Vec<_> = s
            .versions
            .keys()
            .filter_map(|&(page, generation)| {
                let lower = match previous {
                    Some((p, g)) if p == page => std::ops::Bound::Excluded(g),
                    _ => std::ops::Bound::Unbounded,
                };
                previous = Some((page, generation));
                s.pins
                    .range((lower, std::ops::Bound::Included(generation)))
                    .all(|(_, pin)| pin.size <= page * PAGE_SIZE as u64)
                    .then_some((page, generation))
            })
            .collect();
        for key in obsolete {
            let offset = s.versions.remove(&key).unwrap();
            s.free.push(offset);
        }
    }
}
impl View {
    /// Read a stable checkpointed generation; the primary may continue writing.
    pub fn image(self: &Arc<Self>) -> Result<Vec<u8>> {
        let mut bytes = Vec::with_capacity(self.size as usize);
        self.copy_to(&mut bytes)?;
        Ok(bytes)
    }

    fn copy_to(self: &Arc<Self>, out: &mut impl Write) -> Result<String> {
        let mut digest = Sha384::new();
        let file = ViewFile(self.clone());
        let mut at = 0;
        while at < self.size {
            let count = (self.size - at).min(64 * 1024) as usize;
            let buffer = Arc::new(Buffer::new_temporary(count));
            drop(file.pread(at, Completion::new_read(buffer.clone(), |_| None))?);
            out.write_all(buffer.as_slice())?;
            digest.update(buffer.as_slice());
            at += count as u64;
        }
        Ok(format!("{:x}", digest.finalize()))
    }
    /// Spool one consistent image with bounded read/lock sizes and memory.
    pub fn export(self: &Arc<Self>) -> Result<(tempfile::NamedTempFile, String)> {
        let mut file = tempfile::NamedTempFile::new()?;
        let digest = self.copy_to(&mut file)?;
        Ok((file, digest))
    }
    #[cfg(test)]
    pub(crate) fn connect(self: &Arc<Self>) -> Result<Arc<Connection>> {
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
#[cfg(test)]
struct ViewIO {
    view: Arc<View>,
    path: String,
    sidecars: Arc<MemoryIO>,
}
#[cfg(test)]
impl Clock for ViewIO {
    fn current_time_monotonic(&self) -> MonotonicInstant {
        self.sidecars.current_time_monotonic()
    }
    fn current_time_wall_clock(&self) -> WallClockInstant {
        self.sidecars.current_time_wall_clock()
    }
}
#[cfg(test)]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_snapshot_retains_only_pages_selected_by_live_views() -> Result<()> {
        let original = vec![7; PAGE_SIZE * 8];
        let store = Store::temporary(&original)?;
        let io = store.io();
        let file = io.open_file(store.path(), OpenFlags::default(), false)?;
        let oldest = store.pin()?;
        for value in 0..200u16 {
            let recent = store.pin()?;
            let bytes = vec![(value % 251) as u8; PAGE_SIZE];
            write_file(&*io, &*file, &bytes)?;
            store.seal();
            drop(recent);
            assert_eq!(store.retained().0, 1);
        }
        assert_eq!(oldest.image()?, original);
        assert!(store.retained().1 <= (PAGE_SIZE * 2) as u64);
        drop(oldest);
        assert_eq!(store.retained().0, 0);
        Ok(())
    }

    #[test]
    fn export_remains_consistent_while_primary_overwrites_and_truncates() -> Result<()> {
        let original: Vec<u8> = (0..PAGE_SIZE * 32).map(|n| (n % 251) as u8).collect();
        let store = Store::temporary(&original)?;
        let view = store.pin()?;
        let io = store.io();
        let file = io.open_file(store.path(), OpenFlags::default(), false)?;
        let (entered, wait) = std::sync::mpsc::sync_channel(0);
        let (resume, gate) = std::sync::mpsc::sync_channel(0);
        struct SlowOutput {
            bytes: Vec<u8>,
            entered: Option<std::sync::mpsc::SyncSender<()>>,
            gate: std::sync::mpsc::Receiver<()>,
        }
        impl Write for SlowOutput {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.bytes.extend_from_slice(bytes);
                if let Some(entered) = self.entered.take() {
                    entered.send(()).unwrap();
                    self.gate.recv().unwrap();
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let copy = std::thread::spawn(move || -> Result<_> {
            let mut out = SlowOutput {
                bytes: vec![],
                entered: Some(entered),
                gate,
            };
            let digest = view.copy_to(&mut out)?;
            Ok((out.bytes, digest))
        });
        wait.recv()?;
        write_file(&*io, &*file, &vec![9; original.len() * 2])?;
        io.wait_for_completion(file.truncate(10, Completion::new_write(|_| {}))?)?;
        store.seal();
        resume.send(())?;
        let (bytes, digest) = copy.join().unwrap()?;
        assert_eq!(bytes, original);
        assert_eq!(digest, hash(&original));
        assert_eq!(store.retained().0, 0);
        Ok(())
    }
}

// The History mutex serializes these fallback file-position operations.
#[cfg(not(unix))]
trait FileExt {
    fn read_exact_at(&self, bytes: &mut [u8], pos: u64) -> std::io::Result<()>;
    fn write_all_at(&self, bytes: &[u8], pos: u64) -> std::io::Result<()>;
}
#[cfg(not(unix))]
impl FileExt for fs::File {
    fn read_exact_at(&self, bytes: &mut [u8], pos: u64) -> std::io::Result<()> {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = self;
        file.seek(SeekFrom::Start(pos))?;
        file.read_exact(bytes)
    }
    fn write_all_at(&self, bytes: &[u8], pos: u64) -> std::io::Result<()> {
        use std::io::{Seek, SeekFrom};
        let mut file = self;
        file.seek(SeekFrom::Start(pos))?;
        file.write_all(bytes)
    }
}
