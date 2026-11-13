use super::*;
use crate::{cleanup, event, heap, timeline};
use std::collections::BTreeSet;

struct World {
    writer: timeline::Stager,
    replay: timeline::Watershed,
    snapshot: Option<timeline::Snapshot>,
}
impl World {
    fn new() -> Self {
        Self {
            writer: timeline::Watershed::default().into_stager(),
            replay: timeline::Watershed::default(),
            snapshot: None,
        }
    }
    fn apply(&mut self, prepared: timeline::Prepared) -> Result<()> {
        let event::Entry::Wal { delta, .. } = event::decode_entry(prepared.bytes())? else {
            unreachable!()
        };
        let base = self
            .replay
            .database
            .as_ref()
            .map(|s| s.image.clone())
            .or_else(|| delta.logical.base.as_ref().map(|b| b.0.clone()))
            .unwrap();
        let logical = State::ingest_logical(&base, &delta.logical)?;
        self.snapshot = prepared.snapshot();
        self.replay
            .apply_entry(prepared.milestone().clone(), prepared.bytes())?;
        assert_eq!(self.db().image, logical.image);
        Ok(())
    }
    fn db(&self) -> &State {
        self.replay.database.as_ref().unwrap()
    }
    fn request(flow: &str, nodes: Vec<heap::Node>) -> heap::Request {
        heap::Request {
            flow: flow.into(),
            viewpoint: Viewpoint::zero(),
            nodes: nodes.into_iter().map(Ok).collect(),
            proofs: BTreeMap::new(),
        }
    }
    fn inspect(&mut self, request: &mut heap::Request) -> Result<()> {
        self.writer.inspect_heap(request)?;
        for child in request.proofs.values_mut().flatten() {
            if child.etag.is_empty() {
                child.etag = "\"verified\"".into();
            }
        }
        Ok(())
    }
    fn reserve(&mut self, flow: &str, nodes: Vec<heap::Node>) -> Result<heap::Outcome> {
        let mut request = Self::request(flow, nodes);
        self.inspect(&mut request)?;
        let (prepared, outcome) = self.writer.prepare_heap(&request)?;
        if let Some(prepared) = prepared {
            self.apply(prepared)?;
        }
        Ok(outcome)
    }
    fn commit(&mut self, flow: &str) -> Result<()> {
        let prepared = self.writer.prepare(vec![event::FlowCommand {
            markers: BTreeMap::from([(
                flow.into(),
                event::Marker {
                    viewpoint: "0".into(),
                    sha384: event::digest(&[]),
                    blob: vec![],
                },
            )]),
        }])?;
        self.apply(prepared)
    }
    fn maintenance(
        &mut self,
        tasks: Vec<cleanup::Task>,
        detaching: Vec<cleanup::Freed>,
        erased: Vec<cleanup::Freed>,
    ) -> Result<bool> {
        let command = cleanup::Command {
            tasks,
            detaching,
            erased,
            freed_at: cleanup::now()?,
            edge_limit: 1,
        };
        let before = State::from_image(self.db().image.clone())?;
        let prepared = self.writer.prepare_cleanup(command.clone())?;
        if let Some(prepared) = prepared {
            self.apply(prepared)?;
            self.db().verify_cleanup(Some(&before), &command)?;
            return Ok(true);
        }
        Ok(false)
    }
    fn work(&self) -> Result<cleanup::Work> {
        cleanup::scan(self.snapshot.as_ref().unwrap(), 32, 32)
    }
}
fn node(height: u64, token: u8, edges: &[&heap::Node]) -> heap::Node {
    heap::Node {
        id: heap::node_id(height, 0, &[token]),
        length: 1,
        edges: edges.iter().map(|n| n.id.clone()).collect(),
    }
}
#[test]
fn deep_graphs_retain_shared_children_and_reclaim_in_bounded_transactions() -> Result<()> {
    let mut world = World::new();
    let leaves = [node(0, 1, &[]), node(0, 2, &[]), node(0, 3, &[])];
    let left = node(1, 4, &[&leaves[0], &leaves[1]]);
    let right = node(1, 5, &[&leaves[1], &leaves[2]]);
    let root = node(2, 6, &[&left, &right]);
    assert!(world.reserve("leaves", leaves.to_vec())?.errors.is_empty());
    assert!(
        world
            .reserve("graph", vec![left.clone(), right.clone()])?
            .errors
            .is_empty()
    );
    assert!(
        world
            .reserve("graph", vec![root.clone()])?
            .errors
            .is_empty()
    );
    let revision = world.db().heap_node(&root.id)?.unwrap().revision;
    assert!(
        world
            .reserve("again", vec![left.clone()])?
            .errors
            .is_empty(),
        "matching referenced parent is reusable"
    );
    let mut changed = left.clone();
    changed.edges.remove(&leaves[1].id);
    assert_eq!(
        world.reserve("graph", vec![changed])?.errors[&0].code,
        "edges_collision"
    );
    let mut changed = root.clone();
    changed.length = 2;
    assert_eq!(
        world.reserve("graph", vec![changed])?.errors[&0].code,
        "length_collision"
    );
    assert!(
        !world
            .db()
            .heap_node(&leaves[0].id)?
            .unwrap()
            .etag
            .is_empty()
    );
    for flow in ["leaves", "graph", "again"] {
        world.commit(flow)?;
    }
    let mut old_root = None;
    let mut detached = 0;
    let mut erased = BTreeSet::new();
    for _ in 0..60 {
        let work = world.work()?;
        for parent in &work.detaching {
            if parent.id == root.id {
                old_root = Some(parent.clone());
            }
            assert!(!world.db().heap_children(&parent.id)?.is_empty());
        }
        for ready in &work.freed {
            assert!(
                world.db().heap_children(&ready.id)?.is_empty(),
                "no S3 deletion before outgoing edges are durably gone"
            );
            erased.insert(ready.id.clone());
        }
        if work.tasks.is_empty() && work.detaching.is_empty() && work.freed.is_empty() {
            break;
        }
        if !work.tasks.is_empty() {
            world.maintenance(work.tasks, vec![], vec![])?;
        }
        if !work.detaching.is_empty() {
            detached += 1;
            world.maintenance(vec![], work.detaching, vec![])?;
        }
        if !work.freed.is_empty() {
            world.maintenance(vec![], vec![], work.freed)?;
        }
    }
    assert_eq!(erased.len(), 6);
    assert!(detached >= 6, "one edge per transaction");
    for id in erased {
        assert!(world.db().heap_node(&id)?.is_none());
    }
    let replacement = node(2, 6, &[&leaves[0]]);
    world.reserve("reuse", vec![leaves[0].clone()])?;
    assert!(
        world
            .reserve("reuse", vec![replacement.clone()])?
            .errors
            .is_empty()
    );
    assert_ne!(revision, world.db().heap_node(&root.id)?.unwrap().revision);
    assert!(!world.maintenance(vec![], vec![old_root.unwrap()], vec![])?);
    assert_eq!(world.db().heap_children(&root.id)?, replacement.edges);
    Ok(())
}
#[test]
fn child_verification_is_bound_to_the_current_live_revision() -> Result<()> {
    let mut world = World::new();
    let leaf = node(0, 10, &[]);
    let parent = node(1, 11, &[&leaf]);
    world.reserve("old", vec![leaf.clone()])?;
    let mut request = World::request("parent", vec![parent.clone()]);
    world.inspect(&mut request)?;
    world.commit("old")?;
    let work = world.work()?;
    world.maintenance(work.tasks, vec![], vec![])?;
    let (prepared, outcome) = world.writer.prepare_heap(&request)?;
    assert!(prepared.is_none());
    assert_eq!(outcome.errors[&0].code, "child_changed");
    let work = world.work()?;
    world.maintenance(vec![], vec![], work.freed)?;
    world.reserve("replacement", vec![leaf.clone()])?;
    let (prepared, outcome) = world.writer.prepare_heap(&request)?;
    assert!(prepared.is_none());
    assert_eq!(outcome.errors[&0].code, "child_changed");
    assert!(world.db().heap_node(&parent.id)?.is_none());
    Ok(())
}
