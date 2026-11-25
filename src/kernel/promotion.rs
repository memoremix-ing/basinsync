//! Bounded promotion of the shallow Basin backup graphs.
use super::*;
use std::{collections::BTreeSet, sync::Arc};
use tracing::Instrument;

#[derive(Clone, Debug)]
pub struct Task {
    commit: Commit,
    blob: Vec<u8>,
    upstream: BigUint,
    index: roots::Index,
}
#[derive(Clone, Debug)]
pub struct Proof {
    node: Node,
    etag: String,
}
#[derive(Clone)]
pub struct ConfirmedSign {
    task: Task,
}
#[derive(Clone)]
pub enum Change {
    Mark {
        task: Task,
        nodes: Vec<Proof>,
        at: String,
    },
    Promoted {
        task: Task,
        nodes: Vec<Proof>,
        at: String,
    },
    Signed(ConfirmedSign),
}
#[derive(Clone, Copy)]
pub struct Limits {
    pub tasks: usize,
    pub nodes: usize,
    pub concurrency: usize,
}
struct Candidate {
    proof: Proof,
    marked: bool,
    promoted: bool,
}
struct Work {
    task: Task,
    nodes: Vec<Candidate>,
}
fn valid_task(conn: &Arc<Connection>, task: &Task) -> Result<()> {
    let mut pending = false;
    turso::rows(
        conn,
        &format!(
            "SELECT 1 FROM marking_tasks WHERE flow='basin' AND viewpoint={} AND upstream={}",
            q(&task.index.viewpoint.lexidecimal()),
            q(&crate::promotion::upstream_key(&task.upstream))
        ),
        |_| {
            pending = true;
            Ok(())
        },
    )?;
    ensure!(
        pending && roots::Index::get(conn, &task.index.viewpoint)? == Some(task.index.clone()),
        "stale KernelSpace marking task"
    );
    ensure!(
        task.index.graph(&task.blob)? == task.commit.graph,
        "kernel promotion graph changed"
    );
    Ok(())
}

