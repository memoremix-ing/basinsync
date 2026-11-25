#[path = "support/volume_store.rs"]
mod objects;
use anyhow::Result;
use basinsync::{
    structures::{basin::Basin, volume as layout},
    turso::{
        self,
        volume::{DatabaseFile, LoadMode, SyncVolume, checkpoint},
    },
};
use objects::DiskObjects;
use std::sync::Arc;
fn scalar(db: &DatabaseFile, sql: &str) -> Result<i64> {
    let mut result = 0;
    db.connection().prepare(sql)?.run_with_row_callback(|r| {
        result = r.get(0)?;
        Ok(())
    })?;
    Ok(result)
}
fn sample() -> Result<DatabaseFile> {
    let mut db = DatabaseFile::create(turso::SCHEMA)?;
    db.connection()
        .execute("CREATE TABLE payload(id INTEGER PRIMARY KEY, body BLOB)")?;
    db.connection().execute("BEGIN CONCURRENT")?;
    for n in 0..96 {
        db.connection()
            .execute(format!("INSERT INTO payload VALUES({n},zeroblob(12000))"))?;
    }
    db.connection().execute("COMMIT")?;
    db.snapshot()?;
    Ok(db)
}
#[test]
fn lazy_and_eager_files_preserve_turso_snapshots_and_share_unchanged_objects() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let objects = DiskObjects::new(dir.path())?;
    let mut basin = Basin::new(objects.clone(), vec![42; 32])?;
    let mut primary = sample()?;
    let mut kernel = DatabaseFile::create(basinsync::kernel::SCHEMA)?;
    let before = primary.snapshot()?;
    let kernel_before = kernel.snapshot()?;
    let root = checkpoint(
        &mut basin,
        None,
        vec![
            ("/default.turso".into(), before.clone()),
            ("/kernel.turso".into(), kernel_before.clone()),
        ],
        1,
    )?;
    let total = objects.stats().put_bytes;
    for mode in [LoadMode::LazyPages, LoadMode::EagerFile] {
        objects.reset();
        let mount = SyncVolume::new(
            Basin::new(objects.clone(), vec![42; 32])?,
            root.clone(),
            mode,
        );
        assert_eq!(
            objects.stats().gets,
            0,
            "constructing a mount must not fetch it"
        );
        let mut db = mount.open("/default.turso")?;
        let loaded = objects.stats().get_bytes;
        if mode == LoadMode::LazyPages {
            assert!(
                loaded < before.size() / 2,
                "lazy open fetched the complete database"
            );
        }
        // Eager reads/writes and checkpointing remain local even if the backend disappears.
        if mode == LoadMode::EagerFile {
            *objects.fail_reads.lock().unwrap() = true;
            let another = mount.open("/default.turso")?;
            assert_eq!(scalar(&another, "SELECT count(*) FROM payload")?, 96);
        }
        assert_eq!(scalar(&db, "SELECT count(*) FROM payload")?, 96);
        let old = db.snapshot()?;
        db.connection()
            .execute("UPDATE payload SET body=x'01234567' WHERE id=95")?;
        assert_eq!(
            scalar(&db, "SELECT length(body) FROM payload WHERE id=95")?,
            4
        );
        let next = db.snapshot()?;
        if mode == LoadMode::LazyPages {
            *objects.fail_reads.lock().unwrap() = true;
            let branch = DatabaseFile::fork(old.clone())?;
            assert_eq!(
                scalar(&branch, "SELECT length(body) FROM payload WHERE id=95")?,
                12000,
                "rolling back a touched page required another object read"
            );
            *objects.fail_reads.lock().unwrap() = false;
        }
        assert_eq!(
            old.image()?,
            before.image()?,
            "an escaped generation was modified"
        );
        *objects.fail_reads.lock().unwrap() = false;
        objects.reset();
        let changed = checkpoint(
            &mut basin,
            Some(&root),
            vec![("/default.turso".into(), next.clone())],
            1,
        )?;
        assert!(
            objects.stats().put_bytes < total / 4,
            "small edit uploaded a full image"
        );
        let fresh = checkpoint(
            &mut basin,
            None,
            vec![
                ("/default.turso".into(), next.clone()),
                ("/kernel.turso".into(), kernel_before.clone()),
            ],
            1,
        )?;
        assert_eq!(changed, fresh, "path-copying changed canonical packing");
        let reload = SyncVolume::new(
            Basin::new(objects.clone(), vec![42; 32])?,
            changed,
            LoadMode::LazyPages,
        );
        let mut reopened = reload.open("/default.turso")?;
        assert_eq!(
            scalar(&reopened, "SELECT length(body) FROM payload WHERE id=95")?,
            4
        );
        assert_eq!(reopened.snapshot()?.image()?, next.image()?);
        let mut companion = reload.open("/kernel.turso")?;
        assert_eq!(companion.snapshot()?.image()?, kernel_before.image()?);
        let mut branch = DatabaseFile::fork(Arc::clone(&old))?;
        assert_eq!(
            scalar(&branch, "SELECT length(body) FROM payload WHERE id=95")?,
            12000
        );
        assert_eq!(branch.snapshot()?.image()?, before.image()?);
    }
    Ok(())
}
#[test]
fn unopened_nested_databases_remain_unfetched_and_corrupt_pages_are_rejected() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let objects = DiskObjects::new(dir.path())?;
    let mut basin = Basin::new(objects.clone(), vec![42; 32])?;
    let mut db = sample()?;
    let view = db.snapshot()?;
    let cold_path = format!(
        "/{}/kernel.turso",
        (0..40)
            .map(|n| format!("cold{n}"))
            .collect::<Vec<_>>()
            .join("/")
    );
    let mut cold = DatabaseFile::create(basinsync::kernel::SCHEMA)?;
    let cold_view = cold.snapshot()?;
    let root = checkpoint(
        &mut basin,
        None,
        vec![
            ("/default.turso".into(), view.clone()),
            (cold_path.clone(), cold_view.clone()),
        ],
        1,
    )?;
    objects.reset();
    let probe = SyncVolume::new(
        Basin::new(objects.clone(), vec![42; 32])?,
        root.clone(),
        LoadMode::EagerFile,
    );
    probe.open(&cold_path)?;
    let cold_reads = objects.read_keys.lock().unwrap().clone();
    objects.reset();
    let live_probe = SyncVolume::new(
        Basin::new(objects.clone(), vec![42; 32])?,
        root.clone(),
        LoadMode::EagerFile,
    );
    live_probe.open("/default.turso")?;
    let live_reads = objects.read_keys.lock().unwrap().clone();
    let forbidden = cold_reads
        .difference(&live_reads)
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    assert!(!forbidden.is_empty(), "fixture needs distinct cold objects");
    *objects.forbidden.lock().unwrap() = forbidden.clone();
    // The convenience API creates directory paths; source mounts do not enumerate them.
    let mount = SyncVolume::new(
        Basin::new(objects.clone(), vec![42; 32])?,
        root.clone(),
        LoadMode::EagerFile,
    );
    let mut live = mount.open("/default.turso")?;
    assert_eq!(live.snapshot()?.image()?, view.image()?);
    let changed = checkpoint(
        &mut basin,
        Some(&root),
        vec![("/default.turso".into(), live.snapshot()?)],
        1,
    )?;
    assert_eq!(changed, root);
    objects.forbidden.lock().unwrap().clear();
    assert_eq!(
        layout::dense_page_count(&mut basin, &root, &cold_path)?,
        cold_view.size() / turso::PAGE_SIZE as u64
    );
    // Revisions and payload checksums remain verified before any object enters the page cache.
    for key in forbidden {
        let path = objects.root.join(key);
        let mut body = std::fs::read(&path)?;
        body[8] ^= 1;
        std::fs::write(path, body)?;
    }
    let corrupt = SyncVolume::new(
        Basin::new(objects.clone(), vec![42; 32])?,
        root,
        LoadMode::LazyPages,
    );
    assert!(corrupt.open("/default.turso").is_ok());
    assert!(corrupt.open(&cold_path).is_err());
    Ok(())
}

