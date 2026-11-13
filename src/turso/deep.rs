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
                    edges: Default::default(),
                    verified: Default::default(),
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

#[test]
fn marker_graphs_mark_in_bounded_postorder_and_survive_staging_sweeps() -> Result<()> {
    let mut w = World::new();
    let leaf = |name: &str| heap::Node {
        id: heap::node_id(0, 0, name.as_bytes()),
        length: 1,
        edges: BTreeSet::new(),
    };
    let a = leaf("marked-a");
    let b = leaf("marked-b");
    let unused = leaf("marked-unused");
    assert!(
        w.reserve("graph", vec![a.clone(), b.clone(), unused.clone()])?
            .errors
            .is_empty()
    );
    let parent = heap::Node {
        id: heap::node_id(1, 0, b"marked-parent"),
        length: 1,
        edges: BTreeSet::from([a.id.clone(), b.id.clone()]),
    };
    w.reserve("graph", vec![parent.clone()])?;
    let middle = parent;
    let parent = heap::Node {
        id: heap::node_id(2, 0, b"marked-root"),
        length: 1,
        edges: BTreeSet::from([middle.id.clone(), b.id.clone()]),
    };
    w.reserve("graph", vec![parent.clone()])?;
    let edges = BTreeSet::from([parent.id.clone()]);
    let mut proofs = heap::Proofs::new();
    w.writer.inspect_children(&edges, &mut proofs)?;
    for child in proofs.values_mut().flatten() {
        child.etag = "\"verified\"".into();
    }
    assert!(w.writer.check_children(&edges, &proofs)?.is_none());
    let prepared = w.writer.prepare(vec![event::FlowCommand {
        markers: BTreeMap::from([(
            "graph".into(),
            event::Marker {
                viewpoint: "0".into(),
                sha384: event::digest(&[]),
                blob: vec![],
                edges,
                verified: proofs.into_iter().map(|(id, p)| (id, p.unwrap())).collect(),
            },
        )]),
    }])?;
    w.apply(prepared)?;
    let owner = heap::marker_retainer("graph", &Viewpoint::zero());
    assert!(w.db().heap_edge(&parent.id, &owner)?);
    assert_eq!(w.db().heap_node(&parent.id)?.unwrap().etag, "\"verified\"");
    // An out-of-order proposal cannot mark a parent before its children, nor remove its task.
    let row = w.db().heap_node(&parent.id)?.unwrap();
    let task = crate::promotion::Task {
        upstream: w.writer.prefix().milestone().clone(),
        flow: "graph".into(),
        viewpoint: "0".into(),
    };
    let mut wrong_upstream = task.clone();
    wrong_upstream.upstream += 1u8;
    assert!(!w.db().marking_task(&wrong_upstream)?);
    let bad = crate::promotion::Command {
        tasks: vec![task.clone()],
        marked: vec![crate::promotion::Node {
            id: parent.id.clone(),
            revision: row.revision,
            etag: row.etag,
            length: 1,
        }],
        at: cleanup::now()?,
        ..Default::default()
    };
    let p = w.writer.prepare_promotion(bad)?.unwrap();
    w.apply(p)?;
    let mut seen = Vec::new();
    loop {
        let work = crate::promotion::scan(w.snapshot.as_ref().unwrap(), 1, 1)?;
        assert!(w.db().marking_task(&task)?);
        if work.marking.marked.is_empty() {
            assert!(
                work.ready.is_empty(),
                "marking alone does not complete promotion"
            );
            break;
        }
        assert_eq!(work.marking.marked.len(), 1);
        seen.push(work.marking.marked[0].id.clone());
        let p = w.writer.prepare_promotion(work.marking)?.unwrap();
        w.apply(p)?;
    }
    assert_eq!(seen.len(), 4);
    assert_eq!(seen[2], middle.id);
    assert_eq!(seen.last(), Some(&parent.id));
    assert!(seen.contains(&a.id) && seen.contains(&b.id));
    // Release every staging edge a transaction at a time. The marker graph remains retained.
    loop {
        let work = cleanup::scan(w.snapshot.as_ref().unwrap(), 1, 32)?;
        if work.tasks.is_empty() {
            break;
        }
        w.maintenance(work.tasks, vec![], vec![])?;
    }
    assert!(!w.db().heap_node(&unused.id)?.unwrap().freed.is_empty());
    for n in [&a, &b, &middle, &parent] {
        assert!(w.db().heap_node(&n.id)?.unwrap().freed.is_empty());
    }
    let work = crate::promotion::scan(w.snapshot.as_ref().unwrap(), 1, 32)?;
    assert_eq!(work.promote.len(), 2);
    let mut stale = work.promote.clone();
    stale[0].revision = uuid::Uuid::new_v4().to_string();
    let one = stale.remove(0);
    assert!(
        w.writer
            .prepare_promotion(crate::promotion::Command {
                promoted: vec![one],
                at: cleanup::now()?,
                ..Default::default()
            })?
            .is_none()
    );
    let mut promoted = Vec::new();
    loop {
        let work = crate::promotion::scan(w.snapshot.as_ref().unwrap(), 1, 32)?;
        assert!(w.db().marking_task(&task)?);
        if work.promote.is_empty() {
            assert_eq!(work.ready, vec![task.clone()]);
            break;
        }
        promoted.extend(work.promote.iter().map(|n| n.id.clone()));
        let p = w
            .writer
            .prepare_promotion(crate::promotion::Command {
                promoted: work.promote,
                at: cleanup::now()?,
                ..Default::default()
            })?
            .unwrap();
        w.apply(p)?;
    }
    assert_eq!(promoted.len(), 4);
    assert_eq!(promoted[2], middle.id);
    assert_eq!(promoted[3], parent.id);
    let p = w
        .writer
        .prepare_promotion(crate::promotion::Command {
            signed: vec![crate::promotion::ConfirmedSign::simulated(task.clone())],
            at: cleanup::now()?,
            ..Default::default()
        })?
        .unwrap();
    w.apply(p)?;
    assert!(!w.db().marking_task(&task)?);
    for n in [&a, &b, &middle, &parent] {
        assert!(w.db().heap_node(&n.id)?.unwrap().promoted_valid);
    }
    // A second marker can retain an already marked/promoted graph; only its task needs clearing.
    let edges = BTreeSet::from([parent.id.clone()]);
    let mut proofs = heap::Proofs::new();
    w.writer.inspect_children(&edges, &mut proofs)?;
    assert!(
        proofs
            .values()
            .all(|p| !p.as_ref().unwrap().etag.is_empty())
    );
    let p = w.writer.prepare(vec![event::FlowCommand {
        markers: BTreeMap::from([(
            "other".into(),
            event::Marker {
                viewpoint: "0".into(),
                sha384: event::digest(&[]),
                blob: vec![],
                edges,
                verified: proofs.into_iter().map(|(id, p)| (id, p.unwrap())).collect(),
            },
        )]),
    }])?;
    w.apply(p)?;
    let work = crate::promotion::scan(w.snapshot.as_ref().unwrap(), 1, 1)?;
    assert_eq!(work.marking.tasks.len(), 1);
    assert!(work.marking.marked.is_empty());
    assert!(w.writer.prepare_promotion(work.marking)?.is_none());
    assert_eq!(work.ready.len(), 1);
    let p = w
        .writer
        .prepare_promotion(crate::promotion::Command {
            signed: work
                .ready
                .into_iter()
                .map(crate::promotion::ConfirmedSign::simulated)
                .collect(),
            at: cleanup::now()?,
            ..Default::default()
        })?
        .unwrap();
    w.apply(p)?;
    assert!(
        crate::promotion::scan(w.snapshot.as_ref().unwrap(), 1, 1)?
            .marking
            .tasks
            .is_empty()
    );
    w.commit("empty")?;
    let empty = crate::promotion::Task {
        upstream: w.writer.prefix().milestone().clone(),
        flow: "empty".into(),
        viewpoint: "0".into(),
    };
    let work = crate::promotion::scan(w.snapshot.as_ref().unwrap(), 1, 1)?;
    assert_eq!(work.ready, vec![empty.clone()]);
    assert!(work.marking.marked.is_empty());
    assert!(w.db().marking_task(&empty)?);
    Ok(())
}
