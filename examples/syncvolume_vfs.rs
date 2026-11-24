//! Real Turso, identical SQL and disk COW; only backup layout and loading vary.
#[path = "../tests/support/volume_store.rs"]
mod objects;
use anyhow::{Context, Result, ensure};
use basinsync::{
    structures::basin::Basin,
    turso::{
        self,
        volume::{DatabaseFile, LoadMode, SyncVolume, checkpoint},
    },
};
use objects::{DiskObjects, Stats};
use serde::Serialize;
use std::time::{Duration, Instant};
#[derive(Serialize)]
struct Phase {
    ms: f64,
    io: Stats,
}
fn measure<T>(store: &DiskObjects, f: impl FnOnce() -> Result<T>) -> Result<(T, Phase)> {
    store.reset();
    let t = Instant::now();
    let result = f()?;
    Ok((
        result,
        Phase {
            ms: t.elapsed().as_secs_f64() * 1000.,
            io: store.stats(),
        },
    ))
}
fn scalar(db: &DatabaseFile, sql: &str) -> Result<i64> {
    let mut result = 0;
    db.connection().prepare(sql)?.run_with_row_callback(|r| {
        result = r.get(0)?;
        Ok(())
    })?;
    Ok(result)
}
#[derive(Serialize)]
struct Sample {
    mode: String,
    round: usize,
    rows: usize,
    inline_pages: usize,
    latency_ms: u64,
    mib_per_sec: u64,
    database_bytes: u64,
    kernel_bytes: u64,
    initial_backup_bytes: u64,
    load_primary: Phase,
    first_query: Phase,
    load_kernel: Phase,
    warm_queries: Phase,
    local_commit: Phase,
    backup: Phase,
}
fn sample(
    mode: &str,
    round: usize,
    rows: usize,
    inline_pages: usize,
    latency_ms: u64,
    mib_per_sec: u64,
) -> Result<Sample> {
    let directory = tempfile::tempdir()?;
    let mut store = DiskObjects::new(directory.path())?;
    let mut primary = DatabaseFile::create(turso::SCHEMA)?;
    primary
        .connection()
        .execute("CREATE TABLE payload(id INTEGER PRIMARY KEY,body BLOB)")?;
    primary.connection().execute("BEGIN CONCURRENT")?;
    for id in 0..rows {
        primary
            .connection()
            .execute(format!("INSERT INTO payload VALUES({id},zeroblob(12000))"))?;
    }
    primary.connection().execute("COMMIT")?;
    let mut kernel = DatabaseFile::create(basinsync::kernel::SCHEMA)?;
    let original = primary.snapshot()?;
    let companion = kernel.snapshot()?;
    let image = original.image()?;
    let kernel_image = companion.image()?;
    drop(primary);
    drop(kernel);
    let root = if mode == "flat" {
        store.write_raw("initial/default.turso", &image)?;
        store.write_raw("initial/kernel.turso", &kernel_image)?;
        None
    } else {
        Some(checkpoint(
            &mut Basin::new(store.clone(), vec![42; 32])?,
            None,
            vec![
                ("/default.turso".into(), original.clone()),
                ("/kernel.turso".into(), companion.clone()),
            ],
            inline_pages,
        )?)
    };
    let initial_backup_bytes = store.stats().put_bytes;
    store.delay = Duration::from_millis(latency_ms);
    store.bytes_per_second = mib_per_sec * 1024 * 1024;
    let mounted = root.as_ref().map(|r| {
        SyncVolume::new(
            Basin::new(store.clone(), vec![42; 32]).unwrap(),
            r.clone(),
            mode.parse::<LoadMode>().unwrap(),
        )
    });
    let (mut primary, load_primary) = measure(&store, || match &mounted {
        Some(v) => v.open("/default.turso"),
        None => DatabaseFile::from_image(&store.read_raw("initial/default.turso")?),
    })?;
    let (_, first_query) = measure(&store, || {
        ensure!(
            scalar(
                &primary,
                &format!("SELECT length(body) FROM payload WHERE id={}", rows - 1)
            )? == 12000,
            "point query mismatch"
        );
        Ok(())
    })?;
    let (mut kernel, load_kernel) = measure(&store, || match &mounted {
        Some(v) => v.open("/kernel.turso"),
        None => DatabaseFile::from_image(&store.read_raw("initial/kernel.turso")?),
    })?;
    // This explicit complete-file materialization is outside the warm/backup timings.
    ensure!(
        primary.snapshot()?.image()? == image && kernel.snapshot()?.image()? == kernel_image,
        "restored image mismatch"
    );
    let (_, warm_queries) = measure(&store, || {
        for n in 0..64 {
            ensure!(
                scalar(
                    &primary,
                    &format!(
                        "SELECT length(body) FROM payload WHERE id={}",
                        (n * 7919) % rows
                    )
                )? == 12000,
                "warm query mismatch"
            );
        }
        Ok(())
    })?;
    let ((next, next_kernel), local_commit) = measure(&store, || {
        primary.connection().execute(format!(
            "UPDATE payload SET body=x'{}' WHERE id={}",
            "01".repeat(12000),
            rows / 2
        ))?;
        kernel
            .connection()
            .execute("UPDATE kernel_state SET activity='1' WHERE id=1")?;
        Ok((primary.snapshot()?, kernel.snapshot()?))
    })?;
    let (new_root, backup) = measure(&store, || {
        if let Some(root) = &root {
            Ok(Some(checkpoint(
                &mut Basin::new(store.clone(), vec![42; 32])?,
                Some(root),
                vec![
                    ("/default.turso".into(), next.clone()),
                    ("/kernel.turso".into(), next_kernel.clone()),
                ],
                inline_pages,
            )?))
        } else {
            for (name, view) in [("default.turso", &next), ("kernel.turso", &next_kernel)] {
                let (file, _digest) = view.export()?;
                store.write_raw(&format!("next/{name}"), &std::fs::read(file.path())?)?;
            }
            Ok(None)
        }
    })?;
    store.delay = Duration::ZERO;
    store.bytes_per_second = 0;
    // Both old and new bytes are independently checked after publication.
    ensure!(
        original.image()? == image && companion.image()? == kernel_image,
        "backup altered an old generation"
    );
    if let Some(root) = new_root {
        let mount = SyncVolume::new(
            Basin::new(store.clone(), vec![42; 32])?,
            root,
            LoadMode::LazyPages,
        );
        let mut p = mount.open("/default.turso")?;
        let mut k = mount.open("/kernel.turso")?;
        ensure!(
            p.snapshot()?.image()? == next.image()?
                && k.snapshot()?.image()? == next_kernel.image()?,
            "incremental backup mismatch"
        );
    } else {
        ensure!(
            store.read_raw("next/default.turso")? == next.image()?
                && store.read_raw("next/kernel.turso")? == next_kernel.image()?,
            "flat backup mismatch"
        );
    }
    Ok(Sample {
        mode: mode.into(),
        round,
        rows,
        inline_pages,
        latency_ms,
        mib_per_sec,
        database_bytes: image.len() as u64,
        kernel_bytes: kernel_image.len() as u64,
        initial_backup_bytes,
        load_primary,
        first_query,
        load_kernel,
        warm_queries,
        local_commit,
        backup,
    })
}
fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    ensure!(
        args.len().is_multiple_of(2),
        "expected --name value options"
    );
    let mut options = std::collections::BTreeMap::new();
    for p in args.chunks_exact(2) {
        ensure!(
            [
                "--rows",
                "--rounds",
                "--latency-ms",
                "--mib-per-sec",
                "--inline-pages",
                "--mode"
            ]
            .contains(&p[0].as_str()),
            "unknown option"
        );
        options.insert(p[0].as_str(), p[1].as_str());
    }
    let number = |name, default| -> Result<usize> {
        Ok(options.get(name).map_or(Ok(default), |s| s.parse())?)
    };
    let rows = number("--rows", 256)?;
    let rounds = number("--rounds", 3)?;
    let inline = number("--inline-pages", 1)?;
    ensure!(rows > 0 && rounds > 0, "positive rows/rounds required");
    let latency = number("--latency-ms", 0)? as u64;
    let bandwidth = number("--mib-per-sec", 0)? as u64;
    let mode = options.get("--mode").copied().unwrap_or("all");
    ensure!(
        ["all", "flat", "lazy", "eager"].contains(&mode),
        "invalid mode"
    );
    let mut samples = vec![];
    for round in 0..rounds {
        let mut modes = if mode == "all" {
            vec!["flat", "lazy", "eager"]
        } else {
            vec![mode]
        };
        if round % 2 == 1 {
            modes.reverse();
        }
        for mode in modes {
            let s = sample(mode, round, rows, inline, latency, bandwidth)
                .context(format!("{mode} round {round}"))?;
            eprintln!(
                "{mode} round {round}: open {:.1} ms, backup {:.1} ms / {} bytes",
                s.load_primary.ms, s.backup.ms, s.backup.io.put_bytes
            );
            samples.push(s);
        }
    }
    println!("{}", serde_json::to_string_pretty(&samples)?);
    Ok(())
}