#[test]
fn successive_cold_recoveries_match_a_sql_model_and_keep_prior_roots() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let objects = DiskObjects::new(dir.path())?;
    let mut writer = Basin::new(objects.clone(), vec![17; 32])?;
    let mut db =
        DatabaseFile::create("CREATE TABLE model(id INTEGER PRIMARY KEY, body BLOB NOT NULL)")?;
    let mut model = std::collections::BTreeMap::<u32, Vec<u8>>::new();
    let mut roots = vec![];
    let mut previous = None;
    let mut random = 0x13579bdfu32;
    for generation in 0..8 {
        db.connection().execute("BEGIN CONCURRENT")?;
        for _ in 0..12 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            let id = random % 24;
            if random.is_multiple_of(4) {
                db.connection()
                    .execute(format!("DELETE FROM model WHERE id={id}"))?;
                model.remove(&id);
            } else {
                let bytes = vec![(random >> 24) as u8; (random as usize % 20000) + 1];
                db.connection().execute(format!(
                    "INSERT OR REPLACE INTO model VALUES({id},x'{}')",
                    basinsync::structures::basin::hex(&bytes)
                ))?;
                model.insert(id, bytes);
            }
        }
        db.connection().execute("COMMIT")?;
        let view = db.snapshot()?;
        let image = view.image()?;
        let root = checkpoint(
            &mut writer,
            previous.as_ref(),
            vec![("/default.turso".into(), view)],
            if generation % 2 == 0 { 1 } else { 16 },
        )?;
        let mount = SyncVolume::new(
            Basin::new(objects.clone(), vec![17; 32])?,
            root.clone(),
            if generation % 2 == 0 {
                LoadMode::LazyPages
            } else {
                LoadMode::EagerFile
            },
        );
        db = mount.open("/default.turso")?;
        let mut actual = std::collections::BTreeMap::new();
        db.connection()
            .prepare("SELECT id,body FROM model ORDER BY id")?
            .run_with_row_callback(|r| {
                actual.insert(
                    r.get::<i64>(0)? as u32,
                    r.get::<&turso_core::Value>(1)?.as_blob().to_vec(),
                );
                Ok(())
            })?;
        assert_eq!(
            actual, model,
            "SQL model diverged after generation {generation}"
        );
        assert_eq!(db.snapshot()?.image()?, image);
        roots.push((root.clone(), image));
        previous = Some(root);
    }
    for (root, image) in roots {
        let mut old = SyncVolume::new(
            Basin::new(objects.clone(), vec![17; 32])?,
            root,
            LoadMode::LazyPages,
        )
        .open("/default.turso")?;
        assert_eq!(old.snapshot()?.image()?, image, "an earlier backup changed");
    }
    Ok(())
}

