//! Immutable disk object store for VFS experiments, with explicit transport costs.
use anyhow::{Result, ensure};
use basinsync::structures::{
    Value,
    basin::{self, Edge, PendingEdge, Storage},
    value,
};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
#[derive(Default, Clone, Debug, serde::Serialize)]
pub struct Stats {
    pub gets: u64,
    pub get_bytes: u64,
    pub puts: u64,
    pub put_bytes: u64,
    pub reused: u64,
}
#[derive(Clone)]
pub struct DiskObjects {
    pub root: PathBuf,
    pub stats: Arc<Mutex<Stats>>,
    pub delay: Duration,
    pub bytes_per_second: u64,
    pub fail_reads: Arc<Mutex<bool>>,
    pub fail_writes: Arc<Mutex<Option<usize>>>,
    pub read_keys: Arc<Mutex<std::collections::BTreeSet<String>>>,
    pub forbidden: Arc<Mutex<std::collections::BTreeSet<String>>>,
}
impl DiskObjects {
    pub fn new(root: &Path) -> Result<Self> {
        fs::create_dir_all(root)?;
        Ok(Self {
            root: root.into(),
            stats: Default::default(),
            delay: Duration::ZERO,
            bytes_per_second: 0,
            fail_reads: Default::default(),
            fail_writes: Default::default(),
            read_keys: Default::default(),
            forbidden: Default::default(),
        })
    }
    pub fn reset(&self) {
        *self.stats.lock().unwrap() = Stats::default();
        self.read_keys.lock().unwrap().clear();
    }
    pub fn stats(&self) -> Stats {
        self.stats.lock().unwrap().clone()
    }
    fn wait(&self, size: usize) {
        let transfer = if self.bytes_per_second == 0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(size as f64 / self.bytes_per_second as f64)
        };
        std::thread::sleep(self.delay + transfer);
    }
    pub fn read_raw(&self, key: &str) -> Result<Vec<u8>> {
        ensure!(
            !*self.fail_reads.lock().unwrap(),
            "injected object read failure"
        );
        ensure!(
            !self.forbidden.lock().unwrap().contains(key),
            "unrequested object read"
        );
        self.read_keys.lock().unwrap().insert(key.into());
        let bytes = fs::read(self.root.join(key))?;
        self.wait(bytes.len());
        let mut s = self.stats.lock().unwrap();
        s.gets += 1;
        s.get_bytes += bytes.len() as u64;
        Ok(bytes)
    }
    pub fn write_raw(&self, key: &str, bytes: &[u8]) -> Result<()> {
        let path = self.root.join(key);
        fs::create_dir_all(path.parent().unwrap())?;
        if path.exists() {
            ensure!(fs::read(&path)? == bytes, "immutable object collision");
            self.stats.lock().unwrap().reused += 1;
            return Ok(());
        }
        if let Some(left) = self.fail_writes.lock().unwrap().as_mut() {
            ensure!(*left > 0, "injected object write failure");
            *left -= 1;
        }
        self.wait(bytes.len());
        let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        file.write_all(bytes)?;
        file.as_file().sync_all()?;
        match file.persist_noclobber(&path) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                ensure!(fs::read(&path)? == bytes, "concurrent object collision")
            }
            Err(e) => return Err(e.error.into()),
        }
        fs::File::open(path.parent().unwrap())?.sync_all()?;
        let mut s = self.stats.lock().unwrap();
        s.puts += 1;
        s.put_bytes += bytes.len() as u64;
        Ok(())
    }
    fn address(edge: &Value) -> Result<String> {
        Ok(format!(
            "nodes/{}-{}-{}",
            edge.at(3)?.field("height")?.number()?,
            basin::footer(edge)?.field("version")?.number()?,
            basin::hex(basin::footer(edge)?.field("entropy")?.blob()?)
        ))
    }
}
impl Storage for DiskObjects {
    fn put(&mut self, pending: &PendingEdge, bytes: &[u8], _: &[Edge]) -> Result<String> {
        let dir = Self::address(pending.as_value())?;
        let path = self.root.join(&dir).join("edge");
        if !path.exists() {
            self.write_raw(&format!("{dir}/body"), bytes)?;
            let edge = pending.allocated(&uuid::Uuid::new_v4().to_string())?;
            let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
            file.write_all(&value::encode(&edge)?)?;
            file.as_file().sync_all()?;
            match file.persist_noclobber(&path) {
                Ok(_) => {}
                Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.error.into()),
            }
            fs::File::open(path.parent().unwrap())?.sync_all()?;
        } else {
            self.stats.lock().unwrap().reused += 1;
        }
        ensure!(
            fs::metadata(self.root.join(&dir).join("body"))?.len() == bytes.len() as u64,
            "allocation length changed"
        );
        let bytes = fs::read(path)?;
        let edge = value::read(flexbuffers::Reader::get_root(bytes.as_slice())?)?;
        ensure!(
            basin::footer(&edge)?.field("sha384")?
                == basin::footer(pending.as_value())?.field("sha384")?,
            "allocation content changed"
        );
        Ok(basin::footer(&edge)?.field("revision")?.text()?.into())
    }
    fn get(&mut self, edge: &Edge) -> Result<Vec<u8>> {
        let dir = Self::address(edge)?;
        let stored = fs::read(self.root.join(&dir).join("edge"))?;
        let allocation = value::read(flexbuffers::Reader::get_root(stored.as_slice())?)?;
        ensure!(
            basin::capability(&allocation)? == basin::capability(edge)?,
            "allocation revision mismatch"
        );
        self.read_raw(&format!("{dir}/body"))
    }
}
