//! Canonical path-copying for monoidal consumers whose values have no basin edges.
use super::*;
use std::collections::BTreeMap;

#[derive(Clone)]
enum Part {
    Row(Row),
    Tree { base: Vec<u8>, source: Value },
}
fn header(v: &Value) -> Result<&Value> {
    if matches!(v, Map(_)) {
        v.index(5)
    } else {
        v.at(5)
    }
}
fn summary(v: &Value) -> Result<&Value> {
    if matches!(v, Map(_)) {
        v.index(6)?.at(1)
    } else {
        v.at(6)?.field("1")
    }
}
fn order(parts: &mut Vec<Part>) -> Result<()> {
    let mut keyed = std::mem::take(parts)
        .into_iter()
        .map(|p| Ok((p.bounds()?.0, p)))
        .collect::<Result<Vec<_>>>()?;
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    *parts = keyed.into_iter().map(|(_, p)| p).collect();
    Ok(())
}
impl Part {
    fn bounds(&self) -> Result<(Vec<u8>, Vec<u8>)> {
        Ok(match self {
            Self::Row(r) => (r.key.clone(), r.key.clone()),
            Self::Tree { base, source } => {
                let keys = header(source)?.field("keys")?;
                (
                    [base.as_slice(), keys.at(0)?.blob()?].concat(),
                    [base.as_slice(), keys.at(1)?.blob()?].concat(),
                )
            }
        })
    }
    fn count(&self) -> Result<usize> {
        Ok(match self {
            Self::Row(_) => 1,
            Self::Tree { source, .. } => usize::try_from(header(source)?.field("count")?.big()?)?,
        })
    }
    fn summary(&self) -> Result<Value> {
        Ok(match self {
            Self::Row(r) => r.summary.clone(),
            Self::Tree { source, .. } => summary(source)?.clone(),
        })
    }
}
struct Node {
    source: Value,
    existing: Option<Edge>,
}
impl Node {
    fn materialize<S: Storage>(&self, b: &mut Basin<S>) -> Result<Built> {
        let node = if matches!(self.source, Map(_)) {
            self.source.clone()
        } else {
            View::root(b.load(&self.source)?).owned()?
        };
        Ok(Built {
            edges: node_refs(&node)?,
            node,
        })
    }
    fn edge<S: Storage>(&self, b: &mut Basin<S>) -> Result<Edge> {
        if let Some(e) = &self.existing {
            return Ok(e.clone());
        }
        let built = self.materialize(b)?;
        b.seal(built.node, &built.edges)
    }
}
fn node_refs(n: &Value) -> Result<Vec<Edge>> {
    let mut out = vec![];
    let members = n.index(6)?.at(3)?;
    if !members.is_null() {
        for m in members.array()? {
            if let Array(children) = m {
                for child in children.iter().filter(|c| !c.is_null()) {
                    if matches!(child, Array(_)) {
                        out.push(child.clone());
                    } else {
                        out.extend(node_refs(child)?);
                    }
                }
            }
        }
    }
    basin::distinct(&out)
}
struct Editor<'a, S: Storage, C: Consumer> {
    basin: &'a mut Basin<S>,
    consumer: &'a C,
    old: Vec<(usize, Value, Option<Edge>)>,
    changes: BTreeMap<Vec<u8>, Option<Value>>,
    remove_from: Option<Vec<u8>>,
}
impl<S: Storage, C: Consumer> Editor<'_, S, C> {
    fn expand(&mut self, part: Part) -> Result<Vec<Part>> {
        let Part::Tree { base, source } = part else {
            return Ok(vec![part]);
        };
        let existing = matches!(source, Array(_)).then(|| source.clone());
        let node = if existing.is_some() {
            View::root(self.basin.load(&source)?).owned()?
        } else {
            source
        };
        self.old.push((base.len(), node.clone(), existing));
        let mut prefix = base;
        let h = node.index(5)?;
        if !h.field("prefix")?.is_null() {
            prefix.extend(h.field("prefix")?.blob()?);
        }
        let mut out = vec![];
        let f = node.index(6)?;
        let add_group = |g: &Value| -> Result<Vec<Part>> {
            let mut out = vec![];
            for (k, v) in g
                .field("keys")?
                .array()?
                .iter()
                .zip(g.field("values")?.array()?)
            {
                let key = [prefix.as_slice(), k.blob()?].concat();
                if self.remove_from.as_ref().is_some_and(|from| &key >= from)
                    || self
                        .changes
                        .get(&key)
                        .is_some_and(|next| next.as_ref() != Some(v))
                {
                    continue;
                }
                ensure!(
                    self.consumer.edges(v)?.is_empty(),
                    "incremental values must not contain basin edges"
                );
                let sum = if h.field("count")?.big()? == 1.into() {
                    f.at(1)?.clone()
                } else {
                    self.consumer.entry(&key, v)?
                };
                out.push(Part::Row(Row {
                    key,
                    value: v.clone(),
                    summary: sum,
                }));
            }
            Ok(out)
        };
        out.extend(add_group(f.at(2)?)?);
        if !f.at(3)?.is_null() {
            for (high, m) in f.at(3)?.array()?.iter().enumerate() {
                if matches!(m, Map(_)) {
                    out.extend(add_group(m)?);
                } else if let Array(children) = m {
                    for (low, child) in children.iter().enumerate().filter(|(_, c)| !c.is_null()) {
                        let mut base = prefix.clone();
                        base.push((high * 16 + low) as u8);
                        out.push(Part::Tree {
                            base,
                            source: child.clone(),
                        });
                    }
                }
            }
        }
        Ok(out)
    }
    fn rows(&mut self, parts: Vec<Part>, depth: usize) -> Result<Vec<Row>> {
        let mut todo = parts;
        let mut rows = vec![];
        while let Some(p) = todo.pop() {
            match p {
                Part::Row(mut r) => {
                    r.key = r.key[depth..].to_vec();
                    rows.push(r);
                }
                tree => todo.extend(self.expand(tree)?),
            }
        }
        rows.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(rows)
    }
    fn partition(&mut self, parts: Vec<Part>, pos: usize, high: bool) -> Result<Vec<Vec<Part>>> {
        let mut out = (0..17).map(|_| vec![]).collect::<Vec<_>>();
        let mut todo = parts;
        let index = |key: &[u8]| {
            key.get(pos).map_or(16, |b| {
                if high {
                    usize::from(b >> 4)
                } else {
                    usize::from(b & 15)
                }
            })
        };
        while let Some(p) = todo.pop() {
            let (a, z) = p.bounds()?;
            if index(&a) != index(&z) || (index(&a) == 16 && matches!(p, Part::Tree { .. })) {
                todo.extend(self.expand(p)?);
            } else {
                out[index(&a)].push(p);
            }
        }
        for group in &mut out {
            order(group)?;
        }
        Ok(out)
    }
    fn build(&mut self, mut parts: Vec<Part>, depth: usize, level: usize) -> Result<Node> {
        ensure!(level < 256, "incremental trie nesting limit");
        if parts.len() == 1
            && let Part::Tree { base, source } = &parts[0]
            && base.len() == depth
        {
            return Ok(Node {
                existing: matches!(source, Array(_)).then(|| source.clone()),
                source: source.clone(),
            });
        }
        order(&mut parts)?;
        if parts.is_empty() {
            return Ok(Node {
                source: build_rows(self.basin, vec![], self.consumer, level)?.node,
                existing: None,
            });
        }
        let first = parts.first().unwrap().bounds()?.0;
        let last = parts.last().unwrap().bounds()?.1;
        let prefix_len = first.iter().zip(&last).take_while(|(a, b)| a == b).count();
        let prefix = first[..prefix_len].to_vec();
        let count = parts
            .iter()
            .try_fold(0usize, |n, p| Ok::<_, anyhow::Error>(n + p.count()?))?;
        let limit = self.consumer.trie_inline_limit();
        if count <= limit.min(255) {
            let rows = self.rows(parts, depth)?;
            let built = build_rows(self.basin, rows, self.consumer, level)?;
            return Ok(self.reuse(depth, built.node));
        }
        let sums = parts
            .iter()
            .map(Part::summary)
            .collect::<Result<Vec<_>>>()?;
        let sum = self.consumer.combine(&sums)?;
        let nullity = parts.iter().try_fold(num_bigint::BigInt::from(0), |n, p| {
            Ok::<_, anyhow::Error>(
                n + match p {
                    Part::Row(r) => BigInt::from(u8::from(r.value.is_null())),
                    Part::Tree { source, .. } => header(source)?.field("nullity")?.big()?,
                },
            )
        })?;
        let mut min_len = usize::MAX;
        let mut max_len = 0;
        for p in &parts {
            let (a, z) = match p {
                Part::Row(r) => (r.key.len(), r.key.len()),
                Part::Tree { base, source } => {
                    let lengths = header(source)?.field("lengths")?;
                    (
                        base.len() + lengths.at(0)?.number()? as usize,
                        base.len() + lengths.at(1)?.number()? as usize,
                    )
                }
            };
            min_len = min_len.min(a);
            max_len = max_len.max(z);
        }
        enum Members {
            Group(Vec<Row>),
            Nodes(Vec<Option<Node>>),
        }
        let mut groups = self.partition(parts, prefix_len, true)?;
        let own = self.rows(std::mem::take(&mut groups[16]), prefix_len)?;
        let mut members = vec![];
        for group in groups.into_iter().take(16) {
            if group.is_empty() {
                members.push(None);
                continue;
            }
            let n = group
                .iter()
                .try_fold(0usize, |n, p| Ok::<_, anyhow::Error>(n + p.count()?))?;
            if n <= limit.min(255) {
                members.push(Some(Members::Group(self.rows(group, prefix_len)?)));
            } else {
                let buckets = self.partition(group, prefix_len, false)?;
                let mut nodes = vec![];
                for bucket in buckets.into_iter().take(16) {
                    nodes.push(if bucket.is_empty() {
                        None
                    } else {
                        Some(self.build(bucket, prefix_len + 1, level + 1)?)
                    });
                }
                trim(&mut nodes);
                members.push(Some(Members::Nodes(nodes)));
            }
        }
        trim(&mut members);
        let mut inline = own.len();
        for m in members.iter().flatten() {
            inline += match m {
                Members::Group(r) => r.len(),
                Members::Nodes(ns) => ns
                    .iter()
                    .flatten()
                    .map(|n| Ok(header(&n.source)?.field("inlined")?.number()? as usize))
                    .collect::<Result<Vec<_>>>()?
                    .iter()
                    .sum(),
            };
        }
        let mut degree_upper = 0usize;
        for m in members.iter().flatten() {
            if let Members::Nodes(ns) = m {
                for n in ns.iter().flatten() {
                    degree_upper += if matches!(n.source, Map(_)) {
                        n.source.index(3)?
                    } else {
                        n.source.at(3)?
                    }
                    .field("degree")?
                    .number()? as usize;
                }
            }
        }
        let mut by_degree = false;
        if degree_upper > self.basin.max_degree {
            let mut edges = vec![];
            for m in members.iter().flatten() {
                if let Members::Nodes(ns) = m {
                    for n in ns.iter().flatten() {
                        edges.extend(n.materialize(self.basin)?.edges);
                    }
                }
            }
            by_degree = basin::distinct(&edges)?.len() > self.basin.max_degree;
        }
        let external = inline > limit || by_degree;
        let mut result = vec![];
        for m in members {
            result.push(match m {
                None => None,
                Some(Members::Group(rows)) if external && (limit != 1280 || by_degree) => Some(
                    Member::Nodes(split(self.basin, &rows, self.consumer, level)?),
                ),
                Some(Members::Group(rows)) => Some(Member::Group(rows)),
                Some(Members::Nodes(ns)) => Some(Member::Nodes(
                    ns.into_iter()
                        .map(|n| {
                            n.map(|n| {
                                if external {
                                    Ok(Child::Edge(n.edge(self.basin)?))
                                } else {
                                    Ok(Child::Inline(n.materialize(self.basin)?))
                                }
                            })
                            .transpose()
                        })
                        .collect::<Result<Vec<_>>>()?,
                )),
            });
        }
        // Groups split by the canonical strict-budget rule still need sealing.
        if external {
            for m in result.iter_mut().flatten() {
                if let Member::Nodes(ns) = m {
                    for n in ns.iter_mut().flatten() {
                        if let Child::Inline(v) = n {
                            *n = Child::Edge(self.basin.seal(v.node.clone(), &v.edges)?);
                        }
                    }
                }
            }
        }
        let edges = refs(&own, &result, self.consumer)?;
        let inline = inlined(&own, &result, self.consumer)?;
        let degree = result
            .iter()
            .flatten()
            .map(|m| match m {
                Member::Group(_) => 1,
                Member::Nodes(ns) => ns.iter().flatten().count(),
            })
            .sum::<usize>();
        let nested = Array(
            result
                .into_iter()
                .map(|m| match m {
                    None => Null,
                    Some(Member::Group(rows)) => group(&rows),
                    Some(Member::Nodes(ns)) => Array(
                        ns.into_iter()
                            .map(|n| match n {
                                None => Null,
                                Some(Child::Inline(n)) => n.node,
                                Some(Child::Edge(e)) => e,
                            })
                            .collect(),
                    ),
                })
                .collect(),
        );
        let node = Value::map([
            ("0", Symbol("species".into())),
            ("1", DOMAIN.into()),
            ("2", PATH.into()),
            (
                "3",
                basin::query(&edges, self.basin.max_degree, self.basin.max_height)?,
            ),
            ("4", 0u32.into()),
            (
                "5",
                Value::map([
                    ("count", Big(count.into())),
                    ("nullity", Big(nullity)),
                    ("degree", degree.into()),
                    ("inlined", inline.into()),
                    (
                        "prefix",
                        if prefix_len == depth {
                            Null
                        } else {
                            Blob(prefix[depth..].to_vec())
                        },
                    ),
                    (
                        "keys",
                        Array(vec![
                            Blob(first[depth..].to_vec()),
                            Blob(last[depth..].to_vec()),
                        ]),
                    ),
                    (
                        "lengths",
                        Array(vec![(min_len - depth).into(), (max_len - depth).into()]),
                    ),
                ]),
            ),
            (
                "6",
                Array(vec![
                    self.consumer.migration().into(),
                    sum,
                    group(&own),
                    nested,
                    Bool(external),
                ]),
            ),
        ]);
        Ok(self.reuse(depth, node))
    }
    fn reuse(&self, depth: usize, node: Value) -> Node {
        let existing = self
            .old
            .iter()
            .find(|(d, n, _)| *d == depth && n == &node)
            .and_then(|(_, _, e)| e.clone());
        Node {
            source: node,
            existing,
        }
    }
}
/// Path-copy a raw node or edge. Consumers must be composable monoids with no
/// value edges or weighted inline costs; unchanged opaque subtries stay unread.
pub fn update_node<S: Storage, C: Consumer>(
    b: &mut Basin<S>,
    source: Value,
    changes: Vec<(Vec<u8>, Option<Value>)>,
    c: &C,
) -> Result<Built> {
    update_node_pruned(b, source, changes, None, c)
}
/// Remove the suffix starting at `remove_from` before applying explicit changes.
/// Fully covered opaque subtries are dropped without fetching their bodies.
pub fn update_node_pruned<S: Storage, C: Consumer>(
    b: &mut Basin<S>,
    source: Value,
    changes: Vec<(Vec<u8>, Option<Value>)>,
    remove_from: Option<&[u8]>,
    c: &C,
) -> Result<Built> {
    let _profile = crate::profile::span("trie.incremental");
    ensure!(
        c.trie_inline_cost().is_none(),
        "weighted incremental values unsupported"
    );
    ensure!(
        (1..=1280).contains(&c.trie_inline_limit()),
        "invalid trie inline limit"
    );
    let migration = if matches!(source, Map(_)) {
        source.index(6)?.at(0)?.number()?
    } else {
        source.at(6)?.field("0")?.number()?
    };
    ensure!(
        migration == c.migration(),
        "unsupported trie consumer migration"
    );
    let mut e = Editor {
        basin: b,
        consumer: c,
        old: vec![],
        changes: changes.into_iter().collect(),
        remove_from: remove_from.map(<[u8]>::to_vec),
    };
    let count = header(&source)?.field("count")?.big()?;
    let mut parts = if count == 0.into() {
        vec![]
    } else {
        vec![Part::Tree {
            base: vec![],
            source,
        }]
    };
    loop {
        let mut expand = None;
        let mut discard = None;
        for (i, p) in parts.iter().enumerate() {
            let (a, z) = p.bounds()?;
            if remove_from.is_some_and(|from| a.as_slice() >= from) {
                discard = Some(i);
                break;
            }
            if matches!(p, Part::Tree { .. })
                && (e.changes.range(a..=z.clone()).next().is_some()
                    || remove_from.is_some_and(|from| z.as_slice() >= from))
            {
                expand = Some(i);
                break;
            }
        }
        if let Some(i) = discard {
            parts.swap_remove(i);
            continue;
        }
        let Some(i) = expand else { break };
        let p = parts.swap_remove(i);
        parts.extend(e.expand(p)?);
    }
    for (key, value) in std::mem::take(&mut e.changes) {
        let old = parts
            .iter()
            .position(|p| matches!(p,Part::Row(r) if r.key==key))
            .map(|i| parts.swap_remove(i));
        if let Some(value) = value {
            ensure!(
                c.edges(&value)?.is_empty(),
                "incremental values must not contain basin edges"
            );
            if let Some(Part::Row(row)) = old
                && row.value == value
            {
                parts.push(Part::Row(row));
                continue;
            }
            parts.push(Part::Row(Row {
                summary: c.entry(&key, &value)?,
                key,
                value,
            }));
        }
    }
    let node = e.build(parts, 0, 0)?;
    node.materialize(e.basin)
}
