use super::*;
use crate::cleanup::{Command, Task};

pub(super) fn enqueue_sweeping(
    conn: &Arc<Connection>,
    flow: &str,
    viewpoint: &Viewpoint,
) -> Result<()> {
    execute(
        conn,
        "INSERT INTO sweeping_tasks(flow,viewpoint) VALUES(?1,?2) ON CONFLICT(flow,viewpoint) DO NOTHING",
        &[flow, &viewpoint.decimal()],
    )
}
fn execute(conn: &Arc<Connection>, sql: &str, values: &[&str]) -> Result<()> {
    let mut q = conn.prepare(sql)?;
    for (i, value) in values.iter().enumerate() {
        q.bind_at(
            NonZeroUsize::new(i + 1).unwrap(),
            Value::build_text((*value).to_owned()),
        )?;
    }
    q.run_ignore_rows()?;
    Ok(())
}
fn strings(conn: &Arc<Connection>, sql: &str, values: &[&str]) -> Result<Vec<String>> {
    let mut q = conn.prepare(sql)?;
    for (i, value) in values.iter().enumerate() {
        q.bind_at(
            NonZeroUsize::new(i + 1).unwrap(),
            Value::build_text((*value).to_owned()),
        )?;
    }
    let mut out = Vec::new();
    q.run_with_row_callback(|row| {
        out.push(row.get(0)?);
        Ok(())
    })?;
    Ok(out)
}
impl State {
    pub fn sweeping_task(&self, task: &Task) -> Result<bool> {
        Ok(!strings(
            &self.native.conn,
            "SELECT viewpoint FROM sweeping_tasks WHERE flow=?1 AND viewpoint=?2",
            &[&task.flow, &task.viewpoint],
        )?
        .is_empty())
    }
    pub(crate) fn plan_cleanup(&self, mut command: Command) -> Result<Option<Command>> {
        command.validate()?;
        let mut tasks = Vec::new();
        for task in command.tasks {
            if self.sweeping_task(&task)? {
                tasks.push(task);
            }
        }
        command.tasks = tasks;
        let mut erased = Vec::new();
        for node in command.erased {
            if self.heap_node(&node.id)?.is_some_and(|row| {
                row.revision == node.revision && row.freed == node.freed && !row.freed.is_empty()
            }) {
                erased.push(node);
            }
        }
        command.erased = erased;
        Ok((!command.tasks.is_empty() || !command.erased.is_empty()).then_some(command))
    }
    pub(crate) fn transact_cleanup(&self, milestone: &str, command: &Command) -> Result<()> {
        command.validate()?;
        let conn = &self.native.conn;
        conn.set_portable_logical_changes_enabled(true);
        conn.execute("BEGIN CONCURRENT")?;
        let mut budget = command.edge_limit;
        for task in &command.tasks {
            if budget == 0 {
                break;
            }
            if !self.sweeping_task(task)? {
                continue;
            }
            let owner = crate::heap::retainer(&task.flow, &Viewpoint::parse(&task.viewpoint)?);
            let nodes = strings(
                conn,
                &format!(
                    "SELECT node FROM graph_edges WHERE retainer=?1 ORDER BY node LIMIT {budget}"
                ),
                &[&owner],
            )?;
            execute(
                conn,
                "DELETE FROM sweeping_tasks WHERE flow=?1 AND viewpoint=?2",
                &[&task.flow, &task.viewpoint],
            )?;
            budget -= nodes.len();
            for node in nodes {
                execute(
                    conn,
                    "DELETE FROM graph_edges WHERE node=?1 AND retainer=?2",
                    &[&node, &owner],
                )?;
                execute(
                    conn,
                    "UPDATE graph_nodes SET freed=?2 WHERE id=?1 AND freed='' AND NOT EXISTS(SELECT 1 FROM graph_edges WHERE node=?1)",
                    &[&node, &command.freed_at],
                )?;
            }
            if !strings(
                conn,
                "SELECT node FROM graph_edges WHERE retainer=?1 LIMIT 1",
                &[&owner],
            )?
            .is_empty()
            {
                enqueue_sweeping(conn, &task.flow, &Viewpoint::parse(&task.viewpoint)?)?;
            }
        }
        for node in &command.erased {
            execute(
                conn,
                "DELETE FROM graph_nodes WHERE id=?1 AND revision=?2 AND freed=?3 AND freed<>'' AND NOT EXISTS(SELECT 1 FROM graph_edges WHERE node=?1)",
                &[&node.id, &node.revision, &node.freed],
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
    pub(crate) fn verify_cleanup(&self, before: Option<&State>, command: &Command) -> Result<()> {
        command.validate()?;
        let before = before.ok_or_else(|| anyhow::anyhow!("cleanup requires prior state"))?;
        ensure!(
            self.flows()? == before.flows()?,
            "cleanup advanced Flow state"
        );
        for node in &command.erased {
            let old = before
                .heap_node(&node.id)?
                .ok_or_else(|| anyhow::anyhow!("erasure of missing node"))?;
            ensure!(
                old.revision == node.revision && old.freed == node.freed && !old.freed.is_empty(),
                "erasure revision mismatch"
            );
            ensure!(self.heap_node(&node.id)?.is_none(), "erased row survived");
        }
        let mut budget = command.edge_limit;
        let mut affected = std::collections::BTreeSet::new();
        for task in &command.tasks {
            ensure!(before.sweeping_task(task)?, "missing sweeping task");
            if budget == 0 {
                break;
            }
            let owner = crate::heap::retainer(&task.flow, &Viewpoint::parse(&task.viewpoint)?);
            let nodes = strings(
                &before.native.conn,
                &format!(
                    "SELECT node FROM graph_edges WHERE retainer=?1 ORDER BY node LIMIT {budget}"
                ),
                &[&owner],
            )?;
            budget -= nodes.len();
            for node in nodes {
                ensure!(!self.heap_edge(&node, &owner)?, "swept edge survived");
                affected.insert(node);
            }
            let remaining = !strings(
                &self.native.conn,
                "SELECT node FROM graph_edges WHERE retainer=?1 LIMIT 1",
                &[&owner],
            )?
            .is_empty();
            ensure!(
                self.sweeping_task(task)? == remaining,
                "sweeping task disagrees with remaining edges"
            );
        }
        for id in affected {
            let mut expected = before
                .heap_node(&id)?
                .ok_or_else(|| anyhow::anyhow!("swept edge has no node"))?;
            ensure!(expected.freed.is_empty(), "retained node already freed");
            if strings(
                &self.native.conn,
                "SELECT node FROM graph_edges WHERE node=?1 LIMIT 1",
                &[&id],
            )?
            .is_empty()
            {
                expected.freed = command.freed_at.clone();
            }
            ensure!(
                self.heap_node(&id)?.as_ref() == Some(&expected),
                "swept node state mismatch"
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cleanup, event, heap, timeline};

    fn reserve(flow: &str, nodes: &[u8]) -> heap::Request {
        heap::Request {
            flow: flow.into(),
            viewpoint: Viewpoint::zero(),
            nodes: nodes
                .iter()
                .map(|n| {
                    Ok(heap::Node {
                        id: heap::node_id(0, 0, &[*n]),
                        length: 1,
                    })
                })
                .collect(),
        }
    }
    fn commit(flow: &str, viewpoint: &str) -> event::FlowCommand {
        event::FlowCommand {
            markers: BTreeMap::from([(
                flow.into(),
                event::Marker {
                    viewpoint: viewpoint.into(),
                    sha384: event::digest(&[]),
                    blob: vec![],
                },
            )]),
        }
    }
    fn sweep(tasks: Vec<cleanup::Task>, limit: usize) -> cleanup::Command {
        cleanup::Command {
            tasks,
            erased: vec![],
            freed_at: cleanup::now().unwrap(),
            edge_limit: limit,
        }
    }
    fn task(flow: &str, viewpoint: &str) -> cleanup::Task {
        cleanup::Task {
            flow: flow.into(),
            viewpoint: viewpoint.into(),
        }
    }
    fn apply(state: &mut timeline::Watershed, prepared: timeline::Prepared) -> Result<()> {
        let event::Entry::Wal { delta, .. } = event::decode_entry(prepared.bytes())? else {
            unreachable!()
        };
        let base = state
            .database
            .as_ref()
            .map(|s| s.image.clone())
            .or_else(|| delta.logical.base.as_ref().map(|b| b.0.clone()))
            .unwrap();
        let logical = State::ingest_logical(&base, &delta.logical)?;
        state.apply_entry(prepared.milestone().clone(), prepared.bytes())?;
        assert_eq!(state.database.as_ref().unwrap().image, logical.image);
        Ok(())
    }
    #[test]
    fn queued_sweeps_are_bounded_retain_shared_nodes_and_survive_replay() -> Result<()> {
        let mut writer = timeline::Watershed::default().into_stager();
        let mut replay = timeline::Watershed::default();
        let request = reserve("f", &[1, 2, 3]);
        let (prepared, _) = writer.prepare_heap(&request)?;
        apply(&mut replay, prepared.unwrap())?;
        let (prepared, _) = writer.prepare_heap(&reserve("g", &[1]))?;
        apply(&mut replay, prepared.unwrap())?;
        let prepared =
            writer.prepare(vec![commit("f", "0"), commit("f", "1"), commit("g", "0")])?;
        let snapshot = prepared.snapshot().unwrap();
        apply(&mut replay, prepared)?;
        let work = cleanup::scan(&snapshot, 16, 32)?;
        assert_eq!(
            work.tasks.len(),
            3,
            "queue intermediate batched Viewpoints too"
        );
        assert!(work.freed.is_empty());
        apply(
            &mut replay,
            writer
                .prepare_cleanup(sweep(vec![task("f", "0")], 1))?
                .unwrap(),
        )?;
        let db = replay.database.as_ref().unwrap();
        assert!(db.sweeping_task(&task("f", "0"))?);
        let id = &request.nodes[0].as_ref().unwrap().id;
        assert!(
            db.heap_node(id)?.unwrap().freed.is_empty(),
            "another Flow still retains the node"
        );
        let mut last_snapshot = snapshot;
        for _ in 0..4 {
            if let Some(prepared) = writer.prepare_cleanup(sweep(
                vec![task("f", "0"), task("f", "1"), task("g", "0")],
                1,
            ))? {
                last_snapshot = prepared.snapshot().unwrap();
                apply(&mut replay, prepared)?;
            }
        }
        let work = cleanup::scan(&last_snapshot, 16, 32)?;
        assert!(work.tasks.is_empty());
        assert_eq!(work.freed.len(), 3);
        for node in &work.freed {
            assert!(
                !replay
                    .database
                    .as_ref()
                    .unwrap()
                    .heap_node(&node.id)?
                    .unwrap()
                    .freed
                    .is_empty()
            );
        }
        let mut retry = reserve("f", &[1]);
        retry.viewpoint = Viewpoint::parse("2")?;
        let (prepared, outcome) = writer.prepare_heap(&retry)?;
        assert!(prepared.is_none());
        assert_eq!(outcome.errors[&0].code, "node_freed");
        let erased = work.freed.clone();
        let command = cleanup::Command {
            tasks: vec![],
            erased,
            freed_at: cleanup::now()?,
            edge_limit: 1,
        };
        apply(
            &mut replay,
            writer.prepare_cleanup(command.clone())?.unwrap(),
        )?;
        let (prepared, outcome) = writer.prepare_heap(&retry)?;
        apply(&mut replay, prepared.unwrap())?;
        let current = &outcome.results[&0];
        assert_ne!(
            current.revision,
            work.freed.iter().find(|n| n.id == *id).unwrap().revision
        );
        assert!(
            writer.prepare_cleanup(command)?.is_none(),
            "stale acknowledgments cannot remove the new allocation"
        );
        assert!(replay.database.as_ref().unwrap().heap_node(id)?.is_some());
        Ok(())
    }
    #[test]
    fn cleanup_recovery_rejects_false_freeing_timestamp() -> Result<()> {
        let mut writer = timeline::Watershed::default().into_stager();
        let mut replay = timeline::Watershed::default();
        let (prepared, _) = writer.prepare_heap(&reserve("f", &[9]))?;
        apply(&mut replay, prepared.unwrap())?;
        let prepared = writer.prepare(vec![commit("f", "0")])?;
        let old_snapshot = prepared.snapshot().unwrap();
        apply(&mut replay, prepared)?;
        let prepared = writer
            .prepare_cleanup(sweep(vec![task("f", "0")], 1))?
            .unwrap();
        let event::Entry::Wal {
            mut cleanup, delta, ..
        } = event::decode_entry(prepared.bytes())?
        else {
            unreachable!()
        };
        cleanup[0].freed_at = "2000-01-01T00:00:00Z".into();
        let bad = event::FlowChunks::cleanup(&cleanup[0])?.finish(*delta)?;
        assert!(
            replay
                .apply_entry(prepared.milestone().clone(), &bad)
                .is_err()
        );
        assert_eq!(replay.milestone, 2u8.into());
        apply(&mut replay, prepared)?;
        let old_work = cleanup::scan(&old_snapshot, 16, 32)?;
        assert_eq!(old_work.tasks, vec![task("f", "0")]);
        assert!(
            old_work.freed.is_empty(),
            "background readers keep a stable pre-cleanup view"
        );
        Ok(())
    }
}