fn candidate(conn: &Arc<Connection>, task: &Task, node: &Node) -> Result<Candidate> {
    let owner = retainer("m", &Viewpoint::parse(&task.commit.viewpoint)?);
    let mut found = None;
    turso::rows(
        conn,
        &format!(
            "SELECT revision,content_length,sha384,etag,marked,promoted FROM kernelspace_nodes n WHERE id={} AND freed='' AND EXISTS(SELECT 1 FROM kernelspace_edges WHERE node=n.id AND retainer={}) AND NOT EXISTS(SELECT 1 FROM kernelspace_edges WHERE retainer=n.id)",
            q(&node.id),
            q(&owner)
        ),
        |r| {
            ensure!(
                r.get::<String>(0)? == node.revision
                    && r.get::<i64>(1)? == i64::try_from(node.length)?
                    && r.get::<String>(2)? == node.sha384,
                "kernel promotion descriptor changed"
            );
            let etag = r.get::<String>(3)?;
            ensure!(!etag.is_empty(), "kernel node has no verified ETag");
            found = Some(Candidate {
                proof: Proof {
                    node: node.clone(),
                    etag,
                },
                marked: !r.get::<String>(4)?.is_empty(),
                promoted: !r.get::<String>(5)?.is_empty(),
            });
            Ok(())
        },
    )?;
    found.context("missing retained kernel promotion node")
}
fn pending(view: &Arc<turso::cow::View>, limits: Limits) -> Result<Vec<roots::Index>> {
    ensure!(
        (1..=4096).contains(&limits.tasks)
            && (1..=4096).contains(&limits.nodes)
            && (1..=4096).contains(&limits.concurrency),
        "invalid KernelSpace promotion limits"
    );
    let conn = view.connect()?;
    let mut tasks = vec![];
    turso::rows(
        &conn,
        &format!(
            "SELECT c.viewpoint,c.upstream,c.covered,c.sha384 FROM marking_tasks t JOIN kernel_commits c ON c.viewpoint=t.viewpoint AND c.upstream=t.upstream WHERE t.flow='basin' ORDER BY t.prioritized,t.flow,t.viewpoint LIMIT {}",
            limits.tasks
        ),
        |r| {
            tasks.push(roots::Index::from_row(r)?);
            Ok(())
        },
    )?;
    Ok(tasks)
}
fn inspect(view: &Arc<turso::cow::View>, task: Task) -> Result<Work> {
    let conn = view.connect()?;
    valid_task(&conn, &task)?;
    let nodes = task
        .commit
        .graph
        .databases
        .values()
        .map(|n| candidate(&conn, &task, n))
        .collect::<Result<_>>()?;
    Ok(Work { task, nodes })
}
pub(crate) fn apply(conn: &Arc<Connection>, change: &Change) -> Result<()> {
    let task = match change {
        Change::Mark { task, .. } | Change::Promoted { task, .. } => task,
        Change::Signed(sign) => &sign.task,
    };
    valid_task(conn, task)?;
    match change {
        Change::Mark { nodes, at, .. } | Change::Promoted { nodes, at, .. } => {
            ensure!(
                !nodes.is_empty() && nodes.len() <= 4096,
                "invalid kernel promotion batch"
            );
            time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339)?;
            let promoted = matches!(change, Change::Promoted { .. });
            for proof in nodes {
                ensure!(
                    task.commit
                        .graph
                        .databases
                        .values()
                        .any(|n| n == &proof.node),
                    "node outside kernel graph"
                );
                let current = candidate(conn, task, &proof.node)?;
                ensure!(
                    current.proof.etag == proof.etag,
                    "kernel promotion ETag changed"
                );
                if promoted {
                    ensure!(current.marked, "unmarked kernel promotion");
                }
                let column = if promoted { "promoted" } else { "marked" };
                conn.execute(format!(
                    "UPDATE kernelspace_nodes SET {column}={} WHERE id={} AND {column}=''",
                    q(at),
                    q(&proof.node.id)
                ))?;
            }
        }
        Change::Signed(_) => {
            for node in task.commit.graph.databases.values() {
                ensure!(
                    candidate(conn, task, node)?.promoted,
                    "kernel graph not completely promoted"
                );
            }
            conn.execute(format!(
                "DELETE FROM marking_tasks WHERE flow='basin' AND viewpoint={} AND upstream={}",
                q(&Viewpoint::parse(&task.commit.viewpoint)?.lexidecimal()),
                q(&crate::promotion::upstream_key(&task.upstream))
            ))?;
        }
    }
    Ok(())
}
async fn old_exists(bucket: &s3::Bucket, proof: &Proof) -> Result<bool> {
    // Presence is enough; restore verifies image lengths and checksums.
    let (_, status) = crate::object_read::if_present(bucket)?
        .head_object(proof.node.key(OLD)?)
        .await?;
    match status {
        200 => Ok(true),
        404 | 412 => Ok(false),
        _ => anyhow::bail!("kernel destination HEAD returned HTTP {status}"),
    }
}
async fn promote_one(bucket: &s3::Bucket, proof: &Proof) -> Result<()> {
    if !old_exists(bucket, proof).await? {
        let mut reader = bucket.clone();
        reader.add_header("if-match", &proof.etag);
        let (_, status) = reader.head_object(proof.node.key(YOUNG)?).await?;
        ensure!(status == 200, "young KernelSpace object changed");
        let metadata = BTreeMap::from([("x-amz-meta-sha384".into(), proof.node.sha384.clone())]);
        if let Err(error) = crate::promotion::conditional_copy(
            bucket,
            &proof.node.key(YOUNG)?,
            &proof.node.key(OLD)?,
            &proof.etag,
            &metadata,
        )
        .await
        {
            tracing::debug!(%error,"kernel COPY completion uncertain");
        }
        ensure!(
            old_exists(bucket, proof).await?,
            "kernel promotion has no verified destination"
        );
    }
    let response = bucket.delete_object(proof.node.key(YOUNG)?).await?;
    ensure!(
        matches!(response.status_code(), 200..=299 | 404),
        "young KernelSpace DELETE failed"
    );
    Ok(())
}
async fn confirm(bucket: &s3::Bucket, task: Task) -> Result<ConfirmedSign> {
    let vp = Viewpoint::parse(&task.commit.viewpoint)?;
    let cp = task.commit.graph.checkpoint(vp.clone(), &task.blob)?;
    let (head, status) = crate::object_read::if_present(bucket)?
        .head_object(vp.key()?)
        .await?;
    ensure!(
        status == 200
            && head.content_length.is_some_and(|n| n >= 16)
            && head.e_tag.as_deref() != Some(crate::sequence::reference(bucket)?.as_str()),
        "kernel marker is not stored"
    );
    let headers = head
        .metadata
        .context("kernel marker metadata missing")?
        .into_iter()
        .map(|(k, v)| (format!("x-amz-meta-{k}"), v))
        .collect();
    cp.verify_headers(&headers)?;
    crate::epilogue::confirm_promotion_sign(
        bucket,
        &crate::epilogue::promotion_key(crate::epilogue::BASIN_PREFIX, &vp)?,
        &task.upstream,
    )
    .await?;
    Ok(ConfirmedSign { task })
}
async fn work(
    bucket: &s3::Bucket,
    targets: &tokio::sync::watch::Receiver<Option<timeline::Snapshot>>,
    limits: Limits,
    cache: &mut roots::Cache,
) -> Result<Vec<Work>> {
    let view = targets
        .borrow()
        .as_ref()
        .and_then(|s| s.kernel_view.clone())
        .context("missing kernel promotion snapshot")?;
    let pinned = view.clone();
    let indices = tokio::task::spawn_blocking(move || pending(&pinned, limits)).await??;
    let mut tasks = vec![];
    for index in indices {
        let (commit, blob) = cache.load(bucket, &index).await?;
        tasks.push(Task {
            commit,
            blob,
            upstream: index.upstream.clone(),
            index,
        });
    }
    tokio::task::spawn_blocking(move || {
        tasks.into_iter().map(|task| inspect(&view, task)).collect()
    })
    .await?
}
/// All object I/O stays outside preparation; each phase is acknowledged through the Timeline.
pub(crate) async fn cycle(
    bucket: &s3::Bucket,
    targets: &tokio::sync::watch::Receiver<Option<timeline::Snapshot>>,
    queue: &tokio::sync::mpsc::Sender<Request>,
    limits: Limits,
    cache: &mut roots::Cache,
) -> Result<()> {
    let mut remaining = limits.nodes;
    let mut seen = BTreeSet::new();
    for row in work(bucket, targets, limits, cache).await? {
        let nodes = row
            .nodes
            .into_iter()
            .filter(|n| !n.marked && seen.insert(n.proof.node.id.clone()))
            .take(remaining)
            .map(|n| n.proof)
            .collect::<Vec<_>>();
        remaining -= nodes.len();
        if !nodes.is_empty() {
            crate::backup::internal(
                queue,
                Operation::Promote(Change::Mark {
                    task: row.task,
                    nodes,
                    at: crate::cleanup::now()?,
                }),
            )
            .await?;
        }
        if remaining == 0 {
            break;
        }
    }
    let view = targets
        .borrow()
        .as_ref()
        .and_then(|s| s.kernel_view.clone())
        .context("missing kernel promotion snapshot")?;
    let eligible=tokio::task::spawn_blocking(move || {
        let conn=view.connect()?;let mut ids=BTreeSet::new();
        turso::rows(&conn,&format!("SELECT id FROM kernelspace_nodes WHERE promoted='' AND marked>'' AND freed='' ORDER BY promoted,marked,id LIMIT {}",limits.nodes),|r| {ids.insert(r.get::<String>(0)?);Ok(())})?;
        Ok::<_,anyhow::Error>(ids)
    }).await??;
    let mut remaining = limits.nodes;
    let mut seen = BTreeSet::new();
    for row in work(bucket, targets, limits, cache).await? {
        let pending = row
            .nodes
            .into_iter()
            .filter(|n| {
                n.marked
                    && !n.promoted
                    && eligible.contains(&n.proof.node.id)
                    && seen.insert(n.proof.node.id.clone())
            })
            .take(remaining)
            .map(|n| n.proof)
            .collect::<Vec<_>>();
        remaining -= pending.len();
        let mut pending = pending.into_iter();
        let mut running = tokio::task::JoinSet::new();
        let mut promoted = vec![];
        loop {
            while running.len() < limits.concurrency {
                let Some(proof) = pending.next() else { break };
                let bucket = bucket.clone();
                running.spawn(
                    async move {
                        match promote_one(&bucket, &proof).await {
                            Ok(()) => Some(proof),
                            Err(error) => {
                                tracing::warn!(%error,"KernelSpace promotion deferred");
                                None
                            }
                        }
                    }
                    .in_current_span(),
                );
            }
            let Some(result) = running.join_next().await else {
                break;
            };
            if let Some(proof) = result.context("kernel promotion task panicked")? {
                promoted.push(proof);
            }
        }
        // Failed attempts also consume the cycle's node budget.
        if !promoted.is_empty() {
            crate::backup::internal(
                queue,
                Operation::Promote(Change::Promoted {
                    task: row.task,
                    nodes: promoted,
                    at: crate::cleanup::now()?,
                }),
            )
            .await?;
        }
        if remaining == 0 {
            break;
        }
    }
    for row in work(bucket, targets, limits, cache).await? {
        if row.nodes.iter().all(|n| n.promoted) {
            match confirm(bucket, row.task).await {
                Ok(sign) => {
                    crate::backup::internal(queue, Operation::Promote(Change::Signed(sign)))
                        .await?;
                }
                Err(error) => tracing::warn!(%error,"KernelSpace PromotionSign deferred"),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event;
    fn limits() -> Limits {
        Limits {
            tasks: 1,
            nodes: 1,
            concurrency: 1,
        }
    }
    fn scan(view: &Arc<turso::cow::View>, limits: Limits, task: &Task) -> Result<Vec<Work>> {
        pending(view, limits)?
            .into_iter()
            .map(|index| {
                ensure!(index == task.index, "unexpected root index");
                inspect(view, task.clone())
            })
            .collect()
    }
    fn initial() -> Result<(timeline::Stager, Vec<timeline::Prepared>, Task)> {
        let mut stager = timeline::Basin::default().into_stager();
        let first = stager.prepare(vec![event::FlowCommand {
            markers: BTreeMap::from([(
                "kernel-test".into(),
                event::Marker {
                    viewpoint: "0".into(),
                    context: Default::default(),
                    edges: Default::default(),
                    verified: Default::default(),
                    blob: vec![],
                    sha384: event::digest(&[]),
                },
            )]),
        }])?;
        let snapshot = first.snapshot().unwrap();
        let graph = Graph::new(
            &snapshot.prefix,
            BTreeMap::from([
                (
                    turso::ID.into(),
                    Node::new(
                        snapshot.view.image()?.len() as u64,
                        event::digest(&snapshot.view.image()?),
                    ),
                ),
                (
                    ID.into(),
                    Node::new(
                        snapshot.kernel_view.as_ref().unwrap().image()?.len() as u64,
                        event::digest(&snapshot.kernel_view.as_ref().unwrap().image()?),
                    ),
                ),
            ]),
        )?;
        let (reserved, vp) = stager.prepare_kernel(Operation::Reserve(graph.clone()))?;
        let command = Commit::new(vp.decimal(), graph)?;
        let etags = command
            .graph
            .databases
            .values()
            .map(|n| (n.id.clone(), "verified".into()))
            .collect();
        let index = roots::Index::from_command(&command, &(stager.prefix().milestone() + 1u8))?;
        let task = Task {
            blob: command.blob.clone(),
            commit: command.clone(),
            upstream: index.upstream.clone(),
            index,
        };
        let (committed, _) = stager.prepare_kernel(Operation::Commit { command, etags })?;
        valid_task(
            &committed
                .snapshot()
                .unwrap()
                .kernel_view
                .unwrap()
                .connect()?,
            &task,
        )?;
        Ok((stager, vec![first, reserved, committed], task))
    }
    #[test]
    fn task_identity_is_bound_to_index_and_source_checksum() -> Result<()> {
        let (_, events, mut task) = initial()?;
        let state = turso::State::from_image(
            events
                .last()
                .unwrap()
                .snapshot()
                .unwrap()
                .kernel_view
                .unwrap()
                .image()?,
        )?;
        let conn = state.connection();
        valid_task(conn, &task)?;
        task.blob.insert(0, 0);
        assert!(valid_task(conn, &task).is_err());
        task.blob.remove(0);
        conn.execute("UPDATE kernel_commits SET covered='0zg2'")?;
        assert!(valid_task(conn, &task).is_err());
        Ok(())
    }
    #[test]
    fn bounded_phases_recheck_proofs_and_replay_both_databases() -> Result<()> {
        let (mut stager, mut events, task) = initial()?;
        let initial_activity = events.last().unwrap().snapshot().unwrap().activity;
        let signed = Change::Signed(ConfirmedSign { task: task.clone() });
        let prefix = stager.prefix();
        assert!(
            stager
                .prepare_kernel(Operation::Promote(signed.clone()))
                .is_err()
        );
        assert_eq!(stager.prefix(), prefix);
        let row = scan(
            &events
                .last()
                .unwrap()
                .snapshot()
                .unwrap()
                .kernel_view
                .unwrap(),
            limits(),
            &task,
        )?
        .remove(0);
        let proofs: Vec<_> = row.nodes.into_iter().map(|n| n.proof).collect();
        let at = crate::cleanup::now()?;
        assert!(
            stager
                .prepare_kernel(Operation::Promote(Change::Promoted {
                    task: task.clone(),
                    nodes: vec![proofs[0].clone()],
                    at: at.clone()
                }))
                .is_err()
        );
        let mut stale = proofs[0].clone();
        stale.etag = "changed".into();
        assert!(
            stager
                .prepare_kernel(Operation::Promote(Change::Mark {
                    task: task.clone(),
                    nodes: vec![stale],
                    at: at.clone()
                }))
                .is_err()
        );
        for proof in &proofs {
            events.push(
                stager
                    .prepare_kernel(Operation::Promote(Change::Mark {
                        task: task.clone(),
                        nodes: vec![proof.clone()],
                        at: at.clone(),
                    }))?
                    .0,
            );
        }
        let marked = scan(
            &events
                .last()
                .unwrap()
                .snapshot()
                .unwrap()
                .kernel_view
                .unwrap(),
            limits(),
            &task,
        )?
        .remove(0);
        assert!(marked.nodes.iter().all(|n| n.marked && !n.promoted));
        for (i, proof) in proofs.into_iter().enumerate() {
            events.push(
                stager
                    .prepare_kernel(Operation::Promote(Change::Promoted {
                        task: task.clone(),
                        nodes: vec![proof],
                        at: at.clone(),
                    }))?
                    .0,
            );
            if i == 0 {
                assert!(
                    stager
                        .prepare_kernel(Operation::Promote(signed.clone()))
                        .is_err()
                );
            }
        }
        events.push(stager.prepare_kernel(Operation::Promote(signed.clone()))?.0);
        let last = events.last().unwrap().snapshot().unwrap();
        assert!(scan(&last.kernel_view.clone().unwrap(), limits(), &task)?.is_empty());
        assert_eq!(
            last.activity, initial_activity,
            "promotion bookkeeping must not recursively trigger backups"
        );
        let prefix = stager.prefix();
        assert!(stager.prepare_kernel(Operation::Promote(signed)).is_err());
        assert_eq!(stager.prefix(), prefix);
        let mut replay = timeline::Basin::default();
        for (i, event) in events.iter().enumerate() {
            let event::Entry::Wal {
                delta,
                kernel: Some(kernel),
                ..
            } = event::decode_entry(event.bytes())?
            else {
                panic!()
            };
            for (id, delta) in [(turso::ID, delta), (ID, kernel)] {
                let before = match &delta.logical.base {
                    Some(base) => base.0.clone(),
                    None => {
                        if id == ID {
                            replay.kernel_database.as_ref().unwrap().image.clone()
                        } else {
                            replay.database.as_ref().unwrap().image.clone()
                        }
                    }
                };
                let logical = turso::State::ingest_logical(&before, &delta.logical)?;
                let physical =
                    delta
                        .physical
                        .ingest(&before, &replay.milestone, replay.head.as_deref())?;
                assert_eq!(logical.image, physical, "{id}: promotion frames disagree");
            }
            replay.apply_entry((i as u64 + 1).into(), event.bytes())?;
        }
        assert_eq!(replay.prefix(), stager.prefix());
        assert_eq!(
            replay.kernel_database.as_ref().unwrap().image,
            last.kernel_view.unwrap().image()?
        );
        Ok(())
    }
}
