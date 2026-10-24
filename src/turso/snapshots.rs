use super::*;

#[path = "views_benchmark.rs"]
mod benchmark;
pub(super) use crate::turso::cow;
use cow::Store;

pub(super) fn cursor(conn: &Arc<Connection>) -> Result<String> {
    let mut query = conn.prepare("SELECT milestone FROM basin WHERE id=1")?;
    ensure!(matches!(query.step()?, StepResult::Row), "missing cursor");
    let value = query.row().unwrap().get::<String>(0)?;
    ensure!(
        matches!(query.step()?, StepResult::Done),
        "duplicate cursor"
    );
    Ok(value)
}

#[test]
fn rolling_read_transactions_keep_old_rows_and_probe_checkpoints() -> Result<()> {
    for passive in [false, true] {
        let dir = Directory::new()?;
        let path = dir.path("primary.turso");
        fs::write(&path, seed(8, false)?)?;
        let db = Database::open(
            Arc::new(PlatformIO::new()?),
            &path,
            OpenOptions::new(Arc::new(SqliteDialect)).db_opts(
                turso_core::DatabaseOpts::new().with_experimental_mvcc_passive_checkpoint(passive),
            ),
        )?;
        let writer = db.connect(ConnectOpts::new())?;
        writer.pragma_update("mvcc_checkpoint_threshold", -1)?;
        let before = db.connect(ConnectOpts::new())?;
        before.execute("BEGIN CONCURRENT")?;
        assert_eq!(cursor(&before)?, "1");
        writer.execute("UPDATE basin SET milestone='2' WHERE id=1")?;
        assert_eq!(cursor(&before)?, "1");
        assert_eq!(cursor(&writer)?, "2");
        let mode = if passive {
            CheckpointMode::Passive {
                upper_bound_inclusive: None,
            }
        } else {
            CheckpointMode::Truncate {
                upper_bound_inclusive: None,
            }
        };
        let result = writer.checkpoint(mode);
        println!("rolling reader passive={passive}: {result:?}");
        if passive {
            result?;
            assert_eq!(cursor(&before)?, "1");
            assert_eq!(cursor(&writer)?, "2");
        } else {
            assert!(matches!(result, Err(turso_core::LimboError::Busy)));
        }
        before.execute("ROLLBACK")?;
        writer.checkpoint(CheckpointMode::Truncate {
            upper_bound_inclusive: None,
        })?;
    }
    Ok(())
}

#[test]
fn cow_views_survive_primary_checkpoints_without_rebuild() -> Result<()> {
    let dir = Directory::new()?;
    let path = dir.path("primary.turso");
    fs::write(&path, seed(8, false)?)?;
    let store = Store::open(&path, &dir.path("history.pages"))?;
    let db = Database::open(store.io(), &path, OpenOptions::new(Arc::new(SqliteDialect)))?;
    let primary = db.connect(ConnectOpts::new())?;
    primary.pragma_update("mvcc_checkpoint_threshold", -1)?;
    primary.execute("CREATE TABLE items(id INTEGER PRIMARY KEY,b BLOB); CREATE INDEX items_b ON items(b); INSERT INTO items VALUES(1,zeroblob(70000)),(2,NULL)")?;
    primary.checkpoint(CheckpointMode::Truncate {
        upper_bound_inclusive: None,
    })?;
    store.seal();
    let before = store.pin()?;
    let reader = before.connect()?;
    assert_eq!(cursor(&reader)?, "1");
    primary.execute("UPDATE basin SET milestone='2' WHERE id=1; UPDATE items SET b=x'ff' WHERE id=1; DELETE FROM items WHERE id=2")?;
    primary.checkpoint(CheckpointMode::Truncate {
        upper_bound_inclusive: None,
    })?;
    store.seal();
    let after = store.pin()?;
    let next = after.connect()?;
    assert_eq!(cursor(&reader)?, "1");
    assert_eq!(cursor(&next)?, "2");
    primary.execute(
        "UPDATE basin SET milestone='3' WHERE id=1; INSERT INTO items VALUES(3,zeroblob(160000))",
    )?;
    primary.checkpoint(CheckpointMode::Truncate {
        upper_bound_inclusive: None,
    })?;
    store.seal();
    assert_eq!(cursor(&reader)?, "1");
    assert_eq!(cursor(&next)?, "2");
    assert_eq!(cursor(&store.pin()?.connect()?)?, "3");
    let lengths = |conn: &Arc<Connection>| -> Result<Vec<(i64, Option<i64>)>> {
        let mut q = conn.prepare("SELECT id,length(b) FROM items ORDER BY id")?;
        let mut result = Vec::new();
        while matches!(q.step()?, StepResult::Row) {
            let r = q.row().unwrap();
            let length = if matches!(r.get::<&Value>(1)?, Value::Null) {
                None
            } else {
                Some(r.get::<i64>(1)?)
            };
            result.push((r.get(0)?, length));
        }
        Ok(result)
    };
    assert_eq!(lengths(&reader)?, vec![(1, Some(70000)), (2, None)]);
    assert_eq!(lengths(&next)?, vec![(1, Some(1))]);
    assert_eq!(
        lengths(&store.pin()?.connect()?)?,
        vec![(1, Some(1)), (3, Some(160000))]
    );
    Ok(())
}

#[test]
fn cow_preserves_partial_writes_growth_truncation_and_reuses_history() -> Result<()> {
    let dir = Directory::new()?;
    let path = dir.path("raw.pages");
    let original = vec![7; PAGE_SIZE * 3];
    fs::write(&path, &original)?;
    let store = Store::open(&path, &dir.path("history"))?;
    let io = store.io();
    let file = io.open_file(&path, OpenFlags::default(), false)?;
    for _ in 0..50 {
        let old = store.pin()?;
        let b = Arc::new(Buffer::new_temporary(PAGE_SIZE + 100));
        b.as_mut_slice().fill(9);
        io.wait_for_completion(file.pwrite(
            (PAGE_SIZE - 50) as u64,
            b,
            Completion::new_write(|_| {}),
        )?)?;
        io.wait_for_completion(file.truncate(10, Completion::new_write(|_| {}))?)?;
        store.seal();
        let bytes = old.image()?;
        assert_eq!(bytes, original);
        write_file(&*io, &*file, &original)?;
        store.seal();
        drop(old);
        assert_eq!(store.retained().0, 0);
    }
    assert!(store.retained().1 <= PAGE_SIZE as u64 * 6);
    Ok(())
}
