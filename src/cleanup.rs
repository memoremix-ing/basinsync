use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

pub const SWEEP_HEAP: &str = "sts/0/databasin/sweepheap";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub flow: String,
    pub viewpoint: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Freed {
    pub id: String,
    pub revision: String,
    pub freed: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub tasks: Vec<Task>,
    pub erased: Vec<Freed>,
    pub freed_at: String,
    pub edge_limit: usize,
}
impl Command {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (1..=4096).contains(&self.edge_limit),
            "invalid cleanup edge limit"
        );
        ensure!(
            self.tasks.is_empty() != self.erased.is_empty(),
            "expected one cleanup phase"
        );
        ensure!(
            self.tasks.len() <= 4096 && self.erased.len() <= 4096,
            "cleanup batch too large"
        );
        time::OffsetDateTime::parse(
            &self.freed_at,
            &time::format_description::well_known::Rfc3339,
        )?;
        let mut ids = std::collections::BTreeSet::new();
        for task in &self.tasks {
            crate::event::valid_flow(&task.flow)?;
            crate::lexidecimal::Viewpoint::parse(&task.viewpoint)?;
            ensure!(
                ids.insert((&task.flow, &task.viewpoint)),
                "duplicate sweeping task"
            );
        }
        let mut ids = std::collections::BTreeSet::new();
        for node in &self.erased {
            crate::heap::Node {
                id: node.id.clone(),
                length: 0,
            }
            .validate()?;
            crate::heap::valid_revision(&node.revision)?;
            time::OffsetDateTime::parse(
                &node.freed,
                &time::format_description::well_known::Rfc3339,
            )?;
            ensure!(ids.insert(&node.id), "duplicate erased node");
        }
        Ok(())
    }
}
#[derive(Default)]
pub struct Work {
    pub tasks: Vec<Task>,
    pub freed: Vec<Freed>,
}
pub fn scan(snapshot: &crate::timeline::Snapshot, tasks: usize, nodes: usize) -> Result<Work> {
    ensure!(
        (1..=4096).contains(&tasks) && (1..=4096).contains(&nodes),
        "invalid cleanup batch limits"
    );
    let conn = snapshot.view.connect()?;
    conn.execute("BEGIN")?;
    let mut work = Work::default();
    conn.prepare(format!("SELECT flow,viewpoint FROM sweeping_tasks ORDER BY prioritized,flow,viewpoint LIMIT {tasks}"))?
        .run_with_row_callback(|row| {
            work.tasks.push(Task { flow: row.get(0)?, viewpoint: row.get(1)? }); Ok(())
        })?;
    conn.prepare(format!(
        "SELECT id,revision,freed FROM graph_nodes WHERE freed>'' AND NOT EXISTS(SELECT 1 FROM graph_edges WHERE node=graph_nodes.id) ORDER BY freed,id LIMIT {nodes}"
    ))?
    .run_with_row_callback(|row| {
        work.freed.push(Freed {
            id: row.get(0)?,
            revision: row.get(1)?,
            freed: row.get(2)?,
        });
        Ok(())
    })?;
    conn.execute("COMMIT")?;
    Ok(work)
}
pub fn now() -> Result<String> {
    Ok(time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339)?)
}
pub async fn erase(bucket: &s3::Bucket, nodes: Vec<Freed>, concurrency: usize) -> Vec<Freed> {
    let mut pending = nodes.into_iter();
    let mut running = tokio::task::JoinSet::new();
    let mut erased = Vec::new();
    loop {
        while running.len() < concurrency.max(1) {
            let Some(node) = pending.next() else {
                break;
            };
            let bucket = bucket.clone();
            running.spawn(async move {
                let key = crate::heap::key(crate::heap::YOUNG, &node.id, &node.revision);
                match bucket.delete_object(key).await {
                    Ok(r) if matches!(r.status_code(), 200..=299 | 404) => Some(node),
                    Ok(r) => {
                        tracing::warn!(status = r.status_code(), "young heap deletion deferred");
                        None
                    }
                    Err(error) => {
                        tracing::warn!(%error, "young heap deletion deferred");
                        None
                    }
                }
            });
        }
        let Some(result) = running.join_next().await else {
            break;
        };
        if let Ok(Some(node)) = result {
            erased.push(node);
        }
    }
    erased
}
