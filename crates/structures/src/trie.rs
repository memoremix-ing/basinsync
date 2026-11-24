use crate::{
    Value,
    basin::{self, Basin, DOMAIN, Edge, Storage},
    value::{self, field, item},
};
use Value::*;
use anyhow::{Context, Result, ensure};
use flexbuffers::Reader;
use num_bigint::BigInt;
use std::sync::Arc;
pub const PATH: &str = ".trie-node/";
pub trait Consumer {
    fn migration(&self) -> u32 {
        0
    }
    fn empty(&self) -> Value;
    fn entry(&self, key: &[u8], value: &Value) -> Result<Value>;
    fn combine(&self, parts: &[Value]) -> Result<Value>;
    fn edges(&self, _value: &Value) -> Result<Vec<Edge>> {
        Ok(vec![])
    }
}
pub struct Plain;
impl Consumer for Plain {
    fn empty(&self) -> Value {
        Null
    }
    fn entry(&self, _: &[u8], _: &Value) -> Result<Value> {
        Ok(Null)
    }
    fn combine(&self, _: &[Value]) -> Result<Value> {
        Ok(Null)
    }
}
pub struct Count(pub u32);
impl Consumer for Count {
    fn migration(&self) -> u32 {
        self.0
    }
    fn empty(&self) -> Value {
        Big(0.into())
    }
    fn entry(&self, _: &[u8], _: &Value) -> Result<Value> {
        Ok(Big(1.into()))
    }
    fn combine(&self, v: &[Value]) -> Result<Value> {
        Ok(Big(v.iter().try_fold(BigInt::from(0), |n, v| {
            Ok::<_, anyhow::Error>(n + v.big()?)
        })?))
    }
}
#[derive(Clone)]
struct Row {
    key: Vec<u8>,
    value: Value,
    summary: Value,
}
#[derive(Clone)]
pub struct Built {
    pub node: Value,
    pub edges: Vec<Edge>,
}
enum Child {
    Inline(Built),
    Edge(Edge),
}
enum Member {
    Group(Vec<Row>),
    Nodes(Vec<Option<Child>>),
}
fn group(rows: &[Row]) -> Value {
    Value::map([
        (
            "keys",
            Array(rows.iter().map(|r| Blob(r.key.clone())).collect()),
        ),
        (
            "values",
            Array(rows.iter().map(|r| r.value.clone()).collect()),
        ),
    ])
}
fn trim<T>(v: &mut Vec<Option<T>>) {
    while v.last().is_some_and(Option::is_none) {
        v.pop();
    }
}
fn byte_bounds(mut keys: Vec<Vec<u8>>) -> Value {
    if keys.is_empty() {
        Null
    } else {
        keys.sort();
        Array(vec![
            Blob(keys.first().unwrap().clone()),
            Blob(keys.last().unwrap().clone()),
        ])
    }
}
fn refs<C: Consumer>(own: &[Row], members: &[Option<Member>], c: &C) -> Result<Vec<Edge>> {
    let mut edges = Vec::new();
    for r in own {
        edges.extend(c.edges(&r.value)?);
    }
    for m in members.iter().flatten() {
        match m {
            Member::Group(rows) => {
                for r in rows {
                    edges.extend(c.edges(&r.value)?);
                }
            }
            Member::Nodes(nodes) => {
                for n in nodes.iter().flatten() {
                    match n {
                        Child::Edge(e) => edges.push(e.clone()),
                        Child::Inline(n) => edges.extend(n.edges.clone()),
                    }
                }
            }
        }
    }
    basin::distinct(&edges)
}
fn inlined(own: &[Row], members: &[Option<Member>]) -> Result<usize> {
    let mut n = own.len();
    for m in members.iter().flatten() {
        n += match m {
            Member::Group(g) => g.len(),
            Member::Nodes(v) => v
                .iter()
                .flatten()
                .map(|n| match n {
                    Child::Edge(_) => Ok(0),
                    Child::Inline(n) => Ok(n.node.index(5)?.field("inlined")?.number()? as usize),
                })
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .sum(),
        };
    }
    Ok(n)
}
fn split<S: Storage, C: Consumer>(
    basin: &mut Basin<S>,
    rows: &[Row],
    c: &C,
    depth: usize,
) -> Result<Vec<Option<Child>>> {
    let mut out = Vec::new();
    for low in 0..16 {
        let part = rows
            .iter()
            .filter(|r| r.key[0] & 15 == low)
            .map(|r| Row {
                key: r.key[1..].to_vec(),
                ..r.clone()
            })
            .collect::<Vec<_>>();
        out.push(if part.is_empty() {
            None
        } else {
            Some(Child::Inline(build_rows(basin, part, c, depth + 1)?))
        });
    }
    trim(&mut out);
    Ok(out)
}
fn build_rows<S: Storage, C: Consumer>(
    basin: &mut Basin<S>,
    input: Vec<Row>,
    c: &C,
    depth: usize,
) -> Result<Built> {
    ensure!(depth < 256, "trie nesting limit");
    let mut prefix_len = input.first().map_or(0, |r| r.key.len());
    for r in &input {
        prefix_len = prefix_len.min(r.key.len());
        for i in 0..prefix_len {
            if r.key[i] != input[0].key[i] {
                prefix_len = i;
                break;
            }
        }
    }
    let prefix = if prefix_len == 0 {
        Null
    } else {
        Blob(input[0].key[..prefix_len].to_vec())
    };
    let rows = input
        .iter()
        .map(|r| Row {
            key: r.key[prefix_len..].to_vec(),
            ..r.clone()
        })
        .collect::<Vec<_>>();
    let summary = if input.is_empty() {
        c.empty()
    } else {
        c.combine(&input.iter().map(|r| r.summary.clone()).collect::<Vec<_>>())?
    };
    let mut own = rows.clone();
    let mut members = Vec::<Option<Member>>::new();
    let mut edged = Null;
    if rows.len() > 255 {
        own = rows.iter().filter(|r| r.key.is_empty()).cloned().collect();
        for high in 0..16 {
            let bucket = rows
                .iter()
                .filter(|r| !r.key.is_empty() && r.key[0] >> 4 == high)
                .cloned()
                .collect::<Vec<_>>();
            members.push(if bucket.is_empty() {
                None
            } else {
                Some(if bucket.len() <= 255 {
                    Member::Group(bucket)
                } else {
                    Member::Nodes(split(basin, &bucket, c, depth)?)
                })
            });
        }
        trim(&mut members);
        edged = Bool(false);
    }
    if !members.is_empty()
        && (inlined(&own, &members)? > 1280 || refs(&own, &members, c)?.len() > basin.max_degree)
    {
        if refs(&own, &members, c)?.len() > basin.max_degree {
            for (high, m) in members.iter_mut().enumerate() {
                if matches!(m, Some(Member::Group(_))) {
                    let bucket = rows
                        .iter()
                        .filter(|r| !r.key.is_empty() && (r.key[0] >> 4) as usize == high)
                        .cloned()
                        .collect::<Vec<_>>();
                    *m = Some(Member::Nodes(split(basin, &bucket, c, depth)?));
                }
            }
        }
        for m in members.iter_mut().flatten() {
            if let Member::Nodes(v) = m {
                for child in v.iter_mut().flatten() {
                    if let Child::Inline(b) = child {
                        *child = Child::Edge(basin.seal(b.node.clone(), &b.edges)?);
                    }
                }
            }
        }
        edged = Bool(true);
    }
    let edges = refs(&own, &members, c)?;
    let inlined = inlined(&own, &members)?;
    let degree = members
        .iter()
        .flatten()
        .map(|m| match m {
            Member::Group(_) => 1,
            Member::Nodes(v) => v.iter().flatten().count(),
        })
        .sum::<usize>();
    let keys = byte_bounds(input.iter().map(|r| r.key.clone()).collect());
    let lengths = if input.is_empty() {
        Null
    } else {
        Array(vec![
            input.iter().map(|r| r.key.len()).min().unwrap().into(),
            input.iter().map(|r| r.key.len()).max().unwrap().into(),
        ])
    };
    let header = Value::map([
        ("count", Big(input.len().into())),
        (
            "nullity",
            Big(input.iter().filter(|r| r.value.is_null()).count().into()),
        ),
        ("degree", degree.into()),
        ("inlined", inlined.into()),
        ("prefix", prefix),
        ("keys", keys),
        ("lengths", lengths),
    ]);
    let nested = if members.is_empty() {
        Null
    } else {
        Array(
            members
                .into_iter()
                .map(|m| match m {
                    None => Null,
                    Some(Member::Group(g)) => group(&g),
                    Some(Member::Nodes(nodes)) => Array(
                        nodes
                            .into_iter()
                            .map(|n| match n {
                                None => Null,
                                Some(Child::Inline(n)) => n.node,
                                Some(Child::Edge(e)) => e,
                            })
                            .collect(),
                    ),
                })
                .collect(),
        )
    };
    Ok(Built {
        node: Value::map([
            ("0", Symbol("species".into())),
            ("1", DOMAIN.into()),
            ("2", PATH.into()),
            (
                "3",
                basin::query(&edges, basin.max_degree, basin.max_height)?,
            ),
            ("4", 0u32.into()),
            ("5", header),
            (
                "6",
                Array(vec![
                    c.migration().into(),
                    summary,
                    group(&own),
                    nested,
                    edged,
                ]),
            ),
        ]),
        edges,
    })
}
pub fn build_node<S: Storage, C: Consumer>(
    basin: &mut Basin<S>,
    input: Vec<(Vec<u8>, Value)>,
    c: &C,
) -> Result<Built> {
    let mut rows = input
        .into_iter()
        .map(|(key, value)| {
            Ok(Row {
                summary: c.entry(&key, &value)?,
                key,
                value,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    rows.sort_by(|a, b| a.key.cmp(&b.key));
    ensure!(
        rows.windows(2).all(|r| r[0].key != r[1].key),
        "duplicate trie key"
    );
    build_rows(basin, rows, c, 0)
}
pub fn build<S: Storage, C: Consumer>(
    basin: &mut Basin<S>,
    input: Vec<(Vec<u8>, Value)>,
    c: &C,
) -> Result<Edge> {
    let b = build_node(basin, input, c)?;
    basin.seal(b.node, &b.edges)
}
#[derive(Clone)]
pub enum Step {
    Field(String),
    Item(usize),
}
#[derive(Clone)]
pub struct View {
    pub bytes: Arc<Vec<u8>>,
    pub path: Vec<Step>,
}
impl View {
    pub fn root(bytes: Arc<Vec<u8>>) -> Self {
        Self {
            bytes,
            path: vec![],
        }
    }
    pub fn reader(&self) -> Result<Reader<&[u8]>> {
        let mut r = basin::node_reader(&self.bytes)?;
        for s in &self.path {
            r = match s {
                Step::Field(k) => field(r, k)?,
                Step::Item(i) => item(r, *i)?,
            };
        }
        Ok(r)
    }
    pub fn field(&self, k: &str) -> Self {
        let mut c = self.clone();
        c.path.push(Step::Field(k.into()));
        c
    }
    pub fn item(&self, i: usize) -> Self {
        let mut c = self.clone();
        c.path.push(Step::Item(i));
        c
    }
    pub fn owned(&self) -> Result<Value> {
        value::read(self.reader()?)
    }
}
fn parts(view: &View, migration: u32) -> Result<(Value, View, View, Option<bool>)> {
    let r = view.reader()?;
    basin::validate_node(r.clone(), Some(PATH))?;
    let header = value::read(field(r, "5")?)?;
    let footer = view.field("6");
    let f = footer.reader()?.get_vector()?;
    ensure!(
        f.len() == 5 && f.index(0)?.get_i64()? == i64::from(migration),
        "unsupported trie migration"
    );
    let g = footer.item(2);
    let keys = field(g.reader()?, "keys")?.get_vector()?;
    let values = field(g.reader()?, "values")?.get_vector()?;
    ensure!(
        keys.len() <= 255 && keys.len() == values.len(),
        "invalid trie group"
    );
    let m = footer.item(3);
    let edged = footer.item(4).owned()?;
    let state = if edged.is_null() {
        ensure!(m.owned()?.is_null(), "invalid trie nesting");
        None
    } else {
        let v = m.reader()?.get_vector()?;
        ensure!(v.len() <= 16, "invalid nibble slots");
        Some(edged.boolean()?)
    };
    Ok((header, g, m, state))
}
fn find_group(g: &View, k: &[u8]) -> Result<Option<View>> {
    let keys = field(g.reader()?, "keys")?.get_vector()?;
    let values = field(g.reader()?, "values")?.get_vector()?;
    ensure!(
        keys.len() == values.len() && keys.len() <= 255,
        "invalid key group"
    );
    let mut lo = 0;
    let mut hi = keys.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if keys.index(mid)?.get_blob()?.0 < k {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    Ok(if lo < keys.len() && keys.index(lo)?.get_blob()?.0 == k {
        Some(g.field("values").item(lo))
    } else {
        None
    })
}
fn lookup_inline<S: Storage>(
    basin: &mut Basin<S>,
    mut view: View,
    mut k: Vec<u8>,
    migration: u32,
    cached_only: bool,
) -> Result<Option<Option<View>>> {
    let mut depth = 0;
    loop {
        ensure!(depth < 256, "trie nesting limit");
        depth += 1;
        let (h, g, m, e) = parts(&view, migration)?;
        let prefix = if h.field("prefix")?.is_null() {
            &[][..]
        } else {
            h.field("prefix")?.blob()?
        };
        if !k.starts_with(prefix) {
            return Ok(Some(None));
        }
        k = k[prefix.len()..].to_vec();
        if let Some(found) = find_group(&g, &k)? {
            return Ok(Some(Some(found)));
        }
        if k.is_empty() || e.is_none() {
            return Ok(Some(None));
        }
        let high = (k[0] >> 4) as usize;
        let low = (k[0] & 15) as usize;
        let mm = m.reader()?.get_vector()?;
        if high >= mm.len()
            || mm.index(high)?.flexbuffer_type() == flexbuffers::FlexBufferType::Null
        {
            return Ok(Some(None));
        }
        let member = m.item(high);
        if member.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
            return find_group(&member, &k).map(Some);
        }
        let list = member.reader()?.get_vector()?;
        ensure!(list.len() <= 16, "invalid nibble slots");
        if low >= list.len()
            || list.index(low)?.flexbuffer_type() == flexbuffers::FlexBufferType::Null
        {
            return Ok(Some(None));
        }
        let child = member.item(low);
        k = k[1..].to_vec();
        if e == Some(true) {
            let edge = child.owned()?;
            let bounds = edge.at(5)?.field("keys")?;
            if bounds.is_null()
                || k.as_slice() < bounds.at(0)?.blob()?
                || k.as_slice() > bounds.at(1)?.blob()?
            {
                return Ok(Some(None));
            }
            view = View::root(if cached_only {
                if let Some(bytes) = basin.peek(&edge)? {
                    bytes
                } else {
                    return Ok(None);
                }
            } else {
                basin.load(&edge)?
            });
        } else {
            view = child;
        }
    }
}
pub fn get_inline<S: Storage>(
    basin: &mut Basin<S>,
    view: View,
    k: Vec<u8>,
    migration: u32,
) -> Result<Option<View>> {
    lookup_inline(basin, view, k, migration, false)?.context("unexpected deferred lookup")
}
/// None means deferred; Some(None) is a definitive absent key.
pub fn get_cached_inline<S: Storage>(
    basin: &mut Basin<S>,
    view: View,
    k: Vec<u8>,
    migration: u32,
) -> Result<Option<Option<View>>> {
    lookup_inline(basin, view, k, migration, true)
}
pub fn get_view<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    k: &[u8],
    migration: u32,
) -> Result<Option<View>> {
    validate_root(root, migration)?;
    let bounds = root.at(5)?.field("keys")?;
    if bounds.is_null() || k < bounds.at(0)?.blob()? || k > bounds.at(1)?.blob()? {
        return Ok(None);
    }
    let view = View::root(basin.load(root)?);
    get_inline(basin, view, k.to_vec(), migration)
}
pub fn get<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    k: &[u8],
    migration: u32,
) -> Result<Option<Value>> {
    get_view(basin, root, k, migration)?
        .map(|v| v.owned())
        .transpose()
}
fn intersects(base: &[u8], h: &Value, p: &[u8]) -> Result<bool> {
    let bounds = h.field("keys")?;
    if bounds.is_null() {
        return Ok(false);
    }
    let lo = [base, bounds.at(0)?.blob()?].concat();
    let hi = [base, bounds.at(1)?.blob()?].concat();
    if hi.as_slice() < p {
        return Ok(false);
    }
    let mut end = p.to_vec();
    for i in (0..end.len()).rev() {
        if end[i] < 255 {
            end[i] += 1;
            end.truncate(i + 1);
            return Ok(lo < end);
        }
    }
    Ok(true)
}
/// The callback can stop traversal before unrelated objects are fetched.
pub fn visit_inline<S: Storage>(
    basin: &mut Basin<S>,
    view: View,
    base: &[u8],
    prefix: &[u8],
    migration: u32,
    accept: &mut dyn FnMut(&Value, &Value) -> bool,
    emit: &mut dyn FnMut(Vec<u8>, View) -> Result<bool>,
) -> Result<bool> {
    visit_inner(
        basin,
        view,
        base,
        &Traversal { prefix, migration },
        accept,
        emit,
        0,
    )
}
struct Traversal<'a> {
    prefix: &'a [u8],
    migration: u32,
}
fn visit_inner<S: Storage>(
    basin: &mut Basin<S>,
    view: View,
    base: &[u8],
    traversal: &Traversal<'_>,
    accept: &mut dyn FnMut(&Value, &Value) -> bool,
    emit: &mut dyn FnMut(Vec<u8>, View) -> Result<bool>,
    depth: usize,
) -> Result<bool> {
    let prefix = traversal.prefix;
    let migration = traversal.migration;
    ensure!(depth < 256, "trie nesting limit");
    let (h, g, m, edged) = parts(&view, migration)?;
    let summary = view.field("6").item(1).owned()?;
    if !intersects(base, &h, prefix)? || !accept(&h, &summary) {
        return Ok(true);
    }
    let part = if h.field("prefix")?.is_null() {
        &[][..]
    } else {
        h.field("prefix")?.blob()?
    };
    let here = [base, part].concat();
    let emit_group =
        |group: &View, emit: &mut dyn FnMut(Vec<u8>, View) -> Result<bool>| -> Result<bool> {
            let keys = field(group.reader()?, "keys")?.get_vector()?;
            for i in 0..keys.len() {
                let key = [here.as_slice(), keys.index(i)?.get_blob()?.0].concat();
                if key.starts_with(prefix) && !emit(key, group.field("values").item(i))? {
                    return Ok(false);
                }
            }
            Ok(true)
        };
    if !emit_group(&g, emit)? {
        return Ok(false);
    }
    if let Some(edged) = edged {
        let members = m.reader()?.get_vector()?;
        for high in 0..members.len() {
            let member = m.item(high);
            let r = member.reader()?;
            if r.flexbuffer_type() == flexbuffers::FlexBufferType::Null {
                continue;
            }
            if r.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
                if !emit_group(&member, emit)? {
                    return Ok(false);
                }
                continue;
            }
            let nodes = r.get_vector()?;
            ensure!(nodes.len() <= 16, "invalid nibble slots");
            for low in 0..nodes.len() {
                if nodes.index(low)?.flexbuffer_type() == flexbuffers::FlexBufferType::Null {
                    continue;
                }
                let child = member.item(low);
                let next = [here.as_slice(), &[(high as u8) << 4 | low as u8]].concat();
                if edged {
                    let edge = child.owned()?;
                    if intersects(&next, edge.at(5)?, prefix)?
                        && accept(edge.at(5)?, edge.at(6)?.field("1")?)
                    {
                        let loaded = View::root(basin.load(&edge)?);
                        if !visit_inner(basin, loaded, &next, traversal, accept, emit, depth + 1)? {
                            return Ok(false);
                        }
                    }
                } else if !visit_inner(basin, child, &next, traversal, accept, emit, depth + 1)? {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}
pub fn visit<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    prefix: &[u8],
    migration: u32,
    accept: &mut dyn FnMut(&Value, &Value) -> bool,
    emit: &mut dyn FnMut(Vec<u8>, View) -> Result<bool>,
) -> Result<()> {
    validate_root(root, migration)?;
    if intersects(&[], root.at(5)?, prefix)? && accept(root.at(5)?, root.at(6)?.field("1")?) {
        let v = View::root(basin.load(root)?);
        visit_inline(basin, v, &[], prefix, migration, accept, emit)?;
    }
    Ok(())
}
pub fn entries<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    prefix: &[u8],
    migration: u32,
) -> Result<Vec<(Vec<u8>, Value)>> {
    let mut out = vec![];
    visit(
        basin,
        root,
        prefix,
        migration,
        &mut |_, _| true,
        &mut |k, v| {
            out.push((k, v.owned()?));
            Ok(true)
        },
    )?;
    Ok(out)
}
pub fn update<S: Storage, C: Consumer>(
    basin: &mut Basin<S>,
    root: &Edge,
    changes: Vec<(Vec<u8>, Option<Value>)>,
    c: &C,
) -> Result<Edge> {
    let mut rows = entries(basin, root, &[], c.migration())?
        .into_iter()
        .collect::<std::collections::BTreeMap<_, _>>();
    for (k, v) in changes {
        if let Some(v) = v {
            rows.insert(k, v);
        } else {
            rows.remove(&k);
        }
    }
    build(basin, rows.into_iter().collect(), c)
}

fn validate_root(root: &Edge, migration: u32) -> Result<()> {
    basin::validate_edge(root)?;
    ensure!(
        root.at(1)?.text()? == DOMAIN
            && root.at(2)?.text()? == PATH
            && root.at(6)?.field("0")?.number()? == migration,
        "unsupported trie species/migration"
    );
    Ok(())
}
