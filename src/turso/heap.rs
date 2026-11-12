use super::*;
use crate::heap::{Allocation, Command, NodeError, Outcome, Request, Reserved, retainer};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeapNode {
    pub revision: String,
    pub freed: String,
    pub length: u64,
    pub reserved: String,
    pub etag: String,
    pub promoted: String,
    pub promoted_valid: bool,
    pub incoming: bool,
}

impl State {
    pub fn heap_node(&self, id: &str) -> Result<Option<HeapNode>> {
        let mut query=self.native.conn.prepare("SELECT content_length,reserved,etag,promoted,julianday(promoted) IS NOT NULL,EXISTS(SELECT 1 FROM graph_edges WHERE node=?1 AND retainer>='n-' AND retainer<'n.'),revision,freed FROM graph_nodes WHERE id=?1")?;
        query.bind_at(
            NonZeroUsize::new(1).unwrap(),
            Value::build_text(id.to_owned()),
        )?;
        match ready_step(&*self.native.io, || query.step())? {
            StepResult::Row => {
                let row = query.row().unwrap();
                Ok(Some(HeapNode {
                    length: u64::try_from(row.get::<i64>(0)?)?,
                    revision: row.get(6)?,
                    freed: row.get(7)?,
                    reserved: row.get(1)?,
                    etag: row.get(2)?,
                    promoted: row.get(3)?,
                    promoted_valid: row.get::<i64>(4)? != 0,
                    incoming: row.get::<i64>(5)? != 0,
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
    pub(super) fn plan_heap(&self, request: &Request) -> Result<(Option<Command>, Outcome)> {
        let reserved = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)?;
        let mut outcome = Outcome::default();
        let mut planned = BTreeMap::<String, HeapNode>::new();
        let mut nodes = BTreeMap::<String, Allocation>::new();
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
            } else {
                self.heap_node(&node.id)?
            };
            if let Some(current) = &current {
                let error = if !current.freed.is_empty() {
                    Some(NodeError {
                        code: "node_freed",
                        message: "node is awaiting cleanup; retry after reclamation",
                    })
                } else if current.length != node.length {
                    Some(NodeError {
                        code: "length_collision",
                        message: "node already has a different content length",
                    })
                } else if current.incoming {
                    Some(NodeError {
                        code: "referenced_node",
                        message: "node has an incoming node edge",
                    })
                } else {
                    None
                };
                if let Some(error) = error {
                    outcome.errors.insert(index, error);
                    continue;
                }
            }
            let current = current.unwrap_or_else(|| HeapNode {
                revision: uuid::Uuid::new_v4().to_string(),
                freed: String::new(),
                length: node.length,
                reserved: reserved.clone(),
                etag: String::new(),
                promoted: String::new(),
                promoted_valid: false,
                incoming: false,
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
                },
            );
            planned.insert(node.id.clone(), current);
        }
        let command = (!nodes.is_empty()).then(|| Command {
            flow: request.flow.clone(),
            viewpoint: request.viewpoint.decimal(),
            reserved,
            nodes: nodes.into_values().collect(),
        });
        Ok((command, outcome))
    }
    pub(super) fn transact_heap(&self, milestone: &str, command: &Command) -> Result<()> {
        command.validate()?;
        let conn = &self.native.conn;
        conn.set_portable_logical_changes_enabled(true);
        conn.execute("BEGIN CONCURRENT")?;
        let owner = retainer(&command.flow, &Viewpoint::parse(&command.viewpoint)?);
        for node in &command.nodes {
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
            let expected = previous.unwrap_or_else(|| HeapNode {
                revision: node.revision.clone(),
                freed: String::new(),
                length: node.length,
                reserved: command.reserved.clone(),
                etag: String::new(),
                promoted: String::new(),
                promoted_valid: false,
                incoming: false,
            });
            ensure!(
                expected.length == node.length
                    && expected.revision == node.revision
                    && expected.freed.is_empty()
                    && !expected.incoming,
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
        assert!(command.is_none());
        assert_eq!(outcome.errors[&0].code, "referenced_node");
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
