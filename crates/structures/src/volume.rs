use crate::{
    Value,
    basin::{self, Basin, DOMAIN, Edge, Storage},
    bromberg, packed,
    trie::{self, Consumer, View},
    value, vector,
};
use Value::*;
use anyhow::{Context, Result, ensure};
use std::collections::{BTreeMap, BTreeSet};
pub const PATH: &str = ".sync-volume/";
pub const BLOCK: &str = ".sync-block/";
pub const PAGE_SIZE: usize = 4096;
pub struct Sectors;
impl Consumer for Sectors {
    fn empty(&self) -> Value {
        Value::map([("brombergSL2", Blob(bromberg::bytes(bromberg::IDENTITY)))])
    }
    fn entry(&self, _: &[u8], v: &Value) -> Result<Value> {
        ensure!(v.array()?.len() == 1, "invalid page");
        Ok(Value::map([(
            "brombergSL2",
            Blob(bromberg::hash(v.at(0)?.blob()?)),
        )]))
    }
    fn combine(&self, s: &[Value]) -> Result<Value> {
        let parts = s
            .iter()
            .map(|v| Ok(v.field("brombergSL2")?.blob()?.to_vec()))
            .collect::<Result<Vec<_>>>()?;
        Ok(Value::map([(
            "brombergSL2",
            Blob(bromberg::combine(&parts)?),
        )]))
    }
}
pub struct Devices;
impl Consumer for Devices {
    fn empty(&self) -> Value {
        Null
    }
    fn entry(&self, _: &[u8], _: &Value) -> Result<Value> {
        Ok(Null)
    }
    fn combine(&self, _: &[Value]) -> Result<Value> {
        Ok(Null)
    }
    fn edges(&self, v: &Value) -> Result<Vec<Edge>> {
        ensure!(v.array()?.len() == 1, "invalid device value");
        basin::validate_edge(v.at(0)?)?;
        Ok(vec![v.at(0)?.clone()])
    }
}
pub fn lex(n: &num_bigint::BigInt) -> Result<String> {
    ensure!(n.sign() != num_bigint::Sign::Minus, "negative page");
    let digits = format!("{n:x}");
    let s = format!("{:x}", digits.len() - 1);
    let width = s.len().next_power_of_two();
    ensure!(width <= 16, "page encoding overflow");
    let magnitude = if width == 1 {
        String::new()
    } else {
        "wxyz"
            .chars()
            .nth(width.ilog2() as usize - 1)
            .unwrap()
            .to_string()
    };
    let size = format!("{s:0>width$}")
        .bytes()
        .map(|b| {
            char::from(
                b'g' + if b.is_ascii_digit() {
                    b - b'0'
                } else {
                    b - b'a' + 10
                },
            )
        })
        .collect::<String>();
    Ok(format!("0z{magnitude}{size}{digits}"))
}
pub fn unlex(s: &str) -> Result<num_bigint::BigInt> {
    ensure!(s.starts_with("0z"), "invalid page key");
    let b = s.as_bytes();
    ensure!(b.len() >= 4, "truncated page key");
    let (mut at, mut width) = (2, 1);
    if let Some(m) = b"wxyz".iter().position(|v| *v == b[at]) {
        width = 1 << (1 + m);
        at += 1;
    }
    ensure!(at + width < s.len(), "truncated page size");
    let mut size = 0usize;
    for c in &b[at..at + width] {
        ensure!((b'g'..=b'v').contains(c), "invalid page size");
        size = size
            .checked_mul(16)
            .and_then(|v| v.checked_add((c - b'g') as usize))
            .context("page size overflow")?;
    }
    let h = &s[at + width..];
    ensure!(
        size.checked_add(1) == Some(h.len())
            && h.bytes()
                .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)),
        "invalid page payload"
    );
    let n = num_bigint::BigInt::parse_bytes(h.as_bytes(), 16).context("invalid page")?;
    ensure!(lex(&n)? == s, "noncanonical page key");
    Ok(n)
}
fn path(name: &str) -> Result<Vec<&str>> {
    ensure!(
        name.starts_with('/') && !name.contains('\0'),
        "invalid absolute pathname"
    );
    let p = name[1..].split('/').collect::<Vec<_>>();
    ensure!(
        p.iter().all(|n| !n.is_empty() && *n != "." && *n != ".."),
        "invalid pathname component"
    );
    Ok(p)
}
fn framed(b: &[u8]) -> Result<Vec<u8>> {
    Ok([u32::try_from(b.len())?.to_le_bytes().as_slice(), b].concat())
}
fn directory(contents: BTreeMap<String, Value>) -> Result<Value> {
    let mut bytes = vec![];
    for (name, v) in &contents {
        bytes.extend(framed(name.as_bytes())?);
        bytes.push(u8::from(v.at(0)?.boolean()?));
        bytes.extend(framed(v.at(1)?.blob()?)?);
    }
    Ok(Array(vec![
        Bool(true),
        Blob(basin::sha384(&bytes)),
        Map(contents),
    ]))
}
enum Tree {
    Directory(BTreeMap<String, Tree>),
    File(Value),
}
fn insert(tree: &mut BTreeMap<String, Tree>, parts: &[&str], v: Value) -> Result<()> {
    if parts.len() == 1 {
        ensure!(!tree.contains_key(parts[0]), "file/directory collision");
        tree.insert(parts[0].into(), Tree::File(v));
    } else {
        let entry = tree
            .entry(parts[0].into())
            .or_insert_with(|| Tree::Directory(BTreeMap::new()));
        let Tree::Directory(next) = entry else {
            anyhow::bail!("file/directory collision")
        };
        insert(next, &parts[1..], v)?;
    }
    Ok(())
}
fn finish(t: BTreeMap<String, Tree>) -> Result<Value> {
    directory(
        t.into_iter()
            .map(|(k, v)| {
                Ok((
                    k,
                    match v {
                        Tree::File(v) => v,
                        Tree::Directory(d) => finish(d)?,
                    },
                ))
            })
            .collect::<Result<_>>()?,
    )
}
fn collect<S: Storage>(
    basin: &mut Basin<S>,
    n: &Value,
    base: &[u8],
    leaves: &mut Vec<Value>,
) -> Result<()> {
    let h = n.index(5)?;
    let p = if h.field("prefix")?.is_null() {
        &[][..]
    } else {
        h.field("prefix")?.blob()?
    };
    let here = [base, p].concat();
    let m = n.index(6)?.at(3)?;
    if m.is_null() {
        return Ok(());
    }
    for (high, m) in m.array()?.iter().enumerate() {
        if let Array(children) = m {
            for (low, ch) in children.iter().enumerate() {
                if ch.is_null() {
                    continue;
                }
                let next = [here.as_slice(), &[(high as u8) << 4 | low as u8]].concat();
                if matches!(ch, Array(_)) {
                    let h = ch.at(5)?;
                    if ch.at(3)?.field("degree")?.number()? == 0 && !h.field("keys")?.is_null() {
                        let keys = h.field("keys")?;
                        let lo = unlex(std::str::from_utf8(
                            &[next.as_slice(), keys.at(0)?.blob()?].concat(),
                        )?)?;
                        let hi = unlex(std::str::from_utf8(
                            &[next.as_slice(), keys.at(1)?.blob()?].concat(),
                        )?)? + 1;
                        let span: &num_bigint::BigInt = &(&hi - &lo);
                        if let Ok(n) = u32::try_from(span.clone()) {
                            leaves.push(Array(vec![Big(lo), n.into(), basin::weak(ch)?]));
                        }
                    } else {
                        let bytes = basin.load(ch)?;
                        let node = value::read(basin::node_reader(&bytes)?)?;
                        collect(basin, &node, &next, leaves)?;
                    }
                } else {
                    collect(basin, ch, &next, leaves)?;
                }
            }
        }
    }
    Ok(())
}
pub fn build<S: Storage>(basin: &mut Basin<S>, files: Vec<(String, Vec<u8>)>) -> Result<Edge> {
    build_with_directories(basin, files, vec![])
}
fn make_directory(tree: &mut BTreeMap<String, Tree>, parts: &[&str]) -> Result<()> {
    if parts.is_empty() {
        return Ok(());
    }
    let item = tree
        .entry(parts[0].into())
        .or_insert_with(|| Tree::Directory(BTreeMap::new()));
    let Tree::Directory(child) = item else {
        anyhow::bail!("file/directory collision")
    };
    make_directory(child, &parts[1..])
}
#[derive(Clone)]
pub struct BlockRoot {
    pub edge: Edge,
    pub digest: Vec<u8>,
}
pub fn build_block<S: Storage>(
    basin: &mut Basin<S>,
    input: Vec<(num_bigint::BigInt, Vec<u8>)>,
) -> Result<BlockRoot> {
    let pages = input
        .into_iter()
        .map(|(n, b)| Ok((lex(&n)?.into_bytes(), Array(vec![Blob(b)]))))
        .collect::<Result<Vec<_>>>()?;
    let t = trie::build_node(basin, pages, &Sectors)?;
    let mut leaves = vec![];
    collect(basin, &t.node, &[], &mut leaves)?;
    leaves.sort_by_key(|v| v.at(0).and_then(Value::big).unwrap());
    let digest = t.node.index(6)?.at(1)?.field("brombergSL2")?.clone();
    let count = leaves.len();
    let shortcuts = vector::build_node_entries(
        basin,
        count.into(),
        leaves
            .into_iter()
            .enumerate()
            .map(|(i, v)| (i.into(), v))
            .collect(),
        &trie::Plain,
        7,
    )?;
    let mut p = packed::pack(
        basin,
        vec![
            packed::Built {
                node: t.node,
                edges: t.edges,
            },
            shortcuts,
        ],
        0,
        vec![],
    )?;
    let trailing = p.slots.pop().unwrap();
    let pages = p.slots.pop().unwrap();
    let leading = vector_spine(basin, &trailing, false)?;
    let lagging = vector_spine(basin, &trailing, true)?;
    let node = Value::map([
        ("0", Symbol("species".into())),
        ("1", DOMAIN.into()),
        ("2", BLOCK.into()),
        (
            "3",
            basin::query(&p.edges, basin.max_degree, basin.max_height)?,
        ),
        ("4", 0u32.into()),
        ("5", Null),
        (
            "6",
            Array(vec![0u32.into(), Null, pages, trailing, leading, lagging]),
        ),
    ]);
    let edge = basin.seal(node, &p.edges)?;
    Ok(BlockRoot {
        edge,
        digest: digest.blob()?.to_vec(),
    })
}
fn vector_spine<S: Storage>(basin: &mut Basin<S>, root: &Value, last: bool) -> Result<Value> {
    let mut node = root.clone();
    if matches!(node, Array(_)) {
        node = View::root(basin.load(&node)?).owned()?;
    }
    let mut spine = vec![Null; node.index(3)?.field("height")?.number()? as usize];
    for _ in 0..256 {
        if node.index(5)?.field("shift")?.number()? == 0
            || node.index(5)?.field("count")?.big()? == 0.into()
        {
            return Ok(Array(spine));
        }
        let slots = node.index(6)?.at(3)?.array()?;
        let child = slots[if last { slots.len() - 1 } else { 0 }].clone();
        node = if matches!(child, Array(_)) {
            spine[child.at(3)?.field("height")?.number()? as usize] = basin::weak(&child)?;
            View::root(basin.load(&child)?).owned()?
        } else {
            child
        };
    }
    anyhow::bail!("vector nesting limit")
}
fn page_root<S: Storage>(basin: &mut Basin<S>, footer: &View) -> Result<View> {
    let pages = footer.item(2);
    if pages.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
        Ok(pages)
    } else {
        Ok(View::root(basin.load(&pages.owned()?)?))
    }
}
pub fn build_with_directories<S: Storage>(
    basin: &mut Basin<S>,
    files: Vec<(String, Vec<u8>)>,
    directories: Vec<String>,
) -> Result<Edge> {
    let blocks = files
        .into_iter()
        .map(|(name, data)| {
            path(&name)?;
            let pages = data
                .chunks(PAGE_SIZE)
                .enumerate()
                .map(|(i, b)| (i.into(), b.to_vec()))
                .collect();
            Ok((name, build_block(basin, pages)?))
        })
        .collect::<Result<Vec<_>>>()?;
    from_blocks(basin, blocks, directories)
}
pub fn from_blocks<S: Storage>(
    basin: &mut Basin<S>,
    blocks: Vec<(String, BlockRoot)>,
    directories: Vec<String>,
) -> Result<Edge> {
    let mut file_map = BTreeMap::new();
    for (name, block) in blocks {
        path(&name)?;
        ensure!(!file_map.contains_key(&name), "duplicate pathname");
        ensure!(
            block.edge.at(2)?.text()? == BLOCK && block.digest.len() == 64,
            "invalid block descriptor"
        );
        file_map.insert(name, (block.edge, Blob(block.digest)));
    }
    let device = trie::build_node(
        basin,
        file_map
            .iter()
            .map(|(name, (e, _))| (name.as_bytes().to_vec(), Array(vec![e.clone()])))
            .collect(),
        &Devices,
    )?;
    let mut tree = BTreeMap::new();
    for dir in directories {
        if dir != "/" {
            make_directory(&mut tree, &path(&dir)?)?;
        }
    }
    for (name, (edge, digest)) in &file_map {
        insert(
            &mut tree,
            &path(name)?,
            Array(vec![Bool(false), digest.clone(), basin::weak(edge)?]),
        )?;
    }
    let root = finish(tree)?;
    let node = Value::map([
        ("0", Symbol("species".into())),
        ("1", DOMAIN.into()),
        ("2", PATH.into()),
        ("3", device.node.index(3)?.clone()),
        ("4", 0u32.into()),
        ("5", Null),
        ("6", Array(vec![0u32.into(), Null, device.node, root])),
    ]);
    basin.seal(node, &device.edges)
}
fn data<S: Storage>(basin: &mut Basin<S>, root: &Edge) -> Result<View> {
    let v = View::root(basin.load(root)?);
    basin::validate_node(v.reader()?, Some(PATH))?;
    let footer = v.field("6");
    ensure!(
        footer.reader()?.get_vector()?.len() == 4
            && value::item(footer.reader()?, 0)?.get_i64()? == 0,
        "unsupported volume migration"
    );
    Ok(footer)
}
pub fn list<S: Storage>(basin: &mut Basin<S>, root: &Edge, name: &str) -> Result<Vec<String>> {
    let d = data(basin, root)?;
    let mut value = d.item(3).owned()?;
    if name != "/" {
        for p in path(name)? {
            ensure!(value.at(0)?.boolean()?, "not a directory");
            value = value.at(2)?.field(p)?.clone();
        }
    }
    ensure!(value.at(0)?.boolean()?, "not a directory");
    Ok(value.at(2)?.map_ref()?.keys().cloned().collect())
}
fn open_block<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    name: &str,
    shortcuts: bool,
) -> Result<(View, Vec<u8>)> {
    let f = data(basin, root)?;
    let mut file = f.item(3).owned()?;
    for p in path(name)? {
        ensure!(file.at(0)?.boolean()?, "not a directory");
        file = file.at(2)?.field(p)?.clone();
    }
    ensure!(!file.at(0)?.boolean()?, "not a file");
    let expected = file.at(1)?.blob()?.to_vec();
    let mut edge = None;
    if shortcuts
        && let Ok(Some(candidate)) = basin.storage.resolve(file.at(2)?)
        && basin::capability(&candidate)? == basin::weak_key(file.at(2)?)?
        && let Ok(bytes) = basin.load(&candidate)
    {
        let b = View::root(bytes);
        if basin::validate_node(b.reader()?, Some(BLOCK)).is_ok() {
            let digest = page_root(basin, &b.field("6"))?
                .field("6")
                .item(1)
                .field("brombergSL2")
                .owned()?;
            if digest.blob()? == expected {
                edge = Some(candidate);
            }
        }
    }
    let edge = if let Some(edge) = edge {
        edge
    } else {
        let found = trie::get_inline(basin, f.item(2), name.as_bytes().to_vec(), 0)?
            .context("missing retained block")?
            .owned()?;
        found.at(0)?.clone()
    };
    let block = View::root(basin.load(&edge)?);
    basin::validate_node(block.reader()?, Some(BLOCK))?;
    let footer = block.field("6");
    ensure!(
        footer.reader()?.get_vector()?.len() == 6
            && value::item(footer.reader()?, 0)?.get_i64()? == 0,
        "unsupported block migration"
    );
    ensure!(
        page_root(basin, &footer)?
            .field("6")
            .item(1)
            .field("brombergSL2")
            .owned()?
            .blob()?
            == expected,
        "block summary mismatch"
    );
    Ok((footer, expected))
}
pub fn read<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    name: &str,
    shortcuts: bool,
) -> Result<Vec<u8>> {
    let (footer, expected) = open_block(basin, root, name, shortcuts)?;
    let mut pages = vec![];
    let pages_root = page_root(basin, &footer)?;
    trie::visit_inline(
        basin,
        pages_root,
        &[],
        &[],
        0,
        &mut |_, _| true,
        &mut |k, v| {
            let n = unlex(std::str::from_utf8(&k)?)?;
            let value = v.owned()?;
            let blob = value.at(0)?.blob()?;
            ensure!(
                value.array()?.len() == 1 && !blob.is_empty() && blob.len() <= PAGE_SIZE,
                "invalid page"
            );
            pages.push((n, blob.to_vec()));
            Ok(true)
        },
    )?;
    let mut end = 0usize;
    for (p, b) in &pages {
        let pos = usize::try_from(p.clone())?
            .checked_mul(PAGE_SIZE)
            .context("file offset overflow")?;
        end = end.max(pos.checked_add(b.len()).context("file length overflow")?);
    }
    ensure!(end <= basin.max_bytes, "file read byte limit");
    let mut bytes = vec![0; end];
    for (p, b) in pages {
        let at = usize::try_from(p)? * PAGE_SIZE;
        bytes[at..at + b.len()].copy_from_slice(&b);
    }
    ensure!(bromberg::hash(&bytes) == expected, "file checksum mismatch");
    Ok(bytes)
}
fn shortcut_record<S: Storage>(
    basin: &mut Basin<S>,
    root: &View,
    index: &num_bigint::BigInt,
) -> Result<View> {
    if root.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
        vector::get_inline(basin, root.clone(), index, 0)?.context("shortcut vector hole")
    } else {
        vector::get_view(basin, &root.owned()?, index, 0)?.context("shortcut vector hole")
    }
}
fn shortcut_page<S: Storage>(
    basin: &mut Basin<S>,
    leaves: &View,
    page: &num_bigint::BigInt,
    full: &[u8],
) -> Result<Option<Value>> {
    let edge = leaves.owned()?;
    let header = if matches!(edge, Array(_)) {
        edge.at(5)?
    } else {
        edge.index(5)?
    };
    ensure!(
        header.field("bits")?.number()? == 7,
        "invalid shortcut vector"
    );
    let length = header.field("length")?.big()?;
    let mut lo = num_bigint::BigInt::from(0);
    let mut hi = length;
    while lo < hi {
        let mid = (&lo + &hi) >> 1usize;
        let record = shortcut_record(basin, leaves, &mid)?;
        let start = record.item(0).owned()?.big()?;
        if start <= *page {
            lo = mid + 1u32;
        } else {
            hi = mid;
        }
    }
    if lo == 0.into() {
        return Ok(None);
    }
    let record = shortcut_record(basin, leaves, &(lo - 1u32))?;
    let low = record.item(0).owned()?.big()?;
    let span = record.item(1).owned()?.number()?;
    if page >= &(&low + span) {
        return Ok(None);
    }
    let link = record.item(2).owned()?;
    let Some(edge) = basin.storage.resolve(&link)? else {
        return Ok(None);
    };
    ensure!(
        basin::capability(&edge)? == basin::weak_key(&link)?,
        "shortcut capability mismatch"
    );
    let view = View::root(basin.load(&edge)?);
    basin::validate_node(view.reader()?, Some(trie::PATH))?;
    let header = view.field("5").owned()?;
    let keys = header.field("keys")?;
    if keys.is_null() {
        return Ok(None);
    }
    let minimum = lex(&low)?.into_bytes();
    let suffix = keys.at(0)?.blob()?;
    ensure!(minimum.len() >= suffix.len(), "invalid shortcut prefix");
    let base = &minimum[..minimum.len() - suffix.len()];
    ensure!(
        [base, suffix].concat() == minimum
            && [base, keys.at(1)?.blob()?].concat() == lex(&(&low + span - 1u32))?.into_bytes(),
        "shortcut span mismatch"
    );
    if !full.starts_with(base) {
        return Ok(None);
    }
    trie::get_inline(basin, view, full[base.len()..].to_vec(), 0)?
        .map(|v| v.owned())
        .transpose()
}
/// Read a raw sparse page, independently of file byte-offset conventions.
pub fn page<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    name: &str,
    index: &num_bigint::BigInt,
    shortcuts: bool,
) -> Result<Option<Vec<u8>>> {
    let (footer, _) = open_block(basin, root, name, shortcuts)?;
    let full = lex(index)?.into_bytes();
    let found = if shortcuts {
        shortcut_page(basin, &footer.item(3), index, &full)
            .ok()
            .flatten()
    } else {
        None
    };
    let value = if let Some(v) = found {
        Some(v)
    } else {
        let pages_root = page_root(basin, &footer)?;
        trie::get_inline(basin, pages_root, full, 0)?
            .map(|v| v.owned())
            .transpose()?
    };
    value
        .map(|v| {
            ensure!(v.array()?.len() == 1, "invalid page");
            Ok(v.at(0)?.blob()?.to_vec())
        })
        .transpose()
}
/// Partial reads verify fetched basin-object SHA-384s; full reads also verify SL2.
pub fn read_range<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    name: &str,
    start: u64,
    length: usize,
    shortcuts: bool,
) -> Result<Vec<u8>> {
    ensure!(length <= basin.max_bytes, "file read byte limit");
    let (footer, _) = open_block(basin, root, name, shortcuts)?;
    if length == 0 {
        return Ok(vec![]);
    }
    let pages = page_root(basin, &footer)?;
    let header = pages.field("5").owned()?;
    let keys = header.field("keys")?;
    if keys.is_null() {
        return Ok(vec![]);
    }
    let highest = unlex(std::str::from_utf8(keys.at(1)?.blob()?)?)?;
    let first = num_bigint::BigInt::from(start / PAGE_SIZE as u64);
    if first > highest {
        return Ok(vec![]);
    }
    let end = start
        .checked_add(length as u64)
        .context("file range overflow")?;
    let last = num_bigint::BigInt::from((end - 1) / PAGE_SIZE as u64).min(highest.clone());
    let window =
        ((last.clone() + 1u32) * PAGE_SIZE - num_bigint::BigInt::from(start)).min(length.into());
    let mut out = vec![0; usize::try_from(window)?];
    let mut actual = out.len();
    let mut page = first;
    while page <= last {
        let full = lex(&page)?.into_bytes();
        let fast = if shortcuts {
            shortcut_page(basin, &footer.item(3), &page, &full)
                .ok()
                .flatten()
        } else {
            None
        };
        let value = if let Some(v) = fast {
            v
        } else {
            trie::get_inline(basin, pages.clone(), full, 0)?
                .context("missing page")?
                .owned()?
        };
        ensure!(value.array()?.len() == 1, "invalid page");
        let bytes = value.at(0)?.blob()?;
        ensure!(
            !bytes.is_empty() && bytes.len() <= PAGE_SIZE,
            "invalid page"
        );
        let offset = &page * PAGE_SIZE - num_bigint::BigInt::from(start);
        let offset = i64::try_from(offset)?;
        let from = usize::try_from((-offset).max(0))?;
        let target = usize::try_from(offset.max(0))?;
        let count = bytes
            .len()
            .saturating_sub(from)
            .min(out.len().saturating_sub(target));
        if count > 0 {
            out[target..target + count].copy_from_slice(&bytes[from..from + count]);
        }
        if page == highest {
            actual = actual.min(usize::try_from((offset + bytes.len() as i64).max(0))?);
        }
        page += 1;
    }
    out.truncate(actual);
    Ok(out)
}
struct Catalogue {
    files: BTreeMap<String, BlockRoot>,
    dirs: BTreeSet<String>,
}
fn catalogue<S: Storage>(basin: &mut Basin<S>, root: &Edge) -> Result<Catalogue> {
    fn walk(
        v: &Value,
        prefix: &str,
        dirs: &mut BTreeSet<String>,
        sums: &mut BTreeMap<String, Vec<u8>>,
    ) -> Result<()> {
        for (name, entry) in v.at(2)?.map_ref()? {
            let path = format!("{prefix}/{name}");
            if entry.at(0)?.boolean()? {
                dirs.insert(path.clone());
                walk(entry, &path, dirs, sums)?;
            } else {
                sums.insert(path, entry.at(1)?.blob()?.to_vec());
            }
        }
        Ok(())
    }
    let f = data(basin, root)?;
    let mut dirs = BTreeSet::new();
    let mut sums = BTreeMap::new();
    walk(&f.item(3).owned()?, "", &mut dirs, &mut sums)?;
    let mut files = BTreeMap::new();
    trie::visit_inline(
        basin,
        f.item(2),
        &[],
        &[],
        0,
        &mut |_, _| true,
        &mut |k, v| {
            let name = String::from_utf8(k)?;
            let digest = sums.remove(&name).context("device/directory mismatch")?;
            files.insert(
                name,
                BlockRoot {
                    edge: v.owned()?.at(0)?.clone(),
                    digest,
                },
            );
            Ok(true)
        },
    )?;
    ensure!(sums.is_empty(), "missing retained block");
    Ok(Catalogue { files, dirs })
}
fn exists(c: &Catalogue, name: &str) -> bool {
    c.files.contains_key(name) || c.dirs.contains(name)
}
fn save_catalogue<S: Storage>(basin: &mut Basin<S>, c: Catalogue) -> Result<Edge> {
    from_blocks(
        basin,
        c.files.into_iter().collect(),
        c.dirs.into_iter().collect(),
    )
}
fn transfer<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    from: &str,
    to: &str,
    moving: bool,
    replace: bool,
) -> Result<Edge> {
    path(from)?;
    path(to)?;
    let mut c = catalogue(basin, root)?;
    ensure!(exists(&c, from), "missing pathname");
    if from == to {
        ensure!(moving, "cannot copy onto itself");
        return Ok(root.clone());
    }
    ensure!(
        !to.starts_with(&format!("{from}/")),
        "destination is inside source"
    );
    let parent = to.rsplit_once('/').unwrap().0;
    ensure!(
        parent.is_empty() || c.dirs.contains(parent),
        "missing parent directory"
    );
    let directory = c.dirs.contains(from);
    if exists(&c, to) {
        ensure!(replace, "destination exists");
        ensure!(directory == c.dirs.contains(to), "file/directory collision");
        let prefix = format!("{to}/");
        ensure!(
            !directory
                || (!c.dirs.iter().any(|n| n.starts_with(&prefix))
                    && !c.files.keys().any(|n| n.starts_with(&prefix))),
            "destination directory is not empty"
        );
    }
    let prefix = format!("{from}/");
    let selected = |n: &str| n == from || (directory && n.starts_with(&prefix));
    let files = c
        .files
        .iter()
        .filter(|(n, _)| selected(n))
        .map(|(n, v)| (format!("{to}{}", &n[from.len()..]), v.clone()))
        .collect::<Vec<_>>();
    let dirs = c
        .dirs
        .iter()
        .filter(|n| selected(n))
        .map(|n| format!("{to}{}", &n[from.len()..]))
        .collect::<Vec<_>>();
    if moving {
        c.files.retain(|n, _| !selected(n));
        c.dirs.retain(|n| !selected(n));
    }
    c.files.extend(files);
    c.dirs.extend(dirs);
    save_catalogue(basin, c)
}
/// Exact destination; overwrite requires replace and a matching kind/empty directory.
pub fn move_path<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    from: &str,
    to: &str,
    replace: bool,
) -> Result<Edge> {
    transfer(basin, root, from, to, true, replace)
}
/// Shares retained blocks, including an entire directory subtree.
pub fn copy_path<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    from: &str,
    to: &str,
    replace: bool,
) -> Result<Edge> {
    transfer(basin, root, from, to, false, replace)
}
pub fn remove_path<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    name: &str,
    recursive: bool,
) -> Result<Edge> {
    path(name)?;
    let mut c = catalogue(basin, root)?;
    ensure!(exists(&c, name), "missing pathname");
    let prefix = format!("{name}/");
    let nested = |n: &str| n.starts_with(&prefix);
    ensure!(
        recursive || (!c.dirs.iter().any(|n| nested(n)) && !c.files.keys().any(|n| nested(n))),
        "directory is not empty"
    );
    c.files.retain(|n, _| n != name && !nested(n));
    c.dirs.retain(|n| n != name && !nested(n));
    save_catalogue(basin, c)
}

