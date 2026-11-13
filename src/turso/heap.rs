use super::*;
use crate::heap::{Allocation, Child, Command, NodeError, Outcome, Request, Reserved, retainer};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeapNode {
    pub revision: String,
    pub freed: String,
    pub length: u64,
    pub reserved: String,
    pub etag: String,
    pub promoted: String,
    pub marked: String,
    pub promoted_valid: bool,
}

impl State {
    pub fn heap_node(&self, id: &str) -> Result<Option<HeapNode>> {
        let mut query=self.native.conn.prepare("SELECT content_length,reserved,etag,promoted,julianday(promoted) IS NOT NULL,revision,freed,marked FROM graph_nodes WHERE id=?1")?;
        query.bind_at(
            NonZeroUsize::new(1).unwrap(),
            Value::build_text(id.to_owned()),
        )?;
        match ready_step(&*self.native.io, || query.step())? {
            StepResult::Row => {
                let row = query.row().unwrap();
                Ok(Some(HeapNode {
                    length: u64::try_from(row.get::<i64>(0)?)?,
                    revision: row.get(5)?,
                    freed: row.get(6)?,
                    marked: row.get(7)?,
                    reserved: row.get(1)?,
                    etag: row.get(2)?,
                    promoted: row.get(3)?,
                    promoted_valid: row.get::<i64>(4)? != 0,
                }))
            }
            StepResult::Done => Ok(None),
            other => anyhow::bail!("unexpected heap lookup: {other:?}"),
        }
    }
    pub fn heap_edge(&self, node: &str, retainer: &str) -> Result<bool> {
        let mut query = self
            .native
            .conn
            .prepare("SELECT 1 FROM graph_edges WHERE node=?1 AND retainer=?2")?;
        query.bind_at(
            NonZeroUsize::new(1).unwrap(),
            Value::build_text(node.to_owned()),
        )?;
        query.bind_at(
            NonZeroUsize::new(2).unwrap(),
            Value::build_text(retainer.to_owned()),
        )?;
        Ok(matches!(
            ready_step(&*self.native.io, || query.step())?,
            StepResult::Row
        ))
    }
    pub fn heap_counts(&self) -> Result<BTreeMap<String, u64>> {
        let mut counts = BTreeMap::new();
        for table in [
            "graph_nodes",
            "graph_edges",
            "sweeping_tasks",
            "marking_tasks",
        ] {
            self.native
                .conn
                .prepare(format!("SELECT count(*) FROM {table}"))?
                .run_with_row_callback(|row| {
                    counts.insert(table.into(), row.get::<i64>(0)? as u64);
                    Ok(())
                })?;
        }
        Ok(counts)
    }
    pub fn heap_children(&self, id: &str) -> Result<std::collections::BTreeSet<String>> {
        let mut query = self
            .native
            .conn
            .prepare("SELECT node FROM graph_edges WHERE retainer=?1 ORDER BY node")?;
        query.bind_at(
            NonZeroUsize::new(1).unwrap(),
            Value::build_text(id.to_owned()),
        )?;
        let mut children = std::collections::BTreeSet::new();
        query.run_with_row_callback(|row| {
            children.insert(row.get(0)?);
            Ok(())
        })?;
        Ok(children)
    }
    pub(crate) fn inspect_heap(&self, request: &mut Request) -> Result<()> {
        for parent in request.nodes.iter().filter_map(|n| n.as_ref().ok()) {
            if self.heap_node(&parent.id)?.is_some() {
                continue;
            }
            self.inspect_children(&parent.edges, &mut request.proofs)?;
        }
        Ok(())
    }
    pub(crate) fn inspect_children(
        &self,
        edges: &std::collections::BTreeSet<String>,
        proofs: &mut crate::heap::Proofs,
    ) -> Result<()> {
        for id in edges {
            if proofs.contains_key(id) {
                continue;
            }
            let proof = match self.heap_node(id)? {
                Some(row) if row.freed.is_empty() => Ok(Child {
                    revision: row.revision,
                    length: row.length,
                    etag: row.etag,
                }),
                Some(_) => Err(NodeError {
                    code: "child_freed",
                    message: "child is awaiting reclamation",
                }),
                None => Err(NodeError {
                    code: "child_unknown",
                    message: "child has no reserved allocation",
                }),
            };
            proofs.insert(id.clone(), proof);
        }
        Ok(())
    }
    pub(crate) fn check_children(
        &self,
        edges: &std::collections::BTreeSet<String>,
        proofs: &crate::heap::Proofs,
    ) -> Result<Option<NodeError>> {
        for id in edges {
            let proof = match proofs.get(id) {
                Some(Ok(p)) => p,
                Some(Err(e)) => return Ok(Some(e.clone())),
                None => {
                    return Ok(Some(NodeError {
                        code: "child_unverified",
                        message: "child object has not been verified",
                    }));
                }
            };
            if !self.heap_node(id)?.is_some_and(|row| {
                row.freed.is_empty()
                    && row.revision == proof.revision
                    && row.length == proof.length
                    && !proof.etag.is_empty()
                    && (row.etag.is_empty() || row.etag == proof.etag)
            }) {
                return Ok(Some(NodeError {
                    code: "child_changed",
                    message: "child allocation changed during verification; retry",
                }));
            }
        }
        Ok(None)
    }
    pub(super) fn plan_heap(&self, request: &Request) -> Result<(Option<Command>, Outcome)> {
        let reserved = crate::cleanup::now()?;
        let mut outcome = Outcome::default();
        let mut planned = BTreeMap::<String, (HeapNode, std::collections::BTreeSet<String>)>::new();
        let mut nodes = BTreeMap::<String, Allocation>::new();
        let mut children = BTreeMap::new();
        for (index, node) in request.nodes.iter().enumerate() {
            let node = match node {
                Ok(node) => node,
                Err(error) => {
                    outcome.errors.insert(index, error.clone());
                    continue;
                }
            };
            let current = if let Some(current) = planned.get(&node.id) {
                Some(current.clone())
            } else if let Some(row) = self.heap_node(&node.id)? {
                Some((row, self.heap_children(&node.id)?))
            } else {
                None
            };
            let mut verified = BTreeMap::new();
            let error = if let Some((row, edges)) = &current {
                if !row.freed.is_empty() {
                    Some(NodeError {
                        code: "node_freed",
                        message: "node is awaiting cleanup; retry after reclamation",
                    })
                } else if row.length != node.length {
                    Some(NodeError {
                        code: "length_collision",
                        message: "node already has a different content length",
                    })
                } else if *edges != node.edges {
                    Some(NodeError {
                        code: "edges_collision",
                        message: "node already has different children",
                    })
                } else {
                    None
                }
            } else {
                let mut error = None;
                for id in &node.edges {
                    let proof = match request.proofs.get(id) {
                        Some(Ok(proof)) => proof,
                        Some(Err(e)) => {
                            error = Some(e.clone());
                            break;
                        }
                        None => {
                            error = Some(NodeError {
                                code: "child_unverified",
                                message: "child object has not been verified",
                            });
                            break;
                        }
                    };
                    match self.heap_node(id)? {
                        Some(row)
                            if row.freed.is_empty()
                                && row.revision == proof.revision
                                && row.length == proof.length
                                && !proof.etag.is_empty()
                                && (row.etag.is_empty() || row.etag == proof.etag) =>
                        {
                            verified.insert(id.clone(), proof.clone());
                        }
                        _ => {
                            error = Some(NodeError {
                                code: "child_changed",
                                message: "child allocation changed during verification; retry",
                            });
                            break;
                        }
                    }
                }
                error
            };
            if let Some(error) = error {
                outcome.errors.insert(index, error);
                continue;
            }
            let current = current.map(|(row, _)| row).unwrap_or_else(|| HeapNode {
                revision: uuid::Uuid::new_v4().to_string(),
                freed: String::new(),
                length: node.length,
                reserved: reserved.clone(),
                etag: String::new(),
                promoted: String::new(),
                marked: String::new(),
                promoted_valid: false,
            });
            outcome.results.insert(
                index,
                Reserved {
                    id: node.id.clone(),
                    revision: current.revision.clone(),
                    length: node.length,
                    write: current.etag.is_empty(),
                    preview: !current.promoted_valid,
                },
            );
            nodes.insert(
                node.id.clone(),
                Allocation {
                    id: node.id.clone(),
                    length: node.length,
                    revision: current.revision.clone(),
                    edges: node.edges.clone(),
                },
            );
            planned.insert(node.id.clone(), (current, node.edges.clone()));
            children.extend(verified);
        }
        for result in outcome.results.values_mut() {
            if children.contains_key(&result.id) {
                result.write = false;
            }
        }
        let command = (!nodes.is_empty()).then(|| Command {
            flow: request.flow.clone(),
            viewpoint: request.viewpoint.decimal(),
            reserved,
            nodes: nodes.into_values().collect(),
            children,
        });
        Ok((command, outcome))
    }
    pub(super) fn transact_heap(&self, milestone: &str, command: &Command) -> Result<()> {
        command.validate()?;
        let conn = &self.native.conn;
        conn.set_portable_logical_changes_enabled(true);
        conn.execute("BEGIN CONCURRENT")?;
        let owner = retainer(&command.flow, &Viewpoint::parse(&command.viewpoint)?);
        for (id, child) in &command.children {
            let row = self
                .heap_node(id)?
                .ok_or_else(|| anyhow::anyhow!("missing verified child"))?;
            ensure!(
                row.revision == child.revision
                    && row.length == child.length
                    && row.freed.is_empty()
                    && !child.etag.is_empty()
                    && (row.etag.is_empty() || row.etag == child.etag),
                "verified child changed before transaction"
            );
            let mut cache = conn.prepare(
                "UPDATE graph_nodes SET etag=?2 WHERE id=?1 AND revision=?3 AND freed=''",
            )?;
            for (i, value) in [id, &child.etag, &child.revision].into_iter().enumerate() {
                cache.bind_at(
                    NonZeroUsize::new(i + 1).unwrap(),
                    Value::build_text(value.to_owned()),
                )?;
            }
            cache.run_ignore_rows()?;
        }
        for node in &command.nodes {
            if let Some(row) = self.heap_node(&node.id)? {
                ensure!(
                    row.revision == node.revision
                        && row.freed.is_empty()
                        && row.length == node.length
                        && self.heap_children(&node.id)? == node.edges,
                    "reserved descriptor changed before transaction"
                );
            }
            let mut insert=conn.prepare("INSERT INTO graph_nodes(id,content_length,reserved,etag,promoted,revision) VALUES(?1,?2,?3,'','',?4) ON CONFLICT(id) DO NOTHING")?;
            for (i, value) in [
                Value::build_text(node.id.clone()),
                Value::from_i64(node.length as i64),
                Value::build_text(command.reserved.clone()),
                Value::build_text(node.revision.clone()),
            ]
            .into_iter()
            .enumerate()
            {
                insert.bind_at(NonZeroUsize::new(i + 1).unwrap(), value)?;
            }
            insert.run_ignore_rows()?;
            let mut edge=conn.prepare("INSERT INTO graph_edges(node,retainer) VALUES(?1,?2) ON CONFLICT(node,retainer) DO NOTHING")?;
            edge.bind_at(
                NonZeroUsize::new(1).unwrap(),
                Value::build_text(node.id.clone()),
            )?;
            edge.bind_at(
                NonZeroUsize::new(2).unwrap(),
                Value::build_text(owner.clone()),
            )?;
            edge.run_ignore_rows()?;
            for child in &node.edges {
                let mut edge = conn.prepare("INSERT INTO graph_edges(node,retainer) VALUES(?1,?2) ON CONFLICT(node,retainer) DO NOTHING")?;
                edge.bind_at(
                    NonZeroUsize::new(1).unwrap(),
                    Value::build_text(child.clone()),
                )?;
                edge.bind_at(
                    NonZeroUsize::new(2).unwrap(),
                    Value::build_text(node.id.clone()),
                )?;
                edge.run_ignore_rows()?;
            }
        }
        let mut cursor = conn.prepare("UPDATE watershed SET milestone=?1 WHERE id=1")?;
        cursor.bind_at(
            NonZeroUsize::new(1).unwrap(),
            Value::build_text(milestone.to_owned()),
        )?;
        cursor.run_ignore_rows()?;
        drop(cursor);
        conn.execute("COMMIT")?;
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn verify_heap(&self, before: Option<&State>, command: &Command) -> Result<()> {
        let viewpoint = command.validate()?;
        let previous = before
            .map(|db| db.latest(&command.flow))
            .transpose()?
            .flatten();
        ensure!(
            viewpoint == previous.clone().map_or_else(Viewpoint::zero, |v| v.next()),
            "heap reservation Viewpoint mismatch"
        );
        ensure!(
            self.latest(&command.flow)? == previous,
            "heap reservation advanced Flow cursor"
        );
        let owner = retainer(&command.flow, &viewpoint);
        for node in &command.nodes {
            let previous = before
                .map(|db| db.heap_node(&node.id))
                .transpose()?
                .flatten();
            let mut expected = previous.unwrap_or_else(|| HeapNode {
                revision: node.revision.clone(),
                freed: String::new(),
                length: node.length,
                reserved: command.reserved.clone(),
                etag: String::new(),
                promoted: String::new(),
                marked: String::new(),
                promoted_valid: false,
            });
            if let Some(child) = command.children.get(&node.id) {
                expected.etag = child.etag.clone();
            }
            ensure!(
                self.heap_children(&node.id)? == node.edges,
                "recovered child set mismatch"
            );
            ensure!(
                expected.length == node.length
                    && expected.revision == node.revision
                    && expected.freed.is_empty(),
                "invalid heap collision"
            );
            ensure!(
                self.heap_node(&node.id)?.as_ref() == Some(&expected),
                "recovered heap node mismatch"
            );
            ensure!(
                self.heap_edge(&node.id, &owner)?,
                "missing recovered staging edge"
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(flow: &str, token: &[u8], length: u64) -> Request {
        use base64::Engine;
        Request::parse(serde_json::json!({"flow":flow,"viewpoint":"0x0","nodes":[{"auth":[0,0,format!("0*{}",base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token))],"length":length,"edges":[]}]}).to_string().as_bytes(),&crate::heap::Limits::default()).unwrap()
    }
    #[test]
    fn collision_flags_retainer_uniqueness_and_edge_ordering() -> Result<()> {
        let state = State::genesis()?;
        let request = request("f/雪", b"node-access-token", 4);
        let (command, outcome) = state.plan_heap(&request)?;
        assert!(outcome.results[&0].write && outcome.results[&0].preview);
        state.transact_heap("1", &command.unwrap())?;
        let id = &request.nodes[0].as_ref().unwrap().id;
        let original = state.heap_node(id)?.unwrap();
        let (command, _) = state.plan_heap(&request)?;
        state.transact_heap("2", &command.unwrap())?;
        assert_eq!(state.heap_node(id)?.unwrap(), original);
        let wrong = super::tests::request("g", b"node-access-token", 5);
        let (command, outcome) = state.plan_heap(&wrong)?;
        assert!(command.is_none());
        assert_eq!(outcome.errors[&0].code, "length_collision");
        state.native.conn.execute(format!(
            "UPDATE graph_nodes SET etag='\"etag\"', promoted='not-a-date' WHERE id='{id}'"
        ))?;
        let (_, outcome) = state.plan_heap(&request)?;
        assert!(!outcome.results[&0].write && outcome.results[&0].preview);
        state.native.conn.execute(format!(
            "UPDATE graph_nodes SET promoted='2026-11-11T00:00:00Z' WHERE id='{id}'"
        ))?;
        let (_, outcome) = state.plan_heap(&request)?;
        assert!(!outcome.results[&0].write && !outcome.results[&0].preview);
        let parent = crate::heap::node_id(1, 0, b"parent");
        state
            .native
            .conn
            .execute(format!("INSERT INTO graph_edges VALUES('{id}','{parent}')"))?;
        let (command, outcome) = state.plan_heap(&request)?;
        assert!(command.is_some());
        assert!(outcome.errors.is_empty());
        assert!(
            state
                .native
                .conn
                .execute(format!("INSERT INTO graph_edges VALUES('{id}','{id}')"))
                .is_err()
        );
        Ok(())
    }
}
