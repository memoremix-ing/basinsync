use crate::{
    Value,
    basin::{self, Basin, Edge, Storage},
    packed::{self, Built},
    trie::{Consumer, View},
};
use Value::*;
use anyhow::{Result, ensure};
use std::collections::BTreeMap;
pub const PATH: &str = ".btree-node/";
#[derive(Clone)]
struct Row {
    key: Vec<u8>,
    value: Value,
    summary: Value,
}
fn capacity(depth: usize) -> usize {
    (0..=depth)
        .fold(1usize, |n, _| n.saturating_mul(32))
        .saturating_sub(1)
}
fn make<S: Storage, C: Consumer>(
    b: &mut Basin<S>,
    rows: &[Row],
    depth: usize,
    is_root: bool,
    c: &C,
) -> Result<Built> {
    let mut own = vec![];
    let mut children = vec![];
    if depth == 0 {
        own.extend_from_slice(rows)
    } else {
        let count =
            (if is_root { 2 } else { 16 }).max((rows.len() + 1).div_ceil(capacity(depth - 1) + 1));
        let left = rows.len() - count + 1;
        let (base, extra) = (left / count, left % count);
        let mut at = 0;
        for i in 0..count {
            let n = base + usize::from(i < extra);
            children.push(make(b, &rows[at..at + n], depth - 1, false, c)?);
            at += n;
            if i + 1 < count {
                own.push(rows[at].clone());
                at += 1;
            }
        }
        ensure!(at == rows.len(), "B-tree partition mismatch");
    }
    let refs = own
        .iter()
        .map(|r| c.edges(&r.value))
        .collect::<Result<Vec<_>>>()?
        .concat();
    let p = packed::pack(b, children, own.len(), refs)?;
    let summary = if rows.is_empty() {
        c.empty()
    } else {
        c.combine(&rows.iter().map(|r| r.summary.clone()).collect::<Vec<_>>())?
    };
    packed::built(
        b,
        PATH,
        Value::map([
            ("count", Big(rows.len().into())),
            ("depth", depth.into()),
            ("inlined", p.inlined.into()),
            (
                "keys",
                if rows.is_empty() {
                    Null
                } else {
                    Array(vec![
                        Blob(rows.first().unwrap().key.clone()),
                        Blob(rows.last().unwrap().key.clone()),
                    ])
                },
            ),
        ]),
        vec![
            c.migration().into(),
            summary,
            Array(own.iter().map(|r| Blob(r.key.clone())).collect()),
            Array(own.into_iter().map(|r| r.value).collect()),
            if depth == 0 { Null } else { Array(p.slots) },
        ],
        p.edges,
    )
}
pub fn build<S: Storage, C: Consumer>(
    b: &mut Basin<S>,
    input: Vec<(Vec<u8>, Value)>,
    c: &C,
) -> Result<Edge> {
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
        rows.windows(2).all(|w| w[0].key != w[1].key),
        "duplicate B-tree key"
    );
    let mut depth = 0;
    while rows.len() > capacity(depth) {
        depth += 1
    }
    let n = make(b, &rows, depth, true, c)?;
    b.seal(n.node, &n.edges)
}
fn root(e: &Edge, migration: u32) -> Result<&Value> {
    basin::validate_edge(e)?;
    ensure!(
        e.at(1)?.text()? == basin::DOMAIN
            && e.at(2)?.text()? == PATH
            && e.at(6)?.field("0")?.number()? == migration,
        "unsupported B-tree migration"
    );
    e.at(5)
}
fn includes(h: &Value, key: &[u8]) -> Result<bool> {
    let bounds = h.field("keys")?;
    Ok(!bounds.is_null() && bounds.at(0)?.blob()? <= key && key <= bounds.at(1)?.blob()?)
}
fn parts(v: &View, migration: u32) -> Result<(Value, View, View, View)> {
    basin::validate_node(v.reader()?, Some(PATH))?;
    let h = v.field("5").owned()?;
    let depth = h.field("depth")?.number()?;
    ensure!(
        depth < 256 && h.field("count")?.big()? >= 0.into(),
        "invalid B-tree header"
    );
    let f = v.field("6");
    ensure!(
        f.reader()?.get_vector()?.len() == 5 && f.item(0).owned()?.number()? == migration,
        "unsupported B-tree migration"
    );
    let keys = f.item(2);
    let values = f.item(3);
    let children = f.item(4);
    let n = keys.reader()?.get_vector()?.len();
    ensure!(
        packed::plain_vector(keys.reader()?)
            && packed::plain_vector(values.reader()?)
            && n <= 31
            && n == values.reader()?.get_vector()?.len()
            && if depth == 0 {
                children.owned()?.is_null()
            } else {
                packed::plain_vector(children.reader()?)
                    && children.reader()?.get_vector()?.len() == n + 1
            },
        "invalid B-tree node"
    );
    Ok((h, keys, values, children))
}
pub fn get_view<S: Storage>(
    b: &mut Basin<S>,
    e: &Edge,
    key: &[u8],
    migration: u32,
) -> Result<Option<View>> {
    if !includes(root(e, migration)?, key)? {
        return Ok(None);
    }
    let mut v = View::root(b.load(e)?);
    for _ in 0..256 {
        let (_, keys, values, children) = parts(&v, migration)?;
        let ks = keys.reader()?.get_vector()?;
        let (mut lo, mut hi) = (0, ks.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if ks.index(mid)?.get_blob()?.0 < key {
                lo = mid + 1
            } else {
                hi = mid
            }
        }
        if lo < ks.len() && ks.index(lo)?.get_blob()?.0 == key {
            return Ok(Some(values.item(lo)));
        }
        if children.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Null {
            return Ok(None);
        }
        let next = children.item(lo);
        v = if next.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
            next
        } else {
            let edge = next.owned()?;
            if !includes(edge.at(5)?, key)? {
                return Ok(None);
            }
            View::root(b.load(&edge)?)
        };
    }
    anyhow::bail!("B-tree nesting limit")
}
pub fn get<S: Storage>(
    b: &mut Basin<S>,
    e: &Edge,
    key: &[u8],
    migration: u32,
) -> Result<Option<Value>> {
    get_view(b, e, key, migration)?
        .map(|v| v.owned())
        .transpose()
}
fn intersects(h: &Value, lo: &[u8], hi: Option<&[u8]>) -> Result<bool> {
    let r = h.field("keys")?;
    Ok(!r.is_null()
        && r.at(1)?.blob()? >= lo
        && hi.is_none_or(|hi| r.at(0).and_then(Value::blob).is_ok_and(|v| v < hi)))
}
struct Walk<'a, S: Storage> {
    basin: &'a mut Basin<S>,
    lo: &'a [u8],
    hi: Option<&'a [u8]>,
    migration: u32,
    accept: &'a mut dyn FnMut(&Value, &Value) -> bool,
    emit: &'a mut dyn FnMut(Vec<u8>, View) -> Result<bool>,
}
impl<S: Storage> Walk<'_, S> {
    fn walk(&mut self, v: View, depth: usize) -> Result<bool> {
        ensure!(depth < 256, "B-tree nesting limit");
        let (h, keys, values, children) = parts(&v, self.migration)?;
        if !intersects(&h, self.lo, self.hi)? || !(self.accept)(&h, &v.field("6").item(1).owned()?)
        {
            return Ok(true);
        }
        let n = keys.reader()?.get_vector()?.len();
        let leaf = children.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Null;
        for i in 0..=n {
            if !leaf {
                let at = children.item(i);
                let next = if at.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
                    Some(at)
                } else {
                    let e = at.owned()?;
                    if intersects(e.at(5)?, self.lo, self.hi)?
                        && (self.accept)(e.at(5)?, e.at(6)?.field("1")?)
                    {
                        Some(View::root(self.basin.load(&e)?))
                    } else {
                        None
                    }
                };
                if let Some(next) = next
                    && !self.walk(next, depth + 1)?
                {
                    return Ok(false);
                }
            }
            if i < n {
                let k = keys.item(i).owned()?.blob()?.to_vec();
                if k.as_slice() >= self.lo
                    && self.hi.is_none_or(|hi| k.as_slice() < hi)
                    && !(self.emit)(k, values.item(i))?
                {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
}
pub fn visit<S: Storage>(
    b: &mut Basin<S>,
    e: &Edge,
    range: (&[u8], Option<&[u8]>),
    migration: u32,
    accept: &mut dyn FnMut(&Value, &Value) -> bool,
    emit: &mut dyn FnMut(Vec<u8>, View) -> Result<bool>,
) -> Result<()> {
    let (lo, hi) = range;
    ensure!(hi.is_none_or(|hi| lo <= hi), "invalid B-tree range");
    let h = root(e, migration)?;
    if intersects(h, lo, hi)? && accept(h, e.at(6)?.field("1")?) {
        let v = View::root(b.load(e)?);
        Walk {
            basin: b,
            lo,
            hi,
            migration,
            accept,
            emit,
        }
        .walk(v, 0)?;
    }
    Ok(())
}
pub fn entries<S: Storage>(
    b: &mut Basin<S>,
    e: &Edge,
    migration: u32,
) -> Result<Vec<(Vec<u8>, Value)>> {
    let mut rows = vec![];
    visit(
        b,
        e,
        (&[], None),
        migration,
        &mut |_, _| true,
        &mut |k, v| {
            rows.push((k, v.owned()?));
            Ok(true)
        },
    )?;
    Ok(rows)
}
pub fn update<S: Storage, C: Consumer>(
    b: &mut Basin<S>,
    e: &Edge,
    changes: Vec<(Vec<u8>, Option<Value>)>,
    c: &C,
) -> Result<Edge> {
    let mut rows = entries(b, e, c.migration())?
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    for (k, v) in changes {
        if let Some(v) = v {
            rows.insert(k, v);
        } else {
            rows.remove(&k);
        }
    }
    build(b, rows.into_iter().collect(), c)
}