#[test]
fn failed_group_publication_keeps_the_old_root_and_local_rollback_needs_no_network() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let objects = DiskObjects::new(dir.path())?;
    let mut basin = Basin::new(objects.clone(), vec![42; 32])?;
    let mut primary = sample()?;
    let mut kernel = DatabaseFile::create(basinsync::kernel::SCHEMA)?;
    let primary_before = primary.snapshot()?;
    let kernel_before = kernel.snapshot()?;
    let root = checkpoint(
        &mut basin,
        None,
        vec![
            ("/default.turso".into(), primary_before.clone()),
            ("/kernel.turso".into(), kernel_before.clone()),
        ],
        1,
    )?;
    let mount = SyncVolume::new(
        Basin::new(objects.clone(), vec![42; 32])?,
        root.clone(),
        LoadMode::EagerFile,
    );
    let mut primary = mount.open("/default.turso")?;
    let mut kernel = mount.open("/kernel.turso")?;
    let old_primary = primary.snapshot()?;
    let old_kernel = kernel.snapshot()?;
    primary
        .connection()
        .execute("UPDATE payload SET body=x'01' WHERE id=95")?;
    let speculative = primary.snapshot()?;
    assert!(
        kernel
            .connection()
            .execute("INSERT INTO kernel_state VALUES(1,'1','1')")
            .is_err()
    );
    *objects.fail_reads.lock().unwrap() = true;
    let mut restored_primary = DatabaseFile::fork(old_primary)?;
    let mut restored_kernel = DatabaseFile::fork(old_kernel)?;
    assert_eq!(
        restored_primary.snapshot()?.image()?,
        primary_before.image()?
    );
    assert_eq!(restored_kernel.snapshot()?.image()?, kernel_before.image()?);
    *objects.fail_reads.lock().unwrap() = false;
    *objects.fail_writes.lock().unwrap() = Some(1);
    let files = vec![
        ("/default.turso".into(), speculative.clone()),
        ("/kernel.turso".into(), kernel_before.clone()),
    ];
    assert!(checkpoint(&mut basin, Some(&root), files.clone(), 1).is_err());
    *objects.fail_writes.lock().unwrap() = None;
    let mut old = SyncVolume::new(
        Basin::new(objects.clone(), vec![42; 32])?,
        root.clone(),
        LoadMode::EagerFile,
    )
    .open("/default.turso")?;
    assert_eq!(
        old.snapshot()?.image()?,
        primary_before.image()?,
        "failed PUT changed the published group"
    );
    let next = checkpoint(&mut basin, Some(&root), files, 1)?;
    let mut retried = SyncVolume::new(
        Basin::new(objects, vec![42; 32])?,
        next,
        LoadMode::LazyPages,
    )
    .open("/default.turso")?;
    assert_eq!(retried.snapshot()?.image()?, speculative.image()?);
    Ok(())
}

