use super::*;
use anyhow::Context;
#[cfg(unix)]
use std::os::unix::fs::FileExt;
use std::{fs, io::Write};
use turso_core::io::PlatformIO;
use turso_core::{
    Clock, MonotonicInstant, WallClockInstant,
    io::{FileId, FileSyncType},
};

/// Immutable database bytes, addressable without materializing the complete file.
pub trait PageSource: Send + Sync {
    fn size(&self) -> u64;
    fn read_at(&self, offset: u64, bytes: &mut [u8]) -> std::io::Result<()>;
}

pub(crate) fn data_root() -> Result<std::path::PathBuf> {
    let root = std::env::var_os("BASINSYNC_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(".local/state"));
    fs::create_dir_all(&root)?;
    Ok(root)
}

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
    ancestor: Option<Arc<View>>,
    source: Option<Arc<dyn PageSource>>,
    materialized: std::collections::BTreeSet<u64>,
    #[cfg(test)]
    fail_after: Option<usize>,
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
                ancestor: None,
                source: None,
                materialized: Default::default(),
                #[cfg(test)]
                fail_after: None,
            }),
        }))
    }
    #[cfg(test)]
    pub(crate) fn temporary(image: &[u8]) -> Result<Arc<Self>> {
        Self::temporary_named(image, "default.turso")
    }
    pub(crate) fn temporary_named(image: &[u8], name: &str) -> Result<Arc<Self>> {
        ensure!(
            matches!(name, "default.turso" | "kernel.turso"),
            "invalid database filename"
        );
        let root = data_root()?;
        let directory = tempfile::Builder::new()
            .prefix("basinsync-")
            .tempdir_in(root)?;
        let path = directory.path().join(name);
        fs::write(&path, image)?;
        let mut store = Self::open(
            path.to_str()
                .ok_or_else(|| anyhow::anyhow!("non-UTF8 database path"))?,
            directory.path().join("history.pages").to_str().unwrap(),
        )?;
        Arc::get_mut(&mut store).unwrap()._directory = Some(directory);
        Ok(store)
    }
    pub(crate) fn from_source(source: Arc<dyn PageSource>) -> Result<Arc<Self>> {
        let store = Self::temporary_named(&[], "default.turso")?;
        {
            let mut state = store.state.lock().unwrap();
            state.base.set_len(source.size())?;
            state.source = Some(source);
        }
        Ok(store)
    }
    /// A sparse writable branch. Unchanged pages remain owned by the pinned parent.
    pub(crate) fn fork(mut view: Arc<View>) -> Result<Arc<Self>> {
        // Rejected operations which never checkpointed must not grow an ancestry chain.
        loop {
            let ancestor = {
                let state = view.store.state.lock().unwrap();
                if state.materialized.is_empty()
                    && state.source.is_none()
                    && state.versions.is_empty()
                    && state.generation == view.generation
                {
                    state
                        .ancestor
                        .as_ref()
                        .filter(|parent| parent.size == view.size)
                        .cloned()
                } else {
                    None
                }
            };
            match ancestor {
                Some(parent) => view = parent,
                None => break,
            }
        }
        let name = std::path::Path::new(view.store.path())
            .file_name()
            .and_then(|s| s.to_str())
            .context("invalid database path")?;
        let store = Self::temporary_named(&[], name)?;
        {
            let mut state = store.state.lock().unwrap();
            state.base.set_len(view.size)?;
            state.ancestor = Some(view);
        }
        // Each branch has fresh sidecars and a distinct Turso database identity.
        Ok(store)
    }
    fn read_current(s: &History, at: u64, bytes: &mut [u8]) -> std::io::Result<()> {
        let page = at / PAGE_SIZE as u64;
        if !s.materialized.contains(&page)
            && let Some(parent) = &s.ancestor
            && at < parent.size
        {
            let count = bytes.len().min((parent.size - at) as usize);
            parent.read_at(at, &mut bytes[..count])?;
            bytes[count..].fill(0);
            return Ok(());
        }
        if !s.materialized.contains(&page)
            && let Some(source) = &s.source
        {
            let count = bytes.len().min(source.size().saturating_sub(at) as usize);
            if count > 0 {
                source.read_at(at, &mut bytes[..count])?;
            }
            bytes[count..].fill(0);
            return Ok(());
        }
        s.base.read_exact_at(bytes, at)
    }
    fn materialize(s: &mut History, page: u64) -> std::io::Result<()> {
        if (s.ancestor.is_some() || s.source.is_some()) && !s.materialized.contains(&page) {
            let at = page * PAGE_SIZE as u64;
            let size = s.base.metadata()?.len();
            let count = PAGE_SIZE.min(size.saturating_sub(at) as usize);
            let mut bytes = vec![0; PAGE_SIZE];
            if count > 0 {
                Self::read_current(s, at, &mut bytes[..count])?;
            }
            s.base.write_all_at(&bytes, at)?;
            s.materialized.insert(page);
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn fail_after(&self, writes: usize) {
        self.state.lock().unwrap().fail_after = Some(writes);
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
            Self::read_current(s, page * PAGE_SIZE as u64, &mut bytes[..count]).map_err(error)?;
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
    fn read_at(&self, pos: u64, bytes: &mut [u8]) -> std::io::Result<()> {
        let s = self.store.state.lock().unwrap();
        let mut written = 0;
        while written < bytes.len() {
            let at = pos + written as u64;
            let page = at / PAGE_SIZE as u64;
            let offset = at % PAGE_SIZE as u64;
            let n = (PAGE_SIZE - offset as usize).min(bytes.len() - written);
            let old = s
                .versions
                .range((page, self.generation)..=(page, u64::MAX))
                .next()
                .map(|(_, offset)| *offset);
            if let Some(old) = old {
                s.history
                    .read_exact_at(&mut bytes[written..written + n], old + offset)?;
            } else {
                Store::read_current(&s, at, &mut bytes[written..written + n])?;
            }
            written += n;
        }
        Ok(())
    }
    pub fn size(&self) -> u64 {
        self.size
    }
    /// Zero-based physical Turso page; the final page may be short for other files.
    pub fn page(&self, page: u64) -> Result<Vec<u8>> {
        let offset = page
            .checked_mul(PAGE_SIZE as u64)
            .context("page offset overflow")?;
        ensure!(offset < self.size, "page beyond snapshot");
        let mut bytes = vec![0; PAGE_SIZE.min((self.size - offset) as usize)];
        self.read_at(offset, &mut bytes)?;
        Ok(bytes)
    }
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
        let b = c.as_read().buf();
        let s = self.store.state.lock().unwrap();
        let count = b
            .len()
            .min(s.base.metadata().map_err(error)?.len().saturating_sub(pos) as usize);
        let mut done = 0;
        while done < count {
            let at = pos + done as u64;
            let n = (PAGE_SIZE - at as usize % PAGE_SIZE).min(count - done);
            Store::read_current(&s, at, &mut b.as_mut_slice()[done..done + n]).map_err(error)?;
            done += n;
        }
        c.complete(count as i32);
        Ok(c)
    }
    fn size(&self) -> turso_core::Result<u64> {
        self.inner.size()
    }
    fn sync(&self, c: Completion, kind: FileSyncType) -> turso_core::Result<Completion> {
        self.inner.sync(c, kind)
    }
    fn pwrite(&self, pos: u64, b: Arc<Buffer>, c: Completion) -> turso_core::Result<Completion> {
        let mut s = self.store.state.lock().unwrap();
        #[cfg(test)]
        if let Some(left) = &mut s.fail_after {
            if *left == 0 {
                return Err(turso_core::LimboError::InternalError(
                    "injected partial checkpoint".into(),
                ));
            }
            *left -= 1;
        }
        Store::preserve(&mut s, pos, b.len() as u64)?;
        let original_size = self.inner.size()?;
        for page in pos / PAGE_SIZE as u64..(pos + b.len() as u64).div_ceil(PAGE_SIZE as u64) {
            Store::materialize(&mut s, page).map_err(error)?;
        }
        // Materializing a partial page may grow the sparse file beyond this write.
        let final_size = original_size.max(pos + b.len() as u64);
        let done = self.inner.pwrite(pos, b, c)?;
        self.io.wait_for_completion(done.clone())?;
        s.base.set_len(final_size).map_err(error)?;
        Ok(done)
    }
    fn truncate(&self, len: u64, c: Completion) -> turso_core::Result<Completion> {
        let mut s = self.store.state.lock().unwrap();
        let size = self.inner.size()?;
        if len < size {
            Store::preserve(&mut s, len, size - len)?;
        }
        if (s.ancestor.is_some() || s.source.is_some()) && len < size {
            // A later extension must not resurrect inherited bytes past EOF.
            for page in len / PAGE_SIZE as u64..size.div_ceil(PAGE_SIZE as u64) {
                Store::materialize(&mut s, page).map_err(error)?;
            }
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
        self.0
            .read_at(pos, &mut b.as_mut_slice()[..count])
            .map_err(error)?;
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
    fn lazy_sources_preserve_old_views_across_partial_writes_and_truncate_regrow() -> Result<()> {
        struct Source(Vec<u8>);
        impl PageSource for Source {
            fn size(&self) -> u64 {
                self.0.len() as u64
            }
            fn read_at(&self, offset: u64, bytes: &mut [u8]) -> std::io::Result<()> {
                bytes.copy_from_slice(&self.0[offset as usize..offset as usize + bytes.len()]);
                Ok(())
            }
        }
        let original = (0..PAGE_SIZE * 4)
            .map(|n| (n % 251) as u8)
            .collect::<Vec<_>>();
        let store = Store::from_source(Arc::new(Source(original.clone())))?;
        let io = store.io();
        let file = io.open_file(store.path(), OpenFlags::default(), false)?;
        let before = store.pin()?;
        let at = PAGE_SIZE - 9;
        let data = Arc::new(Buffer::new_temporary(31));
        data.as_mut_slice().fill(99);
        io.wait_for_completion(file.pwrite(at as u64, data, Completion::new_write(|_| {}))?)?;
        store.seal();
        let middle = store.pin()?;
        let cut = PAGE_SIZE + 37;
        io.wait_for_completion(file.truncate(cut as u64, Completion::new_write(|_| {}))?)?;
        store.seal();
        io.wait_for_completion(
            file.truncate(original.len() as u64, Completion::new_write(|_| {}))?,
        )?;
        store.seal();
        let after = store.pin()?;
        let mut changed = original.clone();
        changed[at..at + 31].fill(99);
        assert_eq!(before.image()?, original);
        assert_eq!(middle.image()?, changed);
        changed[cut..].fill(0);
        assert_eq!(after.image()?, changed, "regrowth resurrected source bytes");
        Ok(())
    }

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

#[cfg(test)]
mod branch_tests {
    use super::*;
    #[test]
    fn rejected_operations_do_not_build_an_unmodified_branch_chain() -> Result<()> {
        let root = Store::temporary(&vec![1; PAGE_SIZE])?;
        let mut view = root.pin()?;
        for _ in 0..128 {
            let fork = Store::fork(view)?;
            let state = fork.state.lock().unwrap();
            assert!(
                state
                    .ancestor
                    .as_ref()
                    .unwrap()
                    .store
                    .state
                    .lock()
                    .unwrap()
                    .ancestor
                    .is_none()
            );
            drop(state);
            view = fork.pin()?;
        }
        assert_eq!(view.image()?, vec![1; PAGE_SIZE]);
        Ok(())
    }
    #[test]
    fn sparse_writable_branches_keep_parents_and_pins_through_partial_writes_and_truncation()
    -> Result<()> {
        let original: Vec<_> = (0..PAGE_SIZE * 4)
            .map(|n| (n / PAGE_SIZE + 1) as u8)
            .collect();
        let root = Store::temporary(&original)?;
        let parent = root.pin()?;
        let branch = Store::fork(parent.clone())?;
        let before = branch.pin()?;
        let io = branch.io();
        let file = io.open_file(branch.path(), OpenFlags::default(), false)?;
        let b = Arc::new(Buffer::new_temporary(1));
        b.as_mut_slice()[0] = 99;
        io.wait_for_completion(file.pwrite(7, b, Completion::new_write(|_| {}))?)?;
        branch.seal();
        assert_eq!(
            branch.state.lock().unwrap().materialized.len(),
            1,
            "unchanged pages must not be copied"
        );
        let changed = branch.pin()?;
        let mut expected = original.clone();
        expected[7] = 99;
        assert_eq!(changed.image()?, expected);
        assert_eq!(before.image()?, original);
        assert_eq!(parent.image()?, original);
        let child = Store::fork(changed.clone())?;
        let cio = child.io();
        let cfile = cio.open_file(child.path(), OpenFlags::default(), false)?;
        cio.wait_for_completion(cfile.truncate(17, Completion::new_write(|_| {}))?)?;
        cio.wait_for_completion(
            cfile.truncate((PAGE_SIZE * 5) as u64, Completion::new_write(|_| {}))?,
        )?;
        child.seal();
        let mut truncated = expected[..17].to_vec();
        truncated.resize(PAGE_SIZE * 5, 0);
        assert_eq!(child.pin()?.image()?, truncated);
        assert_eq!(changed.image()?, expected);
        assert_eq!(before.image()?, original);
        Ok(())
    }
}
