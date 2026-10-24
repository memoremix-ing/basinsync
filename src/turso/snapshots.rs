use super::*;
use std::os::unix::fs::FileExt;

#[path = "views_benchmark.rs"]
mod benchmark;
#[path = "cow.rs"]
pub(super) mod cow;

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