pub fn update<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    changes: Vec<(String, Option<Vec<u8>>)>,
) -> Result<Edge> {
    fn walk<S: Storage>(
        b: &mut Basin<S>,
        root: &Edge,
        dir: &str,
        out: &mut BTreeMap<String, Vec<u8>>,
        directories: &mut Vec<String>,
    ) -> Result<()> {
        for n in list(b, root, dir)? {
            let p = if dir == "/" {
                format!("/{n}")
            } else {
                format!("{dir}/{n}")
            };
            if list(b, root, &p).is_ok() {
                directories.push(p.clone());
                walk(b, root, &p, out, directories)?;
            } else {
                out.insert(p.clone(), read(b, root, &p, true)?);
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    let mut directories = vec![];
    walk(basin, root, "/", &mut files, &mut directories)?;
    for (k, v) in changes {
        path(&k)?;
        if let Some(v) = v {
            files.insert(k, v);
        } else {
            files.remove(&k);
        }
    }
    build_with_directories(basin, files.into_iter().collect(), directories)
}

#[cfg(test)]
mod boundary_tests {
    use super::*;
    #[test]
    fn seven_bit_spines_use_basin_heights_and_preserve_gaps() -> Result<()> {
        let mut b = Basin::new(basin::MemoryStorage::default(), vec![42; 32])?;
        let rows = (0..98305u32).map(|i| (i.into(), i.into())).collect();
        let n = vector::build_node_entries(&mut b, 98305u32.into(), rows, &trie::Plain, 7)?;
        let leading = vector_spine(&mut b, &n.node, false)?;
        let lagging = vector_spine(&mut b, &n.node, true)?;
        assert_eq!(leading.array()?.len(), 2);
        assert!(!leading.at(1)?.is_null());
        assert!(lagging.at(1)?.is_null());
        for stack in [leading, lagging] {
            for (h, link) in stack.array()?.iter().enumerate() {
                if !link.is_null() {
                    assert_eq!(link.field("height")?.number()? as usize, h);
                }
            }
        }
        Ok(())
    }
}