#[test]
fn incremental_backups_recover_canonical_roots_without_scanning_unmodified_files() -> Result<()> {
    use basinsync::structures::volume::Algorithm;
    use basinsync::turso::volume::{Backup, checkpoint_with_algorithm};
    for algorithm in [Algorithm::Sl2, Algorithm::Crc64Nvme] {
        for budget in [1, 16, 1280] {
            let dir = tempfile::tempdir()?;
            let objects = DiskObjects::new(dir.path())?;
            let mut b = Basin::new(objects.clone(), vec![42; 32])?;
            let mut primary = sample()?;
            let mut kernel = DatabaseFile::create(basinsync::kernel::SCHEMA)?;
            let original = primary.snapshot()?;
            let companion = kernel.snapshot()?;
            let initial = Backup::create(
                &mut b,
                vec![
                    ("/default.turso".into(), original.clone()),
                    ("/kernel.turso".into(), companion.clone()),
                ],
                budget,
                algorithm,
            )?;
            let root = initial.root().clone();
            // Exercise recovery provenance rather than a retained original connection.
            let mount = SyncVolume::new(
                Basin::new(objects.clone(), vec![42; 32])?,
                root.clone(),
                LoadMode::LazyPages,
            );
            let mut p = mount.open("/default.turso")?;
            let mut k = mount.open("/kernel.turso")?;
            p.connection()
                .execute("UPDATE payload SET body=x'010203' WHERE id=95")?;
            k.connection()
                .execute("UPDATE kernel_state SET activity='1' WHERE id=1")?;
            let target = p.snapshot()?;
            let target_k = k.snapshot()?;
            // Future writes must not contaminate the older pinned candidate or its dirty set.
            p.connection()
                .execute("UPDATE payload SET body=x'ff' WHERE id=1")?;
            p.snapshot()?;
            let files = vec![
                ("/default.turso".into(), target.clone()),
                ("/kernel.turso".into(), target_k.clone()),
            ];
            let recovered = Backup::from_root(root.clone(), budget, algorithm);
            objects.reset();
            let next = recovered.advance(&mut b, files.clone())?;
            if budget < 1280 {
                assert!(
                    objects.stats().get_bytes < original.size() / 2,
                    "incremental backup read the whole database"
                );
            }
            let fresh = checkpoint_with_algorithm(&mut b, None, files.clone(), budget, algorithm)?;
            assert_eq!(next.root(), &fresh, "{algorithm:?},budget={budget}");
            let reload = SyncVolume::new(
                Basin::new(objects.clone(), vec![42; 32])?,
                fresh,
                LoadMode::LazyPages,
            );
            let mut restored = reload.open("/default.turso")?;
            assert_eq!(restored.snapshot()?.image()?, target.image()?);
            assert_eq!(
                scalar(&restored, "SELECT length(body) FROM payload WHERE id=1")?,
                12000
            );
            objects.reset();
            *objects.fail_reads.lock().unwrap() = true;
            let no_op = next.advance(&mut b, files)?;
            assert_eq!(next.root(), no_op.root());
            assert_eq!(objects.stats().puts, 0);
            *objects.fail_reads.lock().unwrap() = false;
            // Repeating a failed candidate must reuse immutable objects and preserve its basis.
            let later = p.snapshot()?;
            let later_files = vec![("/default.turso".into(), later.clone())];
            *objects.fail_writes.lock().unwrap() = Some(1);
            assert!(next.advance(&mut b, later_files.clone()).is_err());
            *objects.fail_writes.lock().unwrap() = None;
            let retried = next.advance(&mut b, later_files)?;
            let full = checkpoint_with_algorithm(
                &mut b,
                None,
                vec![
                    ("/default.turso".into(), later),
                    ("/kernel.turso".into(), target_k),
                ],
                budget,
                algorithm,
            )?;
            assert_eq!(retried.root(), &full);
            assert_eq!(original.image()?, primary.snapshot()?.image()?);
        }
    }
    Ok(())
}

