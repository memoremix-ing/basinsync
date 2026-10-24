//! A coalescing background consumer: replicate Flow markers before backing up a Basin.
use crate::{diffuse16, epilogue, event, lexidecimal::Viewpoint, timeline::Snapshot, turso};
use anyhow::{Context, Result, ensure};
use num_bigint::BigUint;
use s3::Bucket;
use std::time::Duration;
use tokio::sync::watch;

/// Publish only after every marker through this immutable, durable snapshot is stored.
pub async fn publish(bucket: &Bucket, snapshot: &Snapshot) -> Result<()> {
    let previous = epilogue::latest_checkpoint(bucket).await?;
    let mut milestone = previous
        .as_ref()
        .map_or_else(|| 0u8.into(), |cp| cp.milestone.clone());
    if milestone >= *snapshot.prefix.milestone() {
        return Ok(());
    }
    let mut parent = previous.as_ref().map(|cp| cp.digest.clone());
    while milestone < *snapshot.prefix.milestone() {
        let next = &milestone + 1u8;
        let response = bucket.get_object(diffuse16::key(&next)?).await?;
        ensure!(
            response.status_code() == 200,
            "replication Timeline GET returned HTTP {}",
            response.status_code()
        );
        let bytes = response.as_slice();
        let commands = match event::decode_entry(bytes)? {
            event::Entry::Legacy(command) => vec![event::FlowCommand {
                markers: command.markers,
            }],
            event::Entry::Wal { commands, delta } => {
                delta.validate_version()?;
                delta
                    .physical
                    .validate_binding(&milestone, parent.as_deref())?;
                commands
            }
        };
        let mut flows = std::collections::BTreeMap::<String, Vec<event::Marker>>::new();
        for command in commands {
            for (flow, marker) in command.markers {
                flows.entry(flow).or_default().push(marker);
            }
        }
        let mut copies = tokio::task::JoinSet::new();
        for (flow, markers) in flows {
            if copies.len() == 8 {
                let copy = copies.join_next().await.context("missing Flow copy")?;
                copy??;
            }
            let bucket = bucket.clone();
            copies.spawn(async move {
                for marker in markers {
                    epilogue::replicate(&bucket, &flow, &marker).await?;
                }
                Ok::<_, anyhow::Error>(())
            });
        }
        while let Some(copy) = copies.join_next().await {
            copy??;
        }
        milestone = next;
        parent = Some(event::digest(bytes));
    }
    ensure!(
        parent.as_deref() == snapshot.prefix.digest(),
        "backup prefix disagrees with Timeline"
    );
    let view = snapshot.view.clone();
    let (file, sha384) = tokio::task::spawn_blocking(move || view.export())
        .await
        .context("snapshot export panicked")??;
    // A competing backup may have advanced while Flow copies or export were running.
    let latest = epilogue::latest_checkpoint(bucket).await?;
    if latest.as_ref().is_some_and(|cp| cp.milestone >= milestone) {
        return Ok(());
    }
    let checkpoint = epilogue::Checkpoint {
        viewpoint: latest
            .as_ref()
            .map_or_else(Viewpoint::zero, |cp| cp.viewpoint.next()),
        milestone,
        digest: parent.context("missing backup event digest")?,
        sha384,
        version: turso::VERSION.into(),
    };
    let mut reader = tokio::fs::File::open(file.path()).await?;
    bucket
        .put_object_stream_builder(checkpoint.viewpoint.key()?)
        .with_headers(checkpoint.headers()?)
        .with_max_concurrent_chunks(1)
        .execute_stream(&mut reader)
        .await?;
    tracing::info!(viewpoint=%checkpoint.viewpoint.decimal(), milestone=%checkpoint.milestone, "Basin backup published");
    Ok(())
}

/// One active snapshot and one replaceable pending target; errors never gate client acks.
pub async fn run(
    bucket: Box<Bucket>,
    mut targets: watch::Receiver<Option<Snapshot>>,
    interval: Duration,
) {
    let mut completed: BigUint = 0u8.into();
    loop {
        tokio::time::sleep(interval).await;
        let target = targets.borrow_and_update().clone();
        if let Some(snapshot) = target.filter(|s| s.prefix.milestone() > &completed) {
            match publish(&bucket, &snapshot).await {
                Ok(()) => completed = snapshot.prefix.milestone().clone(),
                Err(error) => tracing::warn!(%error, "Basin backup will retry"),
            }
        }
        // Drop retained generations once the pipeline closes. A crash recovers from S3.
        if targets.has_changed().is_err() {
            return;
        }
    }
}
