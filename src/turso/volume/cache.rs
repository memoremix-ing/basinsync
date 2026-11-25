//! Disposable, bounded disk cache for immutable encoded objects. It is never a
//! durability authority: an interrupted cache write may simply be fetched again.
use crate::structures::{
    basin::{self, Edge, PendingEdge, PreparedObject, Storage, VerifiedObject},
    profile,
};
use anyhow::Result;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

#[derive(Clone)]
pub struct DiskCache<S> {
    pub origin: S,
    directory: PathBuf,
    budget: u64,
    lock: Arc<Mutex<()>>,
    prefetch: usize,
}
impl<S: Storage> DiskCache<S> {
    pub fn new(origin: S, directory: impl AsRef<Path>, budget: u64) -> Result<Self> {
        if budget > 0 {
            fs::create_dir_all(&directory)?;
        }
        let cache = Self {
            origin,
            directory: directory.as_ref().into(),
            budget,
            lock: Arc::new(Mutex::new(())),
            prefetch: 0,
        };
        if budget > 0 {
            let _ = cache.make_room(0);
        }
        Ok(cache)
    }
    pub fn with_prefetch(mut self, slots: usize) -> Self {
        self.prefetch = slots.min(32);
        self
    }
    fn path(&self, edge: &Edge) -> Result<PathBuf> {
        // A known digest alone must not let another capability bypass its
        // origin lookup. Bind cache identity to the revisioned capability too.
        let identity = [
            basin::capability(edge)?.as_bytes(),
            b"/",
            basin::footer(edge)?.field("sha384")?.blob()?,
        ]
        .concat();
        Ok(self.directory.join(basin::hex(&basin::sha384(&identity))))
    }
    fn make_room(&self, needed: u64) -> Result<()> {
        let mut entries = fs::read_dir(&self.directory)?
            .filter_map(|e| {
                let e = e.ok()?;
                let name = e.file_name();
                let name = name.to_str()?;
                if name.len() != 96 || !name.bytes().all(|c| c.is_ascii_hexdigit()) {
                    return None;
                }
                let m = e.metadata().ok()?;
                m.is_file().then(|| (m.modified().ok(), m.len(), e.path()))
            })
            .collect::<Vec<_>>();
        entries.sort();
        let mut total = entries.iter().map(|e| e.1).sum::<u64>();
        for (_, length, victim) in entries {
            if total.saturating_add(needed) <= self.budget {
                break;
            }
            fs::remove_file(victim)?;
            total = total.saturating_sub(length);
        }
        Ok(())
    }
    fn remember(&self, edge: &Edge, bytes: &[u8]) -> Result<()> {
        if bytes.len() as u64 > self.budget {
            return Ok(());
        }
        let _guard = self.lock.lock().unwrap();
        let path = self.path(edge)?;
        if path.exists() {
            let _ = fs::File::open(&path).and_then(|file| file.set_modified(SystemTime::now()));
            return Ok(());
        }
        self.make_room(bytes.len() as u64)?;
        let mut temp = tempfile::NamedTempFile::new_in(&self.directory)?;
        temp.write_all(bytes)?;
        // Atomic rename, deliberately no fsync: cache loss is harmless.
        temp.persist(path).map_err(|e| e.error)?;
        Ok(())
    }
}
impl<S: Storage + Clone + Send> Storage for DiskCache<S> {
    fn prefetch(&mut self, edges: &[Edge]) -> Result<()> {
        if self.budget == 0 || self.prefetch == 0 {
            return Ok(());
        }
        let mut bytes = 0u64;
        let ahead = edges
            .iter()
            .take_while(|edge| {
                let Ok(n) = basin::footer(edge)
                    .and_then(|f| f.field("length"))
                    .and_then(|n| n.number())
                else {
                    return false;
                };
                bytes = bytes.saturating_add(n as u64);
                bytes <= self.budget / 2
            })
            .cloned()
            .collect::<Vec<_>>();
        for chunk in ahead.chunks(self.prefetch) {
            std::thread::scope(|scope| -> Result<()> {
                let jobs = chunk
                    .iter()
                    .map(|edge| {
                        let mut cache = self.clone();
                        scope.spawn(move || cache.get(edge).map(|_| ()))
                    })
                    .collect::<Vec<_>>();
                let results = jobs
                    .into_iter()
                    .map(|job| job.join().expect("cache prefetch worker panicked"))
                    .collect::<Vec<_>>();
                for result in results {
                    result?;
                }
                Ok(())
            })?;
        }
        Ok(())
    }
    fn put(&mut self, pending: &PendingEdge, bytes: &[u8], edges: &[Edge]) -> Result<String> {
        let revision = self.origin.put(pending, bytes, edges)?;
        let edge = pending.allocated(&revision)?;
        let _ = self.remember(&edge, bytes);
        Ok(revision)
    }
    fn put_many(&mut self, objects: &[PreparedObject]) -> Result<Vec<String>> {
        let revisions = self.origin.put_many(objects)?;
        anyhow::ensure!(
            objects.len() == revisions.len(),
            "incomplete object publication"
        );
        for (object, revision) in objects.iter().zip(&revisions) {
            let edge = object.pending.allocated(revision)?;
            let _ = self.remember(&edge, &object.bytes);
        }
        Ok(revisions)
    }
    fn get(&mut self, edge: &Edge) -> Result<Vec<u8>> {
        self.get_verified(edge)?.into_bytes(edge)
    }
    fn get_verified(&mut self, edge: &Edge) -> Result<VerifiedObject> {
        if self.budget == 0 {
            return self.origin.get_verified(edge);
        }
        let _profile = profile::span("cache.disk");
        let path = self.path(edge)?;
        let hit = || -> Result<VerifiedObject> {
            let file = fs::File::open(&path)?;
            let length = file.metadata()?.len();
            anyhow::ensure!(
                length <= self.budget
                    && length == basin::footer(edge)?.field("length")?.number()? as u64,
                "cached object length mismatch"
            );
            let mut bytes = Vec::new();
            (&file).take(length + 1).read_to_end(&mut bytes)?;
            let object = VerifiedObject::new(edge, bytes)?;
            // Persistent approximate LRU. Touch the opened inode, so an eviction
            // and replacement at this path cannot refresh an unrelated file.
            let _ = file.set_modified(SystemTime::now());
            Ok(object)
        };
        if let Ok(object) = hit() {
            return Ok(object);
        }
        let _ = fs::remove_file(&path);
        let object = self.origin.get_verified(edge)?;
        object.validate_for(edge)?;
        let _ = self.remember(edge, object.bytes());
        Ok(object)
    }
    fn resolve(&mut self, link: &crate::structures::Value) -> Result<Option<Edge>> {
        self.origin.resolve(link)
    }
}
