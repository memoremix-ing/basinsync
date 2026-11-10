use anyhow::Result;
use basinsync::{
    event::{self, Marker},
    timeline::Basin,
};
use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
};

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args
        .get(1)
        .is_some_and(|arg| arg == "--inspect" || arg == "--locate")
    {
        let state = basinsync::turso::State::from_image(std::fs::read(
            args.get(2)
                .ok_or_else(|| anyhow::anyhow!("missing database path"))?,
        )?)?;
        if args[1] == "--locate" {
            let flow = args
                .get(3)
                .ok_or_else(|| anyhow::anyhow!("missing Flow id"))?;
            let viewpoint = basinsync::lexidecimal::Viewpoint::parse(
                args.get(4)
                    .ok_or_else(|| anyhow::anyhow!("missing Viewpoint"))?,
            )?;
            let row = state
                .location(flow, &viewpoint)?
                .ok_or_else(|| anyhow::anyhow!("missing marker location"))?;
            serde_json::to_writer(
                io::stdout(),
                &serde_json::json!({"upstream":basinsync::lexidecimal::encode(&num_bigint::BigInt::from(row.upstream)),"downstream":viewpoint.lexidecimal(),"offset":row.offset,"length":row.length,"sha384":row.sha384}),
            )?;
            return Ok(());
        }
        let flows: BTreeMap<_, _> = state
            .flows()?
            .into_iter()
            .map(|(flow, vp)| (flow, vp.decimal()))
            .collect();
        serde_json::to_writer(
            io::stdout(),
            &serde_json::json!({"milestone":state.milestone()?,"flows":flows}),
        )?;
        return Ok(());
    }
    let mut json = String::new();
    io::stdin().read_to_string(&mut json)?;
    let markers: BTreeMap<String, Marker> = serde_json::from_str(&json)?;
    let command = if args.get(1).is_some_and(|arg| arg == "--padded") {
        use std::sync::Arc;
        use turso_core::{
            CheckpointMode, ConnectOpts, Database, OpenOptions, SqliteDialect, io::PlatformIO,
        };
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("fixture.turso");
        std::fs::write(&path, basinsync::turso::State::genesis()?.image)?;
        {
            let db = Database::open(
                Arc::new(PlatformIO::new()?),
                path.to_str().unwrap(),
                OpenOptions::new(Arc::new(SqliteDialect)),
            )?;
            let conn = db.connect(ConnectOpts::new())?;
            conn.execute(
                "CREATE TABLE padding (bytes BLOB); INSERT INTO padding VALUES (zeroblob(9437184))",
            )?;
            conn.checkpoint(CheckpointMode::Truncate {
                upper_bound_inclusive: None,
            })?;
        }
        let image = std::fs::read(path)?;
        let state = basinsync::turso::State::from_image(image)?;
        let (_, delta) = state.stage("1", &markers, true)?;
        event::CommitFlow {
            markers,
            deltas: event::Deltas {
                turso: BTreeMap::from([(basinsync::turso::ID.into(), delta)]),
            },
        }
    } else {
        Basin::default().prepare(markers)?.1
    };
    io::stdout().write_all(&event::encode(command)?)?;
    Ok(())
}
