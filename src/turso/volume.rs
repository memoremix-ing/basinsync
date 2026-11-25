//! Experimental SyncVolume-backed database files. Timeline publication remains external.
use super::{Native, PAGE_SIZE, State, cow, file_io::FileExt};
use crate::structures::{
    basin::{Basin, Edge, Storage},
    profile, volume,
};
use anyhow::{Context, Result, ensure};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io,
    sync::{Arc, Mutex},
};
use turso_core::Connection;
pub mod cache;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoadMode {
    LazyPages,
    EagerFile,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadStrategy {
    Lookup,
    Cursor,
    Batched,
}
impl std::str::FromStr for LoadMode {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "lazy" => Ok(Self::LazyPages),
            "eager" => Ok(Self::EagerFile),
            _ => anyhow::bail!("expected lazy or eager load mode"),
        }
    }
}

/// One local writable database; snapshots retain prior bytes through the COW VFS.
pub struct DatabaseFile {
    native: Native,
    store: Arc<cow::Store>,
}
impl DatabaseFile {
    /// The current disk VFS, used as the experimental baseline too.
    pub fn from_image(image: &[u8]) -> Result<Self> {
        let store = cow::Store::temporary_named(image, "default.turso")?;
        Self::on_store(store)
    }
    pub fn create(schema: &str) -> Result<Self> {
        Self::from_image(&State::genesis_schema(schema)?.image)
    }
    fn on_store(store: Arc<cow::Store>) -> Result<Self> {
        let _profile = profile::span("turso.connect");
        let native = Native::connect_at(store.io(), store.path().into(), None, true)?;
        native.conn.set_portable_logical_changes_enabled(true);
        ensure!(
            native.conn.pragma_query("page_size")?
                == vec![vec![turso_core::Value::from_i64(PAGE_SIZE as i64)]],
            "expected 16 KiB Turso pages"
        );
        ensure!(
            native.conn.pragma_query("journal_mode")?
                == vec![vec![turso_core::Value::build_text("mvcc")]],
            "expected MVCC database"
        );
        native.conn.pragma_update("cache_size", -2048)?;
        native.conn.pragma_update("synchronous", "FULL")?;
        Ok(Self { native, store })
    }
    pub fn connection(&self) -> &Arc<Connection> {
        &self.native.conn
    }
    pub fn snapshot(&mut self) -> Result<Arc<cow::View>> {
        let _profile = profile::span("turso.checkpoint");
        self.native.checkpoint()?;
        self.native.storage.frames.lock().unwrap().clear();
        self.store.seal();
        self.store.pin()
    }
    /// Discard a speculative branch without reading its unchanged remote pages again.
    pub fn fork(view: Arc<cow::View>) -> Result<Self> {
        Self::on_store(cow::Store::fork(view)?)
    }
}

