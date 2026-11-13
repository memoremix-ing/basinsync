use super::cleanup::{execute, strings};
use super::*;
use crate::{heap, promotion::Command};

pub(super) fn retain_markers(
    native: &Native,
    commands: &[crate::event::FlowCommand],
    upstream: &str,
) -> Result<()> {
    let conn = &native.conn;
    for command in commands {
        for (flow, marker) in &command.markers {
            let viewpoint = marker.validate()?;
            let owner = heap::marker_retainer(flow, &viewpoint);
            for id in &marker.edges {
                let proof = marker
                    .verified
                    .get(id)
                    .ok_or_else(|| anyhow::anyhow!("unverified marker edge"))?;
                let mut q = conn.prepare(
                    "SELECT revision,content_length,etag,freed FROM graph_nodes WHERE id=?1",
                )?;
                q.bind_at(NonZeroUsize::new(1).unwrap(), Value::build_text(id.clone()))?;
                let mut valid = false;
                q.run_with_row_callback(|r| {
                    valid = r.get::<String>(0)? == proof.revision
                        && r.get::<i64>(1)? as u64 == proof.length
                        && {
                            let e = r.get::<String>(2)?;
                            e.is_empty() || e == proof.etag
                        }
                        && r.get::<String>(3)?.is_empty()
                        && !proof.etag.is_empty();
                    Ok(())
                })?;
                ensure!(valid, "marker child changed before transaction");
                execute(
                    conn,
                    "UPDATE graph_nodes SET etag=?2 WHERE id=?1 AND revision=?3",
                    &[id, &proof.etag, &proof.revision],
                )?;
                execute(
                    conn,
                    "INSERT INTO graph_edges(node,retainer) VALUES(?1,?2) ON CONFLICT(node,retainer) DO NOTHING",
                    &[id, &owner],
                )?;
            }
            execute(
                conn,
                "INSERT INTO marking_tasks(flow,viewpoint,upstream) VALUES(?1,?2,?3) ON CONFLICT(flow,viewpoint) DO NOTHING",
                &[flow, &viewpoint.decimal(), upstream],
            )?;
        }
    }
    Ok(())
}
impl State {
    pub(crate) fn marking_task(&self, task: &crate::promotion::Task) -> Result<bool> {
        Ok(!strings(
            &self.native.conn,
            "SELECT viewpoint FROM marking_tasks WHERE flow=?1 AND viewpoint=?2 AND upstream=?3",
            &[
                &task.flow,
                &task.viewpoint,
                &crate::promotion::upstream_key(&task.upstream),
            ],
        )?
        .is_empty())
    }
    pub(crate) fn promotion_pending(&self, command: &Command) -> Result<bool> {
        ensure!(
            command.tasks.len() <= 4096
                && command.marked.len() <= 4096
                && command.promoted.len() <= 4096
                && command.signed.len() <= 4096,
            "promotion batch too large"
        );
        ensure!(
            [
                !command.marked.is_empty(),
                !command.promoted.is_empty(),
                !command.signed.is_empty()
            ]
            .into_iter()
            .filter(|phase| *phase)
            .count()
                <= 1,
            "mixed promotion phase"
        );
        time::OffsetDateTime::parse(&command.at, &time::format_description::well_known::Rfc3339)?;
        if !command.marked.is_empty() {
            for task in &command.tasks {
                if self.marking_task(task)? {
                    return Ok(true);
                }
            }
        }
        for sign in &command.signed {
            if self.marking_task(sign.task())? {
                return Ok(true);
            }
        }
        for node in &command.promoted {
            if !strings(&self.native.conn,"SELECT id FROM graph_nodes WHERE id=?1 AND revision=?2 AND etag=?3 AND marked>'' AND promoted='' AND freed=''",&[&node.id,&node.revision,&node.etag])?.is_empty(){return Ok(true);}
        }
        Ok(false)
    }
    pub(crate) fn transact_promotion(&self, milestone: &str, command: &Command) -> Result<()> {
        let conn = &self.native.conn;
        conn.set_portable_logical_changes_enabled(true);
        conn.execute("BEGIN CONCURRENT")?;
        // Revalidate postorder against current state; stale snapshots cannot mark a changed revision.
        for node in &command.marked {
            execute(
                conn,
                "UPDATE graph_nodes SET marked=?3 WHERE id=?1 AND revision=?2 AND freed='' AND marked='' AND etag<>'' AND NOT EXISTS(SELECT 1 FROM graph_edges e LEFT JOIN graph_nodes c ON c.id=e.node WHERE e.retainer=?1 AND (c.id IS NULL OR c.marked=''))",
                &[&node.id, &node.revision, &command.at],
            )?;
        }
        for sign in &command.signed {
            let task = sign.task();
            let owner = heap::marker_retainer(&task.flow, &Viewpoint::parse(&task.viewpoint)?);
            execute(
                conn,
                "DELETE FROM marking_tasks WHERE flow=?1 AND viewpoint=?2 AND upstream=?4 AND NOT EXISTS(SELECT 1 FROM graph_edges e LEFT JOIN graph_nodes n ON n.id=e.node WHERE e.retainer=?3 AND (n.id IS NULL OR n.promoted=''))",
                &[
                    &task.flow,
                    &task.viewpoint,
                    &owner,
                    &crate::promotion::upstream_key(&task.upstream),
                ],
            )?;
        }
        for node in &command.promoted {
            execute(
                conn,
                "UPDATE graph_nodes SET promoted=?3 WHERE id=?1 AND revision=?2 AND marked>'' AND promoted='' AND freed='' AND etag=?4 AND NOT EXISTS(SELECT 1 FROM graph_edges e LEFT JOIN graph_nodes c ON c.id=e.node WHERE e.retainer=?1 AND (c.id IS NULL OR c.promoted=''))",
                &[&node.id, &node.revision, &command.at, &node.etag],
            )?;
        }
        execute(
            conn,
            "UPDATE watershed SET milestone=?1 WHERE id=1",
            &[milestone],
        )?;
        conn.execute("COMMIT")?;
        Ok(())
    }
}