#[test]
fn verified_read_cache_can_be_reused_by_the_backup_writer() -> Result<()> {
    use basinsync::structures::volume::Algorithm;
    use basinsync::turso::volume::Backup;
    let dir = tempfile::tempdir()?;
    let objects = DiskObjects::new(dir.path())?;
    let mut b = Basin::new(objects.clone(), vec![42; 32])?;
    let mut db = sample()?;
    let backup = Backup::create(
        &mut b,
        vec![("/default.turso".into(), db.snapshot()?)],
        16,
        Algorithm::Crc64Nvme,
    )?;
    let mount = SyncVolume::new(
        Basin::new(objects.clone(), vec![42; 32])?,
        backup.root().clone(),
        LoadMode::EagerFile,
    );
    let mut db = mount.open("/default.turso")?;
    db.connection()
        .execute("UPDATE payload SET body=x'cafe' WHERE id=95")?;
    let view = db.snapshot()?;
    let mut writer = mount.cached_basin();
    objects.reset();
    *objects.fail_reads.lock().unwrap() = true;
    let next = backup.advance(&mut writer, vec![("/default.turso".into(), view.clone())])?;
    // Newly published bodies are also retained without requiring a read-back.
    writer.load(next.root())?;
    assert_eq!(objects.stats().gets, 0);
    *objects.fail_reads.lock().unwrap() = false;
    let mut recovered = SyncVolume::new(
        Basin::new(objects, vec![42; 32])?,
        next.root().clone(),
        LoadMode::LazyPages,
    )
    .open("/default.turso")?;
    assert_eq!(recovered.snapshot()?.image()?, view.image()?);
    Ok(())
}