/// A mount is lazy even about directory lookup. Each open creates an independent
/// writable file branch; unopened files and edged directories are left alone.
pub struct SyncVolume<S: Storage + Send + 'static> {
    basin: Arc<Mutex<Basin<S>>>,
    root: Edge,
    mode: LoadMode,
    strategy: ReadStrategy,
    files: Mutex<BTreeMap<String, Arc<Pages<S>>>>,
}
impl<S: Storage + Send + 'static> SyncVolume<S> {
    /// Snapshot the already verified, bounded object cache; page sources keep
    /// their own reader lock, so a writer can read local views without reentrancy.
    pub fn cached_basin(&self) -> Basin<S>
    where
        S: Clone,
    {
        self.basin.lock().unwrap().clone()
    }
    pub fn new(basin: Basin<S>, root: Edge, mode: LoadMode) -> Self {
        Self {
            basin: Arc::new(Mutex::new(basin)),
            root,
            mode,
            strategy: ReadStrategy::Batched,
            files: Mutex::new(BTreeMap::new()),
        }
    }
    pub fn with_read_strategy(mut self, strategy: ReadStrategy) -> Self {
        self.strategy = strategy;
        self
    }
    pub fn open(&self, path: &str) -> Result<DatabaseFile> {
        let _profile = profile::span("volume.open");
        let pages = {
            let mut files = self.files.lock().unwrap();
            if let Some(cached) = files.get(path) {
                cached.clone()
            } else {
                let reader =
                    volume::PageReader::open(&mut *self.basin.lock().unwrap(), &self.root, path)?;
                let count = reader.count;
                ensure!(count > 0, "empty Turso database");
                let file = tempfile::tempfile_in(cow::data_root()?)?;
                let size = count
                    .checked_mul(PAGE_SIZE as u64)
                    .context("database size overflow")?;
                file.set_len(size)?;
                let pages = Arc::new(Pages {
                    basin: self.basin.clone(),
                    root: self.root.clone(),
                    name: path.into(),
                    provenance: provenance(&self.root, path)?,
                    size,
                    reader,
                    strategy: self.strategy,
                    cache: Mutex::new(Cache {
                        file,
                        pages: BTreeSet::new(),
                    }),
                });
                files.insert(path.into(), pages.clone());
                pages
            }
        };
        if self.mode == LoadMode::EagerFile {
            let _profile = profile::span("volume.prefetch");
            if self.strategy == ReadStrategy::Batched {
                pages.prefetch()?;
            } else {
                let _pin = if self.strategy == ReadStrategy::Cursor {
                    Some(pages.reader.pin(&mut *self.basin.lock().unwrap())?)
                } else {
                    None
                };
                let mut page = vec![0; PAGE_SIZE];
                for p in 0..pages.size / PAGE_SIZE as u64 {
                    pages.read_at(p * PAGE_SIZE as u64, &mut page)?;
                }
            }
        }
        DatabaseFile::on_store(cow::Store::from_source(pages)?)
    }
}
struct Cache {
    file: File,
    pages: BTreeSet<u64>,
}
struct Pages<S: Storage + Send> {
    basin: Arc<Mutex<Basin<S>>>,
    root: Edge,
    name: String,
    provenance: String,
    size: u64,
    reader: volume::PageReader,
    strategy: ReadStrategy,
    cache: Mutex<Cache>,
}
impl<S: Storage + Send> Pages<S> {
    fn prefetch(&self) -> Result<()> {
        let mut cache = self.cache.lock().unwrap();
        if cache.pages.len() as u64 == self.reader.count {
            return Ok(());
        }
        self.reader
            .visit(&mut *self.basin.lock().unwrap(), |index, bytes| {
                ensure!(bytes.len() == PAGE_SIZE, "invalid Turso page length");
                if !cache.pages.contains(&index) {
                    cache.file.write_all_at(bytes, index * PAGE_SIZE as u64)?;
                    cache.pages.insert(index);
                }
                Ok(())
            })
    }
}
impl<S: Storage + Send> cow::PageSource for Pages<S> {
    fn provenance(&self) -> Option<&str> {
        Some(&self.provenance)
    }
    fn size(&self) -> u64 {
        self.size
    }
    fn read_at(&self, offset: u64, bytes: &mut [u8]) -> io::Result<()> {
        let _profile = profile::span("vfs.source");
        if bytes.is_empty() {
            return Ok(());
        }
        let mut read = || -> Result<()> {
            let end = offset
                .checked_add(bytes.len() as u64)
                .context("read overflow")?;
            ensure!(end <= self.size, "read past database EOF");
            let mut cache = self.cache.lock().unwrap();
            for page in offset / PAGE_SIZE as u64..end.div_ceil(PAGE_SIZE as u64) {
                if !cache.pages.contains(&page) {
                    let mut basin = self.basin.lock().unwrap();
                    let body = if self.strategy == ReadStrategy::Lookup {
                        volume::page(&mut *basin, &self.root, &self.name, &page.into(), true)?
                    } else {
                        self.reader.page(&mut *basin, page)?
                    }
                    .context("missing Turso page")?;
                    ensure!(body.len() == PAGE_SIZE, "invalid Turso page length");
                    cache.file.write_all_at(&body, page * PAGE_SIZE as u64)?;
                    cache.pages.insert(page);
                }
            }
            cache.file.read_exact_at(bytes, offset)?;
            Ok(())
        };
        read().map_err(|e| io::Error::other(e.to_string()))
    }
}
// Bring the source trait's read method into scope for eager prefetch.
use cow::PageSource;

