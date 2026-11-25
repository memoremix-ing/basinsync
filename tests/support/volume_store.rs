//! Immutable disk object store for VFS experiments, with explicit transport costs.
use anyhow::{Result, ensure};
use basinsync::structures::{
    Value,
    basin::{self, Edge, PendingEdge, PreparedObject, Storage},
    value,
};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
fn sync(file: &fs::File) -> std::io::Result<()> {
    let _profile = basinsync::structures::profile::span("storage.sync");
    file.sync_all()
}
#[derive(Default, Clone, Debug, serde::Serialize)]
pub struct Stats {
    pub gets: u64,
    pub get_bytes: u64,
    pub puts: u64,
    pub put_bytes: u64,
    pub reused: u64,
    pub max_in_flight: u64,
}
#[derive(Clone)]
pub struct DiskObjects {
    pub root: PathBuf,
    pub stats: Arc<Mutex<Stats>>,
    pub delay: Duration,
    pub bytes_per_second: u64,
    pub concurrency: usize,
    pub request_limit: usize,
    bandwidth: Arc<Mutex<Instant>>,
    active: Arc<(Mutex<u64>, Condvar)>,
    pub fail_reads: Arc<Mutex<bool>>,
    pub fail_writes: Arc<Mutex<Option<usize>>>,
    pub read_keys: Arc<Mutex<std::collections::BTreeSet<String>>>,
    pub forbidden: Arc<Mutex<std::collections::BTreeSet<String>>>,
}
struct Transfer<'a>(&'a DiskObjects);
impl Drop for Transfer<'_> {
    fn drop(&mut self) {
        let (lock, ready) = &*self.0.active;
        *lock.lock().unwrap() -= 1;
        ready.notify_one();
    }
}
impl DiskObjects {
    pub fn new(root: &Path) -> Result<Self> {
        fs::create_dir_all(root)?;
        Ok(Self {
            root: root.into(),
            stats: Default::default(),
            delay: Duration::ZERO,
            bytes_per_second: 0,
            concurrency: 1,
            request_limit: 2,
            bandwidth: Arc::new(Mutex::new(Instant::now())),
            active: Arc::new((Mutex::new(0), Condvar::new())),
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
    fn transfer(&self) -> Transfer<'_> {
        let (lock, ready) = &*self.active;
        let mut active = lock.lock().unwrap();
        while *active >= self.request_limit.max(1) as u64 {
            active = ready.wait(active).unwrap();
        }
        *active += 1;
        let mut stats = self.stats.lock().unwrap();
        stats.max_in_flight = stats.max_in_flight.max(*active);
        Transfer(self)
    }
    fn wait(&self, size: usize) {
        let _profile = basinsync::structures::profile::span("storage.wait");
        if !self.delay.is_zero() {
            std::thread::sleep(self.delay);
        }
        if self.bytes_per_second > 0 {
            // All clones share one link. Concurrency can overlap latency, never
            // multiply the configured aggregate transfer bandwidth.
            let end = {
                let mut next = self.bandwidth.lock().unwrap();
                *next = (*next).max(Instant::now())
                    + Duration::from_secs_f64(size as f64 / self.bytes_per_second as f64);
                *next
            };
            std::thread::sleep(end.saturating_duration_since(Instant::now()));
        }
    }
    pub fn read_raw(&self, key: &str) -> Result<Vec<u8>> {
        let _profile = basinsync::structures::profile::span("storage.body_read");
        ensure!(
            !*self.fail_reads.lock().unwrap(),
            "injected object read failure"
        );
        ensure!(
            !self.forbidden.lock().unwrap().contains(key),
            "unrequested object read"
        );
        self.read_keys.lock().unwrap().insert(key.into());
        let _transfer = self.transfer();
        let bytes = fs::read(self.root.join(key))?;
        self.wait(bytes.len());
        let mut s = self.stats.lock().unwrap();
        s.gets += 1;
        s.get_bytes += bytes.len() as u64;
        Ok(bytes)
    }
    pub fn write_raw(&self, key: &str, bytes: &[u8]) -> Result<()> {
        let _profile = basinsync::structures::profile::span("storage.body_write");
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
        let _transfer = self.transfer();
        self.wait(bytes.len());
        let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        file.write_all(bytes)?;
        sync(file.as_file())?;
        match file.persist_noclobber(&path) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                ensure!(fs::read(&path)? == bytes, "concurrent object collision")
            }
            Err(e) => return Err(e.error.into()),
        }
        sync(&fs::File::open(path.parent().unwrap())?)?;
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
    fn put_many(&mut self, objects: &[PreparedObject]) -> Result<Vec<String>> {
        if self.concurrency <= 1 || objects.len() <= 1 {
            return objects
                .iter()
                .map(|o| self.put(&o.pending, &o.bytes, &o.edges))
                .collect();
        }
        let next = std::sync::atomic::AtomicUsize::new(0);
        let results = Mutex::new((0..objects.len()).map(|_| None).collect::<Vec<_>>());
        std::thread::scope(|scope| {
            for _ in 0..self.concurrency.min(objects.len()) {
                let next = &next;
                let results = &results;
                let mut store = self.clone();
                scope.spawn(move || {
                    loop {
                        let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some(o) = objects.get(i) else {
                            break;
                        };
                        let result = store.put(&o.pending, &o.bytes, &o.edges);
                        results.lock().unwrap()[i] = Some(result);
                    }
                });
            }
        });
        // scope joins every worker even if a sibling failed. No parent can be
        // published until all these results have been acknowledged.
        results
            .into_inner()
            .unwrap()
            .into_iter()
            .map(|r| r.unwrap())
            .collect()
    }
    fn put(&mut self, pending: &PendingEdge, bytes: &[u8], _: &[Edge]) -> Result<String> {
        let _profile = basinsync::structures::profile::span("storage.put");
        let dir = Self::address(pending.as_value())?;
        let path = self.root.join(&dir).join("edge");
        if !path.exists() {
            self.write_raw(&format!("{dir}/body"), bytes)?;
            let edge = pending.allocated(&uuid::Uuid::new_v4().to_string())?;
            let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
            file.write_all(&value::encode(&edge)?)?;
            sync(file.as_file())?;
            match file.persist_noclobber(&path) {
                Ok(_) => {}
                Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.error.into()),
            }
            sync(&fs::File::open(path.parent().unwrap())?)?;
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
        let _profile = basinsync::structures::profile::span("storage.get");
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
