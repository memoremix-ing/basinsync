use crate::{
    Value,
    basin::{self, Basin, Edge, Storage},
    packed::{self, Built},
    trie::{Consumer, View},
};
use Value::*;
use anyhow::{Result, ensure};
use num_bigint::BigInt;
use std::collections::BTreeMap;
pub const PATH: &str = ".vector-node/";
#[derive(Clone)]
struct Row {
    index: BigInt,
    value: Value,
    summary: Value,
}
fn nonnegative(n: &BigInt) -> Result<()> {
    ensure!(n >= &BigInt::from(0), "invalid vector index");
    Ok(())
}
fn index_bytes(n: &BigInt) -> Vec<u8> {
    let (_, mut b) = n.to_bytes_be();
    if b.is_empty() {
        b.push(0)
    }
    b
}
fn make<S: Storage, C: Consumer>(
    b: &mut Basin<S>,
    rows: &[Row],
    base: &BigInt,
    span: &BigInt,
    shift: u32,
    bits: u32,
    c: &C,
) -> Result<Built> {
    let width = BigInt::from(1) << shift as usize;
    let mut bitmap = vec![0u8; ((1usize << bits) + 7) / 8];
    let mut children = vec![];
    let mut values = vec![];
    for slot in 0..(1u32 << bits) {
        let lo = base + &width * slot;
        let hi = &lo + &width;
        let part = rows
            .iter()
            .filter(|r| r.index >= lo && r.index < hi)
            .cloned()
            .collect::<Vec<_>>();
        if part.is_empty() {
            continue;
        }
        bitmap[slot as usize / 8] |= 1 << (slot % 8);
        if shift == 0 {
            values.push(part[0].value.clone());
        } else {
            let child_span = (span - &width * slot).min(width.clone());
            children.push(make(b, &part, &lo, &child_span, shift - bits, bits, c)?);
        }
    }
    let refs = values
        .iter()
        .map(|v| c.edges(v))
        .collect::<Result<Vec<_>>>()?
        .concat();
    let p = packed::pack(b, children, values.len(), refs)?;
    let summary = if rows.is_empty() {
        c.empty()
    } else {
        c.combine(&rows.iter().map(|r| r.summary.clone()).collect::<Vec<_>>())?
    };
    packed::built(
        b,
        PATH,
        Value::map([
            ("length", Big(span.clone())),
            ("count", Big(rows.len().into())),
            ("bits", bits.into()),
            ("shift", shift.into()),
            ("inlined", p.inlined.into()),
        ]),
        vec![
            c.migration().into(),
            summary,
            Blob(bitmap),
            Array(if shift == 0 { values } else { p.slots }),
        ],
        p.edges,
    )
}
pub fn build<S: Storage, C: Consumer>(b: &mut Basin<S>, values: Vec<Value>, c: &C) -> Result<Edge> {
    build_with_bits(b, values, c, 5)
}
pub fn build_with_bits<S: Storage, C: Consumer>(
    b: &mut Basin<S>,
    values: Vec<Value>,
    c: &C,
    bits: u32,
) -> Result<Edge> {
    let length = BigInt::from(values.len());
    build_entries_with_bits(
        b,
        length,
        values
            .into_iter()
            .enumerate()
            .map(|(i, v)| (i.into(), v))
            .collect(),
        c,
        bits,
    )
}
pub fn build_entries<S: Storage, C: Consumer>(
    b: &mut Basin<S>,
    length: BigInt,
    input: Vec<(BigInt, Value)>,
    c: &C,
) -> Result<Edge> {
    build_entries_with_bits(b, length, input, c, 5)
}
pub fn build_entries_with_bits<S: Storage, C: Consumer>(
    b: &mut Basin<S>,
    length: BigInt,
    input: Vec<(BigInt, Value)>,
    c: &C,
    bits: u32,
) -> Result<Edge> {
    let n = build_node_entries(b, length, input, c, bits)?;
    b.seal(n.node, &n.edges)
}
pub(crate) fn build_node_entries<S: Storage, C: Consumer>(
    b: &mut Basin<S>,
    length: BigInt,
    input: Vec<(BigInt, Value)>,
    c: &C,
    bits: u32,
) -> Result<Built> {
    ensure!((1..=8).contains(&bits), "vector bits must be 1..8");
    nonnegative(&length)?;
    let mut rows = input
        .into_iter()
        .map(|(i, v)| {
            nonnegative(&i)?;
            ensure!(i < length, "vector index outside length");
            Ok(Row {
                summary: c.entry(&index_bytes(&i), &v)?,
                index: i,
                value: v,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    rows.sort_by(|a, b| a.index.cmp(&b.index));
    ensure!(
        rows.windows(2).all(|w| w[0].index != w[1].index),
        "duplicate vector index"
    );
    let mut shift = 0;
    while length > (BigInt::from(1) << (shift + bits) as usize) {
        shift += bits;
        ensure!(shift / bits < 256, "vector nesting limit");
    }
    make(b, &rows, &0.into(), &length, shift, bits, c)
}
fn root(e: &Edge, migration: u32) -> Result<&Value> {
    basin::validate_edge(e)?;
    ensure!(
        e.at(1)?.text()? == basin::DOMAIN
            && e.at(2)?.text()? == PATH
            && e.at(6)?.field("0")?.number()? == migration,
        "unsupported vector migration"
    );
    e.at(5)
}
fn parts(v: &View, migration: u32) -> Result<(Value, Vec<u8>, View)> {
    basin::validate_node(v.reader()?, Some(PATH))?;
    let h = v.field("5").owned()?;
    let len = h.field("length")?.big()?;
    let count = h.field("count")?.big()?;
    let shift = h.field("shift")?.number()?;
    let bits = h.field("bits")?.number()?;
    ensure!(
        len >= 0.into()
            && count >= 0.into()
            && count <= len
            && (1..=8).contains(&bits)
            && shift % bits == 0
            && shift / bits < 256,
        "invalid vector header"
    );
    let f = v.field("6");
    ensure!(
        f.reader()?.get_vector()?.len() == 4 && f.item(0).owned()?.number()? == migration,
        "unsupported vector migration"
    );
    let bitmap = f.item(2).owned()?.blob()?.to_vec();
    ensure!(
        bitmap.len() == ((1usize << bits) + 7) / 8 && (bits >= 3 || bitmap[0] >> (1 << bits) == 0),
        "invalid vector bitmap length/bits"
    );
    let slots = f.item(3);
    ensure!(
        packed::plain_vector(slots.reader()?)
            && slots.reader()?.get_vector()?.len()
                == bitmap
                    .iter()
                    .map(|b| b.count_ones() as usize)
                    .sum::<usize>(),
        "invalid vector bitmap"
    );
    Ok((h, bitmap, slots))
}
pub fn get_view<S: Storage>(
    b: &mut Basin<S>,
    e: &Edge,
    index: &BigInt,
    migration: u32,
) -> Result<Option<View>> {
    nonnegative(index)?;
    let h = root(e, migration)?;
    if index >= &h.field("length")?.big()? || h.field("count")?.big()? == 0.into() {
        return Ok(None);
    }
    let v = View::root(b.load(e)?);
    get_inline(b, v, index, migration)
}
pub fn get_inline<S: Storage>(
    b: &mut Basin<S>,
    mut v: View,
    index: &BigInt,
    migration: u32,
) -> Result<Option<View>> {
    nonnegative(index)?;
    let (h, _, _) = parts(&v, migration)?;
    if index >= &h.field("length")?.big()? || h.field("count")?.big()? == 0.into() {
        return Ok(None);
    }
    let bits = h.field("bits")?.number()?;
    let mut local = index.clone();
    for _ in 0..256 {
        let (h, bitmap, slots) = parts(&v, migration)?;
        ensure!(
            h.field("bits")?.number()? == bits,
            "inconsistent vector bits"
        );
        let shift = h.field("shift")?.number()?;
        let slot = ((&local >> shift as usize) & BigInt::from((1u32 << bits) - 1))
            .to_u32_digits()
            .1
            .first()
            .copied()
            .unwrap_or(0);
        if bitmap[slot as usize / 8] & (1 << (slot % 8)) == 0 {
            return Ok(None);
        }
        let rank = rank(&bitmap, slot);
        let at = slots.item(rank);
        if shift == 0 {
            return Ok(Some(at));
        }
        local %= BigInt::from(1) << shift as usize;
        v = if at.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
            at
        } else {
            View::root(b.load(&at.owned()?)?)
        };
    }
    anyhow::bail!("vector nesting limit")
}
pub fn get<S: Storage>(
    b: &mut Basin<S>,
    e: &Edge,
    index: &BigInt,
    migration: u32,
) -> Result<Option<Value>> {
    get_view(b, e, index, migration)?
        .map(|v| v.owned())
        .transpose()
}
fn rank(bitmap: &[u8], slot: u32) -> usize {
    bitmap[..slot as usize / 8]
        .iter()
        .map(|b| b.count_ones() as usize)
        .sum::<usize>()
        + (bitmap[slot as usize / 8] & ((1u16 << (slot % 8)) - 1) as u8).count_ones() as usize
}
struct Walk<'a, S: Storage> {
    basin: &'a mut Basin<S>,
    from: &'a BigInt,
    to: &'a BigInt,
    migration: u32,
    bits: u32,
    accept: &'a mut dyn FnMut(&Value, &Value) -> bool,
    emit: &'a mut dyn FnMut(BigInt, View) -> Result<bool>,
}
impl<S: Storage> Walk<'_, S> {
    fn walk(&mut self, v: View, base: BigInt, depth: usize) -> Result<bool> {
        ensure!(depth < 256, "vector nesting limit");
        let (h, bitmap, slots) = parts(&v, self.migration)?;
        ensure!(
            h.field("bits")?.number()? == self.bits,
            "inconsistent vector bits"
        );
        if &base >= self.to
            || &base + h.field("length")?.big()? <= *self.from
            || h.field("count")?.big()? == 0.into()
            || !(self.accept)(&h, &v.field("6").item(1).owned()?)
        {
            return Ok(true);
        }
        let shift = h.field("shift")?.number()?;
        let width = BigInt::from(1) << shift as usize;
        for slot in 0..(1u32 << self.bits) {
            if bitmap[slot as usize / 8] & (1 << (slot % 8)) == 0 {
                continue;
            }
            let start = &base + &width * slot;
            if &start >= self.to || &start + &width <= *self.from {
                continue;
            }
            let rank = rank(&bitmap, slot);
            let at = slots.item(rank);
            if shift == 0 {
                if !(self.emit)(start, at)? {
                    return Ok(false);
                }
            } else {
                let next = if at.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
                    at
                } else {
                    let e = at.owned()?;
                    if !(self.accept)(e.at(5)?, e.at(6)?.field("1")?) {
                        continue;
                    }
                    View::root(self.basin.load(&e)?)
                };
                if !self.walk(next, start, depth + 1)? {
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
    range: (&BigInt, &BigInt),
    migration: u32,
    accept: &mut dyn FnMut(&Value, &Value) -> bool,
    emit: &mut dyn FnMut(BigInt, View) -> Result<bool>,
) -> Result<()> {
    let (from, to) = range;
    nonnegative(from)?;
    nonnegative(to)?;
    ensure!(to >= from, "invalid vector range");
    let h = root(e, migration)?;
    if from < to
        && from < &h.field("length")?.big()?
        && h.field("count")?.big()? > 0.into()
        && accept(h, e.at(6)?.field("1")?)
    {
        let v = View::root(b.load(e)?);
        Walk {
            basin: b,
            from,
            to,
            migration,
            bits: h.field("bits")?.number()?,
            accept,
            emit,
        }
        .walk(v, 0.into(), 0)?;
    }
    Ok(())
}
pub fn entries<S: Storage>(
    b: &mut Basin<S>,
    e: &Edge,
    migration: u32,
) -> Result<Vec<(BigInt, Value)>> {
    let length = root(e, migration)?.field("length")?.big()?;
    let mut rows = vec![];
    visit(
        b,
        e,
        (&0.into(), &length),
        migration,
        &mut |_, _| true,
        &mut |i, v| {
            rows.push((i, v.owned()?));
            Ok(true)
        },
    )?;
    Ok(rows)
}
pub fn update<S: Storage, C: Consumer>(
    b: &mut Basin<S>,
    e: &Edge,
    changes: Vec<(BigInt, Option<Value>)>,
    length: BigInt,
    c: &C,
) -> Result<Edge> {
    nonnegative(&length)?;
    let mut rows = entries(b, e, c.migration())?
        .into_iter()
        .filter(|(i, _)| i < &length)
        .collect::<BTreeMap<_, _>>();
    for (i, v) in changes {
        nonnegative(&i)?;
        ensure!(i < length, "vector index outside length");
        if let Some(v) = v {
            rows.insert(i, v);
        } else {
            rows.remove(&i);
        }
    }
    build_entries_with_bits(
        b,
        length,
        rows.into_iter().collect(),
        c,
        root(e, c.migration())?.field("bits")?.number()?,
    )
}

/// Summary-pruned reverse search; index and borrowed value of the last match.
fn lookup_last_inline<S: Storage>(
    b: &mut Basin<S>,
    v: View,
    migration: u32,
    accept: &mut dyn FnMut(&Value) -> bool,
    prune: &mut dyn FnMut(&Value) -> bool,
    cached_only: bool,
) -> Result<Option<Option<(BigInt, View)>>> {
    fn walk<S: Storage>(
        b: &mut Basin<S>,
        v: View,
        base: BigInt,
        depth: usize,
        migration: u32,
        accept: &mut dyn FnMut(&Value) -> bool,
        prune: &mut dyn FnMut(&Value) -> bool,
        cached_only: bool,
    ) -> Result<Option<Option<(BigInt, View)>>> {
        ensure!(depth < 256, "vector nesting limit");
        let (h, bitmap, slots) = parts(&v, migration)?;
        if h.field("count")?.big()? == 0.into() || !prune(&v.field("6").item(1).owned()?) {
            return Ok(Some(None));
        }
        let shift = h.field("shift")?.number()?;
        let bits = h.field("bits")?.number()?;
        for slot in (0..(1u32 << bits)).rev() {
            if bitmap[slot as usize / 8] & (1 << (slot % 8)) == 0 {
                continue;
            }
            let at = slots.item(rank(&bitmap, slot));
            let index = &base + (BigInt::from(slot) << shift as usize);
            if shift == 0 {
                if accept(&at.owned()?) {
                    return Ok(Some(Some((index, at))));
                }
            } else {
                let child = if at.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
                    at
                } else {
                    let e = at.owned()?;
                    if !prune(e.at(6)?.field("1")?) {
                        continue;
                    }
                    View::root(if cached_only {
                        if let Some(bytes) = b.peek(&e)? {
                            bytes
                        } else {
                            return Ok(None);
                        }
                    } else {
                        b.load(&e)?
                    })
                };
                let found = walk(
                    b,
                    child,
                    index,
                    depth + 1,
                    migration,
                    accept,
                    prune,
                    cached_only,
                )?;
                match found {
                    None => return Ok(None),
                    Some(Some(found)) => return Ok(Some(Some(found))),
                    Some(None) => {}
                }
            }
        }
        Ok(Some(None))
    }
    walk(b, v, 0.into(), 0, migration, accept, prune, cached_only)
}

pub fn find_last_inline<S: Storage>(
    b: &mut Basin<S>,
    v: View,
    migration: u32,
    accept: &mut dyn FnMut(&Value) -> bool,
    prune: &mut dyn FnMut(&Value) -> bool,
) -> Result<Option<(BigInt, View)>> {
    use anyhow::Context;
    lookup_last_inline(b, v, migration, accept, prune, false)?
        .context("unexpected deferred reverse search")
}
pub fn find_last_cached_inline<S: Storage>(
    b: &mut Basin<S>,
    v: View,
    migration: u32,
    accept: &mut dyn FnMut(&Value) -> bool,
    prune: &mut dyn FnMut(&Value) -> bool,
) -> Result<Option<Option<(BigInt, View)>>> {
    lookup_last_inline(b, v, migration, accept, prune, true)
}