/// Checkpoint only selected files. A single returned root binds the entire group;
/// the caller publishes that root only after all object PUTs have succeeded.
/// Stable Basin seeds and allocation revisions allow unchanged objects to be reused.
pub fn checkpoint<S: Storage>(
    basin: &mut Basin<S>,
    previous: Option<&Edge>,
    files: Vec<(String, Arc<cow::View>)>,
    inline_pages: usize,
) -> Result<Edge> {
    checkpoint_with_algorithm(
        basin,
        previous,
        files,
        inline_pages,
        volume::Algorithm::Crc64Nvme,
    )
}
pub fn checkpoint_with_algorithm<S: Storage>(
    basin: &mut Basin<S>,
    previous: Option<&Edge>,
    files: Vec<(String, Arc<cow::View>)>,
    inline_pages: usize,
    algorithm: volume::Algorithm,
) -> Result<Edge> {
    validate_files(&files)?;
    let blocks = files
        .iter()
        .map(|(name, view)| {
            Ok((
                name.clone(),
                full_block(basin, view, inline_pages, algorithm)?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    publish_blocks(basin, previous, blocks)
}
fn full_block<S: Storage>(
    b: &mut Basin<S>,
    view: &cow::View,
    inline_pages: usize,
    algorithm: volume::Algorithm,
) -> Result<volume::BlockRoot> {
    let pages = {
        let _profile = profile::span("checkpoint.read_pages");
        (0..view.size() / PAGE_SIZE as u64)
            .map(|page| Ok((page.into(), view.page(page)?)))
            .collect::<Result<Vec<_>>>()?
    };
    let _profile = profile::span("checkpoint.blocks");
    volume::build_block_with_algorithm(b, pages, inline_pages, algorithm)
}
// All file workers and their uploads have completed before this publication.
fn publish_blocks<S: Storage>(
    b: &mut Basin<S>,
    previous: Option<&Edge>,
    blocks: Vec<(String, volume::BlockRoot)>,
) -> Result<Edge> {
    let _profile = profile::span("checkpoint.directories");
    match previous {
        Some(root) if blocks.is_empty() => Ok(root.clone()),
        Some(root) => volume::replace_blocks(b, root, blocks),
        None => volume::from_blocks(b, blocks, vec![]),
    }
}

fn provenance(root: &Edge, path: &str) -> Result<String> {
    Ok(format!(
        "{}:{}:{path}",
        crate::structures::basin::capability(root)?,
        crate::structures::basin::hex(
            crate::structures::basin::footer(root)?
                .field("sha384")?
                .blob()?
        )
    ))
}
/// A published root plus local pins for the next incremental backup. Advancing
/// returns a candidate and never changes the previous durable checkpoint.
pub struct Backup {
    root: Edge,
    files: BTreeMap<String, Arc<cow::View>>,
    algorithm: volume::Algorithm,
    inline_pages: usize,
}
impl Backup {
    pub fn root(&self) -> &Edge {
        &self.root
    }
    pub fn create<S: Storage>(
        b: &mut Basin<S>,
        files: Vec<(String, Arc<cow::View>)>,
        inline_pages: usize,
        algorithm: volume::Algorithm,
    ) -> Result<Self> {
        let root = checkpoint_with_algorithm(b, None, files.clone(), inline_pages, algorithm)?;
        Ok(Self {
            root,
            files: files.into_iter().collect(),
            algorithm,
            inline_pages,
        })
    }
    /// Resume using the publication's original packing policy. A changed policy
    /// requires full export; the encoded graph alone does not identify its budget.
    pub fn from_root(root: Edge, inline_pages: usize, algorithm: volume::Algorithm) -> Self {
        Self {
            root,
            files: BTreeMap::new(),
            algorithm,
            inline_pages,
        }
    }
    fn changed_block<S: Storage>(
        &self,
        b: &mut Basin<S>,
        name: &str,
        view: &Arc<cow::View>,
    ) -> Result<Option<volume::BlockRoot>> {
        let changed = self
            .files
            .get(name)
            .and_then(|old| view.changed_since(old))
            .or_else(|| view.changed_from_source(&provenance(&self.root, name).ok()?));
        let block = if let Some(changed) = changed {
            let count = view.size() / PAGE_SIZE as u64;
            let old_count = if let Some(old) = self.files.get(name) {
                old.size() / PAGE_SIZE as u64
            } else {
                volume::dense_page_count(b, &self.root, name)?
            };
            // A write past EOF may grow zero-filled pages which were never
            // explicitly written, especially after resuming a remote source.
            let mut dirty = changed;
            dirty.extend(old_count..count);
            dirty.retain(|p| *p < count);
            if dirty.is_empty() && count == old_count {
                return Ok(None);
            }
            let old = volume::block(b, &self.root, name)?;
            let changes = {
                let _profile = profile::span("checkpoint.read_pages");
                dirty
                    .into_iter()
                    .map(|p| Ok((p.into(), Some(view.page(p)?))))
                    .collect::<Result<Vec<_>>>()?
            };
            let _profile = profile::span("checkpoint.blocks");
            let updated = volume::update_block_truncated(
                b,
                &old,
                changes,
                (count < old_count).then(|| count.into()),
                self.inline_pages,
                self.algorithm,
            )?;
            if updated.edge == old.edge && updated.digest == old.digest {
                return Ok(None);
            }
            updated
        } else {
            // Missing provenance is a correctness boundary: rebuild this file.
            full_block(b, view, self.inline_pages, self.algorithm)?
        };
        Ok(Some(block))
    }
    /// Independent files may overlap; join every worker before returning an
    /// error or publishing the common directory root.
    pub fn advance_parallel<S: Storage + Clone + Send>(
        &self,
        b: &mut Basin<S>,
        files: Vec<(String, Arc<cow::View>)>,
        slots: usize,
    ) -> Result<Self> {
        if slots == 1 {
            return self.advance(b, files);
        }
        validate_files(&files)?;
        let blocks = file_jobs(b, &files, slots, &|local, name, view| {
            self.changed_block(local, name, view)
        })?;
        self.finish(b, files, blocks)
    }
    pub fn advance<S: Storage>(
        &self,
        b: &mut Basin<S>,
        files: Vec<(String, Arc<cow::View>)>,
    ) -> Result<Self> {
        validate_files(&files)?;
        let mut blocks = vec![];
        for (name, view) in &files {
            if let Some(block) = self.changed_block(b, name, view)? {
                blocks.push((name.clone(), block));
            }
        }
        self.finish(b, files, blocks)
    }
    fn finish<S: Storage>(
        &self,
        b: &mut Basin<S>,
        files: Vec<(String, Arc<cow::View>)>,
        blocks: Vec<(String, volume::BlockRoot)>,
    ) -> Result<Self> {
        let root = publish_blocks(b, Some(&self.root), blocks)?;
        let mut next = self.files.clone();
        next.extend(files);
        Ok(Self {
            root,
            files: next,
            algorithm: self.algorithm,
            inline_pages: self.inline_pages,
        })
    }
}

fn validate_files(files: &[(String, Arc<cow::View>)]) -> Result<()> {
    ensure!(!files.is_empty(), "empty backup group");
    let mut seen = BTreeSet::new();
    for (name, view) in files {
        ensure!(seen.insert(name), "duplicate backup filename");
        ensure!(
            view.size() > 0 && view.size().is_multiple_of(PAGE_SIZE as u64),
            "invalid Turso file size"
        );
    }
    Ok(())
}
fn file_jobs<S: Storage + Clone + Send>(
    b: &Basin<S>,
    files: &[(String, Arc<cow::View>)],
    slots: usize,
    job: &(impl Fn(&mut Basin<S>, &str, &Arc<cow::View>) -> Result<Option<volume::BlockRoot>> + Sync),
) -> Result<Vec<(String, volume::BlockRoot)>> {
    ensure!((1..=32).contains(&slots), "invalid file concurrency");
    let results = std::thread::scope(|scope| {
        let mut workers = vec![];
        for offset in 0..slots.min(files.len()) {
            let mut local = b.clone();
            workers.push(scope.spawn(move || {
                let mut out = vec![];
                for i in (offset..files.len()).step_by(slots) {
                    let (name, view) = &files[i];
                    out.push((i, job(&mut local, name, view)));
                }
                out
            }));
        }
        workers
            .into_iter()
            .flat_map(|w| w.join().expect("backup worker panicked"))
            .collect::<Vec<_>>()
    });
    let mut results = results;
    results.sort_by_key(|r| r.0);
    let mut blocks = vec![];
    for (i, result) in results {
        if let Some(block) = result? {
            blocks.push((files[i].0.clone(), block));
        }
    }
    Ok(blocks)
}

pub fn checkpoint_parallel<S: Storage + Clone + Send>(
    b: &mut Basin<S>,
    previous: Option<&Edge>,
    files: Vec<(String, Arc<cow::View>)>,
    inline_pages: usize,
    slots: usize,
) -> Result<Edge> {
    validate_files(&files)?;
    let blocks = file_jobs(b, &files, slots, &|local, _, view| {
        Ok(Some(full_block(
            local,
            view,
            inline_pages,
            volume::Algorithm::Crc64Nvme,
        )?))
    })?;
    publish_blocks(b, previous, blocks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::structures::basin::MemoryStorage;
    use crate::turso::{Buffer, Completion, OpenFlags};
    struct Source {
        bytes: Vec<u8>,
        provenance: String,
    }
    impl cow::PageSource for Source {
        fn size(&self) -> u64 {
            self.bytes.len() as u64
        }
        fn provenance(&self) -> Option<&str> {
            Some(&self.provenance)
        }
        fn read_at(&self, offset: u64, bytes: &mut [u8]) -> io::Result<()> {
            bytes.copy_from_slice(&self.bytes[offset as usize..offset as usize + bytes.len()]);
            Ok(())
        }
    }
    #[test]
    fn sparse_growth_reopens_as_the_complete_snapshot_after_resume() -> Result<()> {
        for budget in [1, 16, 1280] {
            for resumed in [false, true] {
                let store = cow::Store::temporary_named(&vec![1; PAGE_SIZE], "default.turso")?;
                let original = store.pin()?;
                let mut b = Basin::new(MemoryStorage::default(), vec![42; 32])?;
                let initial = Backup::create(
                    &mut b,
                    vec![("/db".into(), original.clone())],
                    budget,
                    volume::Algorithm::Crc64Nvme,
                )?;
                let writer = if resumed {
                    cow::Store::from_source(Arc::new(Source {
                        bytes: original.image()?,
                        provenance: provenance(initial.root(), "/db")?,
                    }))?
                } else {
                    cow::Store::fork(original.clone())?
                };
                let io = writer.io();
                let file = io.open_file(writer.path(), OpenFlags::default(), false)?;
                let data = Arc::new(Buffer::new_temporary(PAGE_SIZE));
                data.as_mut_slice().fill(9);
                io.wait_for_completion(file.pwrite(
                    (3 * PAGE_SIZE) as u64,
                    data,
                    Completion::new_write(|_| {}),
                )?)?;
                writer.seal();
                let grown = writer.pin()?;
                assert_eq!(grown.page(1)?, vec![0; PAGE_SIZE]);
                assert_eq!(grown.page(2)?, vec![0; PAGE_SIZE]);
                let backup = if resumed {
                    Backup::from_root(initial.root().clone(), budget, volume::Algorithm::Crc64Nvme)
                } else {
                    initial
                };
                let next = backup.advance(&mut b, vec![("/db".into(), grown.clone())])?;
                let reader = volume::PageReader::open(&mut b, next.root(), "/db")?;
                let mut restored = vec![0; grown.size() as usize];
                reader.visit(&mut b, |index, bytes| {
                    restored[index as usize * PAGE_SIZE..(index as usize + 1) * PAGE_SIZE]
                        .copy_from_slice(bytes);
                    Ok(())
                })?;
                assert_eq!(restored, grown.image()?);
                let full = checkpoint(&mut b, None, vec![("/db".into(), grown)], budget)?;
                assert_eq!(next.root(), &full);
                assert_eq!(original.image()?, vec![1; PAGE_SIZE]);
            }
        }
        Ok(())
    }
}
