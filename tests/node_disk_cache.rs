#[path = "support/volume_store.rs"]
mod objects;
use anyhow::Result;
use basinsync::{
    structures::{
        Value,
        basin::{self, Basin, Storage},
        trie::{self, Plain},
    },
    turso::volume::cache::DiskCache,
};
use std::{
    fs,
    time::{Duration, SystemTime},
};

#[test]
fn verified_disk_hits_refresh_use_time_and_survive_reopen_and_eviction() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let origin = objects::DiskObjects::new(directory.path())?;
    let mut writer = Basin::new(origin.clone(), vec![42; 32])?;
    let mut roots = vec![];
    for i in 0..3 {
        roots.push(trie::build(
            &mut writer,
            vec![(vec![0], Value::Blob(vec![i; 32]))],
            &Plain,
        )?);
    }
    let size = basin::footer(&roots[0])?.field("length")?.number()? as u64;
    for root in &roots {
        assert_eq!(basin::footer(root)?.field("length")?.number()? as u64, size);
    }
    let path = directory.path().join("cache");
    let mut cache = DiskCache::new(origin.clone(), &path, size * 2)?;
    cache.get(&roots[0])?;
    cache.get(&roots[1])?;
    // Distinguish an old cache population from a subsequent verified use without
    // relying on timer precision, sleeps, or the cache's private filename scheme.
    let oldest = origin.clone().get(&roots[0])?;
    for entry in fs::read_dir(&path)? {
        let path = entry?.path();
        let seconds = if fs::read(&path)? == oldest { 10 } else { 20 };
        fs::File::open(path)?
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))?;
    }
    origin.reset();
    cache.get(&roots[0])?;
    assert_eq!(origin.stats().gets, 0);
    drop(cache);
    let mut cache = DiskCache::new(origin.clone(), &path, size * 2)?;
    cache.get(&roots[2])?;
    let reads = origin.stats().gets;
    cache.get(&roots[0])?;
    assert_eq!(
        origin.stats().gets,
        reads,
        "frequently read node was evicted"
    );
    cache.get(&roots[1])?;
    assert_eq!(origin.stats().gets, reads + 1, "cold node was not evicted");
    let total = fs::read_dir(&path)?
        .map(|e| Ok(e?.metadata()?.len()))
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .sum::<u64>();
    assert!(total <= size * 2);
    Ok(())
}
