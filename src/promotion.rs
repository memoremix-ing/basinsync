//! Postorder marking and restartable, revision-scoped promotion.
use crate::{heap, lexidecimal::Viewpoint};
use anyhow::{Context, Result, ensure};
use num_bigint::BigUint;
use std::{collections::BTreeSet, num::NonZeroUsize};
use tracing::Instrument;
use turso_core::{Connection, Value};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    pub flow: String,
    pub revision: uuid::Uuid,
    pub viewpoint: String,
    pub upstream: BigUint,
}
pub(crate) fn upstream_key(upstream: &BigUint) -> String {
    crate::lexidecimal::encode(&num_bigint::BigInt::from(upstream.clone()))
}
#[derive(Clone, Debug)]
pub struct Node {
    pub id: String,
    pub revision: String,
    pub etag: String,
    pub length: u64,
}
#[derive(Clone, Debug, Default)]
pub struct Command {
    pub tasks: Vec<Task>,
    pub marked: Vec<Node>,
    pub promoted: Vec<Node>,
    pub signed: Vec<ConfirmedSign>,
    pub at: String,
}
pub struct Work {
    pub marking: Command,
    pub promote: Vec<Node>,
    pub ready: Vec<Task>,
}
#[derive(Clone, Debug)]
pub struct ConfirmedSign {
    task: Task,
}
impl ConfirmedSign {
    pub(crate) fn task(&self) -> &Task {
        &self.task
    }
    #[cfg(test)]
    pub(crate) fn simulated(task: Task) -> Self {
        Self { task }
    }
}
/// Roots are completion certificates because promotion, like marking, is postorder.
fn promotion_ready(conn: &std::sync::Arc<Connection>, task: &Task) -> Result<bool> {
    let owner = heap::marker_retainer(&task.flow, &Viewpoint::parse(&task.viewpoint)?);
    let mut q=conn.prepare("SELECT 1 FROM userspace_edges e LEFT JOIN userspace_nodes n ON n.id=e.node WHERE e.retainer=?1 AND (n.id IS NULL OR n.promoted='') LIMIT 1")?;
    q.bind_at(NonZeroUsize::new(1).unwrap(), Value::build_text(owner))?;
    let mut pending = false;
    q.run_with_row_callback(|_| {
        pending = true;
        Ok(())
    })?;
    Ok(!pending)
}
pub async fn confirm_signs(
    bucket: &s3::Bucket,
    tasks: Vec<Task>,
    concurrency: usize,
) -> Vec<ConfirmedSign> {
    let mut pending = tasks.into_iter();
    let mut running = tokio::task::JoinSet::new();
    let mut confirmed = Vec::new();
    loop {
        while running.len() < concurrency.max(1) {
            let Some(task) = pending.next() else {
                break;
            };
            let bucket = bucket.clone();
            running.spawn(
                async move {
                    let result = async {
                        let key = crate::epilogue::flow_promotion_key(
                            &task.flow,
                            &task.revision,
                            &Viewpoint::parse(&task.viewpoint)?,
                        )?;
                        crate::epilogue::confirm_promotion_sign(&bucket, &key, &task.upstream).await
                    }
                    .await;
                    match result {
                        Ok(()) => Some(ConfirmedSign { task }),
                        Err(error) => {
                            tracing::warn!(%error,"PromotionSign deferred");
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
        if let Ok(Some(sign)) = result {
            confirmed.push(sign);
        }
    }
    confirmed
}
fn node(conn: &std::sync::Arc<Connection>, id: &str) -> Result<Option<(Node, bool)>> {
    let mut q = conn.prepare(
        "SELECT revision,etag,content_length,marked FROM userspace_nodes WHERE id=?1 AND freed=''",
    )?;
    q.bind_at(
        NonZeroUsize::new(1).unwrap(),
        Value::build_text(id.to_owned()),
    )?;
    let mut result = None;
    q.run_with_row_callback(|r| {
        result = Some((
            Node {
                id: id.into(),
                revision: r.get(0)?,
                etag: r.get(1)?,
                length: r.get::<i64>(2)? as u64,
            },
            !r.get::<String>(3)?.is_empty(),
        ));
        Ok(())
    })?;
    Ok(result)
}
fn children(conn: &std::sync::Arc<Connection>, owner: &str) -> Result<Vec<String>> {
    let mut q = conn.prepare("SELECT node FROM userspace_edges WHERE retainer=?1 ORDER BY node")?;
    q.bind_at(
        NonZeroUsize::new(1).unwrap(),
        Value::build_text(owner.to_owned()),
    )?;
    let mut result = Vec::new();
    q.run_with_row_callback(|r| {
        result.push(r.get(0)?);
        Ok(())
    })?;
    Ok(result)
}
/// The immutable snapshot allows DFS outside the writer; only its bounded postorder is submitted.
pub fn scan(
    snapshot: &crate::timeline::Snapshot,
    task_limit: usize,
    node_limit: usize,
) -> Result<Work> {
    ensure!(
        (1..=4096).contains(&task_limit) && (1..=4096).contains(&node_limit),
        "invalid marking limits"
    );
    let conn = snapshot.view.connect()?;
    conn.execute("BEGIN")?;
    let mut command = Command {
        at: crate::cleanup::now()?,
        ..Default::default()
    };
    let mut rows = Vec::new();
    conn.prepare(format!("SELECT flow,viewpoint,upstream FROM marking_tasks ORDER BY prioritized,flow,viewpoint LIMIT {task_limit}"))?.run_with_row_callback(|r|{rows.push((r.get::<String>(0)?,r.get::<String>(1)?,r.get::<String>(2)?));Ok(())})?;
    for (flow, viewpoint, encoded) in rows {
        let upstream = crate::lexidecimal::decode(&encoded)?
            .to_biguint()
            .context("invalid marking upstream")?;
        ensure!(upstream > 0u8.into(), "marking upstream must be positive");
        command.tasks.push(Task {
            revision: crate::turso::flow_revision(&conn, &flow)?
                .context("missing Flow revision")?,
            flow,
            viewpoint,
            upstream,
        });
    }
    let mut planned = BTreeSet::new();
    'tasks: for task in &command.tasks {
        let owner = heap::marker_retainer(&task.flow, &Viewpoint::parse(&task.viewpoint)?);
        let mut stack: Vec<(String, bool)> = children(&conn, &owner)?
            .into_iter()
            .rev()
            .map(|id| (id, false))
            .collect();
        while let Some((id, expanded)) = stack.pop() {
            if planned.contains(&id) {
                continue;
            }
            let (row, marked) =
                node(&conn, &id)?.context("retained node missing during marking")?;
            if marked {
                continue;
            }
            if expanded {
                planned.insert(id);
                command.marked.push(row);
                if command.marked.len() == node_limit {
                    break 'tasks;
                }
            } else {
                let nested = children(&conn, &id)?;
                stack.push((id, true));
                stack.extend(nested.into_iter().rev().map(|id| (id, false)));
            }
        }
    }
    let mut promote = Vec::new();
    conn.prepare(format!("SELECT id,revision,etag,content_length FROM userspace_nodes WHERE promoted='' AND marked>'' AND freed='' AND NOT EXISTS(SELECT 1 FROM userspace_edges e LEFT JOIN userspace_nodes c ON c.id=e.node WHERE e.retainer=userspace_nodes.id AND (c.id IS NULL OR c.promoted='')) ORDER BY promoted,marked,id LIMIT {node_limit}"))?.run_with_row_callback(|r|{promote.push(Node{id:r.get(0)?,revision:r.get(1)?,etag:r.get(2)?,length:r.get::<i64>(3)? as u64});Ok(())})?;
    let mut ready = Vec::new();
    for task in &command.tasks {
        if promotion_ready(&conn, task)? {
            ready.push(task.clone());
        }
    }
    conn.execute("COMMIT")?;
    Ok(Work {
        marking: command,
        promote,
        ready,
    })
}
/// Presence is the whole check: the ETag confirmed at allocation already proves
/// the upload, so a copy's length and ETag may differ from the original.
async fn old_exists(bucket: &s3::Bucket, node: &Node) -> Result<bool> {
    let (_, status) = crate::object_read::if_present(bucket)?
        .head_object(heap::key(heap::OLD, &node.id, &node.revision))
        .await?;
    match status {
        200 => Ok(true),
        404 | 412 => Ok(false),
        _ => anyhow::bail!("old heap HEAD returned HTTP {status}"),
    }
}
async fn source_context(
    bucket: &s3::Bucket,
    node: &Node,
) -> Result<std::collections::BTreeMap<String, String>> {
    let mut reader = bucket.clone();
    reader.add_header("if-match", &node.etag);
    let (head, status) = reader
        .head_object(heap::key(heap::YOUNG, &node.id, &node.revision))
        .await?;
    ensure!(status == 200, "young heap object changed or missing");
    let context = head
        .metadata
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(name, value)| {
            name.to_ascii_lowercase()
                .strip_prefix("ctx-")
                .map(|key| (key.to_owned(), value))
        })
        .collect();
    crate::details::context_headers(&context)?
        .iter()
        .map(|(name, value)| Ok((name.to_string(), value.to_str()?.to_owned())))
        .collect::<Result<_>>()
}

#[tracing::instrument(skip_all, name = "s3.copy")]
pub(crate) async fn conditional_copy(
    bucket: &s3::Bucket,
    source: &str,
    destination: &str,
    etag: &str,
    context: &std::collections::BTreeMap<String, String>,
) -> Result<u16> {
    let timer = crate::observability::Timer::new("copy", "heap");
    let result = async {
        let mut headers = std::collections::BTreeMap::from([
            ("If-None-Match".into(), "*".into()),
            (
                "x-amz-copy-source".into(),
                format!("{}/{}", bucket.name(), source),
            ),
            ("x-amz-copy-source-if-match".into(), etag.into()),
            ("x-amz-metadata-directive".into(), "REPLACE".into()),
            ("x-amz-meta-basinsync-source-etag".into(), etag.into()),
        ]);
        headers.extend(context.clone());
        let access = crate::range_get::signed_request(bucket, destination, "PUT", headers).await?;
        let mut request = bucket.http_client().put(&access.url).body(Vec::new());
        for (name, value) in access.headers {
            request = request.header(name, value);
        }
        if let Some(timeout) = bucket.request_timeout {
            request = request.timeout(timeout);
        }
        let response = request.send().await.map_err(|error| error.without_url())?;
        let status = response.status().as_u16();
        // COPY may embed an error in HTTP 200; the verified HEAD is authoritative.
        response
            .bytes()
            .await
            .map_err(|error| error.without_url())?;
        metrics::counter!("basinsync_s3_copy_total", "status"=>status.to_string()).increment(1);
        Ok::<_, anyhow::Error>(status)
    }
    .await;
    timer.finish(
        result
            .as_ref()
            .is_ok_and(|status| (200..300).contains(status)),
    );
    result
}
pub async fn promote_one(bucket: &s3::Bucket, node: &Node) -> Result<()> {
    ensure!(!node.etag.is_empty(), "marked node has no verified ETag");
    if !old_exists(bucket, node).await? {
        let context = source_context(bucket, node).await?;
        let source = heap::key(heap::YOUNG, &node.id, &node.revision);
        let destination = heap::key(heap::OLD, &node.id, &node.revision);
        if let Err(e) = conditional_copy(bucket, &source, &destination, &node.etag, &context).await
        {
            tracing::debug!(%e,"heap copy completion uncertain");
        }
        ensure!(
            old_exists(bucket, node).await?,
            "heap promotion has no verified destination"
        );
    }
    let response = bucket
        .delete_object(heap::key(heap::YOUNG, &node.id, &node.revision))
        .await?;
    ensure!(
        matches!(response.status_code(), 200..=299 | 404),
        "young heap DELETE failed"
    );
    Ok(())
}
pub async fn promote(bucket: &s3::Bucket, nodes: Vec<Node>, concurrency: usize) -> Vec<Node> {
    let mut pending = nodes.into_iter();
    let mut running = tokio::task::JoinSet::new();
    let mut completed = Vec::new();
    loop {
        while running.len() < concurrency.max(1) {
            let Some(node) = pending.next() else {
                break;
            };
            let bucket = bucket.clone();
            running.spawn(
                async move {
                    match crate::observability::measured(
                        "promotion",
                        "userspace",
                        promote_one(&bucket, &node),
                    )
                    .await
                    {
                        Ok(()) => Some(node),
                        Err(error) => {
                            tracing::warn!(%error,"heap promotion deferred");
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
        if let Ok(Some(node)) = result {
            completed.push(node);
        }
    }
    completed
}
