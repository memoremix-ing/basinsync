//! Experimental SyncVolume-backed database files. Timeline publication remains external.
use super::{Native, PAGE_SIZE, State, cow};
use crate::structures::{
    basin::{Basin, Edge, Storage},
    volume,
};
use anyhow::{Context, Result, ensure};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io,
    os::unix::fs::FileExt,
    sync::{Arc, Mutex},
};
use turso_core::Connection;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoadMode {
    LazyPages,
    EagerFile,
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
    files: Mutex<BTreeMap<String, Arc<Pages<S>>>>,
}
impl<S: Storage + Send + 'static> SyncVolume<S> {
    pub fn new(basin: Basin<S>, root: Edge, mode: LoadMode) -> Self {
        Self {
            basin: Arc::new(Mutex::new(basin)),
            root,
            mode,
            files: Mutex::new(BTreeMap::new()),
        }
    }
    pub fn open(&self, path: &str) -> Result<DatabaseFile> {
        let pages = {
            let mut files = self.files.lock().unwrap();
            if let Some(cached) = files.get(path) {
                cached.clone()
            } else {
                let count =
                    volume::dense_page_count(&mut *self.basin.lock().unwrap(), &self.root, path)?;
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
                    size,
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
            let mut page = vec![0; PAGE_SIZE];
            for p in 0..pages.size / PAGE_SIZE as u64 {
                pages.read_at(p * PAGE_SIZE as u64, &mut page)?;
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
    size: u64,
    cache: Mutex<Cache>,
}
impl<S: Storage + Send> cow::PageSource for Pages<S> {
    fn size(&self) -> u64 {
        self.size
    }
    fn read_at(&self, offset: u64, bytes: &mut [u8]) -> io::Result<()> {
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
                    let body = volume::page(
                        &mut *self.basin.lock().unwrap(),
                        &self.root,
                        &self.name,
                        &page.into(),
                        true,
                    )?
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
    ensure!(!files.is_empty(), "empty backup group");
    let mut blocks = vec![];
    let mut names = BTreeSet::new();
    for (name, view) in files {
        ensure!(names.insert(name.clone()), "duplicate backup filename");
        ensure!(
            view.size() > 0 && view.size().is_multiple_of(PAGE_SIZE as u64),
            "invalid Turso file size"
        );
        let mut pages = vec![];
        for page in 0..view.size() / PAGE_SIZE as u64 {
            pages.push((page.into(), view.page(page)?));
        }
        blocks.push((
            name,
            volume::build_block_with_inline_pages(basin, pages, inline_pages)?,
        ));
    }
    match previous {
        Some(root) => volume::replace_blocks(basin, root, blocks),
        None => volume::from_blocks(basin, blocks, vec![]),
    }
}
