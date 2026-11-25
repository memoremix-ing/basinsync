use crate::{
    Value,
    basin::{self, Basin, DOMAIN, Edge, Storage},
    trie::{self, Consumer, View},
    value,
};
use Value::*;
use anyhow::{Context, Result, ensure};
use std::collections::{BTreeMap, BTreeSet};
pub const PATH: &str = ".sync-volume/";
pub const BLOCK: &str = ".sync-block/";
pub const PAGE_SIZE: usize = 4096;
mod checksum;
mod chunking;
pub use checksum::Algorithm;
pub use chunking::{ChunkPolicy, chunks};
pub struct Sectors;
impl Consumer for Sectors {
    fn migration(&self) -> u32 {
        1
    }
    fn empty(&self) -> Value {
        checksum::Pages {
            algorithm: Algorithm::Crc64Nvme,
            inline: 1280,
        }
        .empty()
    }
    fn entry(&self, key: &[u8], value: &Value) -> Result<Value> {
        checksum::Pages {
            algorithm: Algorithm::Crc64Nvme,
            inline: 1280,
        }
        .entry(key, value)
    }
    fn combine(&self, parts: &[Value]) -> Result<Value> {
        checksum::Pages {
            algorithm: Algorithm::Crc64Nvme,
            inline: 1280,
        }
        .combine(parts)
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
fn directory_refs(source: &Value) -> Result<Vec<Edge>> {
    if matches!(source, Array(_)) {
        return Ok(vec![source.clone()]);
    }
    fn scan(n: &Value) -> Result<Vec<Edge>> {
        if n.index(3)?.field("degree")?.number()? == 0 {
            return Ok(vec![]);
        }
        let mut refs = vec![];
        let group = |g: &Value| -> Result<Vec<Edge>> {
            let mut out = vec![];
            for v in g.field("values")?.array()? {
                if v.at(0)?.boolean()? {
                    out.extend(directory_refs(v.at(4)?)?);
                } else {
                    out.push(v.at(2)?.clone());
                }
            }
            Ok(out)
        };
        refs.extend(group(n.index(6)?.at(2)?)?);
        if !n.index(6)?.at(3)?.is_null() {
            for m in n.index(6)?.at(3)?.array()? {
                if m.is_null() {
                    continue;
                }
                if matches!(m, Array(_)) {
                    for child in m.array()? {
                        if !child.is_null() {
                            refs.extend(if matches!(child, Array(_)) {
                                vec![child.clone()]
                            } else {
                                scan(child)?
                            });
                        }
                    }
                } else {
                    refs.extend(group(m)?);
                }
            }
        }
        basin::distinct(&refs)
    }
    scan(source)
}
struct DirectoryEntries;
impl Consumer for DirectoryEntries {
    fn trie_inline_cost(&self) -> Option<fn(&Value) -> Result<usize>> {
        Some(|v| {
            Ok(1 + if v.at(0)?.boolean()? && matches!(v.at(4)?, Map(_)) {
                v.at(2)?.number()? as usize
            } else {
                0
            })
        })
    }
    fn trie_externalize<S: Storage>(&self, b: &mut Basin<S>, v: &Value) -> Result<Value> {
        if v.at(0)?.boolean()? && matches!(v.at(4)?, Map(_)) {
            let contents = v.at(4)?;
            let edge = b.seal(contents.clone(), &directory_refs(contents)?)?;
            Ok(Array(vec![
                Bool(true),
                v.at(1)?.clone(),
                v.at(2)?.clone(),
                v.at(3)?.clone(),
                edge,
            ]))
        } else {
            Ok(v.clone())
        }
    }
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
        if v.at(0)?.boolean()? {
            directory_refs(v.at(4)?)
        } else {
            Ok(vec![v.at(2)?.clone()])
        }
    }
}
struct DirectoryBuilt {
    descriptor: Value,
    edges: Vec<Edge>,
}
fn directory_stats(n: &Value) -> Result<(usize, usize)> {
    fn group(g: &Value) -> Result<usize> {
        let mut depth = 0;
        for v in g.field("values")?.array()? {
            if v.at(0)?.boolean()? && matches!(v.at(4)?, Map(_)) {
                depth = depth.max(v.at(3)?.number()? as usize);
            }
        }
        Ok(depth)
    }
    fn scan(n: &Value) -> Result<usize> {
        let mut depth = group(n.index(6)?.at(2)?)?;
        let members = n.index(6)?.at(3)?;
        if !members.is_null() {
            for m in members.array()? {
                if m.is_null() {
                    continue;
                }
                if matches!(m, Array(_)) {
                    for ch in m.array()? {
                        if matches!(ch, Map(_)) {
                            depth = depth.max(scan(ch)?);
                        }
                    }
                } else {
                    depth = depth.max(group(m)?);
                }
            }
        }
        Ok(depth)
    }
    Ok((
        n.index(5)?.field("inlined")?.number()? as usize,
        1 + scan(n)?,
    ))
}
fn build_directory<S: Storage>(b: &mut Basin<S>, tree: &Value) -> Result<DirectoryBuilt> {
    let entries = tree.at(2)?.map_ref()?;
    let mut children = BTreeMap::new();
    for (name, v) in entries {
        if v.at(0)?.boolean()? {
            children.insert(name.clone(), build_directory(b, v)?);
        }
    }
    let mut rows = vec![];
    for (name, v) in entries {
        let stored = if let Some(child) = children.get(name) {
            let d = &child.descriptor;
            let contents = d.at(4)?;
            let cut = d.at(2)?.number()? >= 1280 || d.at(3)?.number()? >= 32;
            let source = if cut {
                b.seal(contents.clone(), &child.edges)?
            } else {
                contents.clone()
            };
            Array(vec![
                Bool(true),
                d.at(1)?.clone(),
                d.at(2)?.clone(),
                d.at(3)?.clone(),
                source,
            ])
        } else {
            v.clone()
        };
        rows.push((name.as_bytes().to_vec(), stored));
    }
    let t = trie::build_node(b, rows, &DirectoryEntries)?;
    let (inline, nesting) = directory_stats(&t.node)?;
    Ok(DirectoryBuilt {
        descriptor: Array(vec![
            Bool(true),
            tree.at(1)?.clone(),
            inline.into(),
            nesting.into(),
            t.node,
        ]),
        edges: t.edges,
    })
}
fn source_root<S: Storage>(b: &mut Basin<S>, source: View) -> Result<View> {
    if source.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
        Ok(source)
    } else {
        Ok(View::root(b.load(&source.owned()?)?))
    }
}
fn directory_contents<S: Storage>(b: &mut Basin<S>, source: View) -> Result<View> {
    source_root(b, source.item(4))
}
fn directory_entry<S: Storage>(b: &mut Basin<S>, root: &Edge, name: &str) -> Result<(bool, View)> {
    let f = data(b, root)?;
    let mut source = f.item(2);
    if name == "/" {
        return Ok((true, source));
    }
    let parts = path(name)?;
    for (i, p) in parts.iter().enumerate() {
        let contents = directory_contents(b, source)?;
        let entry =
            trie::get_inline(b, contents, p.as_bytes().to_vec(), 0)?.context("missing pathname")?;
        let folder = entry.item(0).owned()?.boolean()?;
        if i == parts.len() - 1 {
            return Ok((folder, entry));
        }
        ensure!(folder, "parent is not a directory");
        source = entry;
    }
    anyhow::bail!("missing pathname")
}
fn materialize_directory<S: Storage>(b: &mut Basin<S>, source: View) -> Result<Value> {
    let digest = source.item(1).owned()?;
    let node = directory_contents(b, source)?;
    let mut rows = vec![];
    trie::visit_inline(b, node, &[], &[], 0, &mut |_, _| true, &mut |k, v| {
        rows.push((String::from_utf8(k)?, v));
        Ok(true)
    })?;
    let mut entries = BTreeMap::new();
    for (name, v) in rows {
        let entry = if v.item(0).owned()?.boolean()? {
            let child = materialize_directory(b, v.clone())?;
            ensure!(
                child.at(1)? == &v.item(1).owned()?,
                "directory digest mismatch"
            );
            child
        } else {
            v.owned()?
        };
        entries.insert(name, entry);
    }
    Ok(Array(vec![Bool(true), digest, Map(entries)]))
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
fn page_spine<S: Storage>(b: &mut Basin<S>, root: &Value, last: bool) -> Result<Value> {
    let mut node = root.clone();
    let mut base = vec![];
    let mut spine = vec![Null; root.index(3)?.field("height")?.number()? as usize];
    for _ in 0..256 {
        let h = node.index(5)?;
        if h.field("keys")?.is_null() {
            return Ok(Array(spine));
        }
        let target = h.field("keys")?.at(if last { 1 } else { 0 })?.blob()?;
        let prefix = if h.field("prefix")?.is_null() {
            &[][..]
        } else {
            h.field("prefix")?.blob()?
        };
        let members = node.index(6)?.at(3)?;
        if members.is_null() || target.len() == prefix.len() {
            return Ok(Array(spine));
        }
        let byte = target[prefix.len()] as usize;
        let Some(m) = members.array()?.get(byte >> 4) else {
            return Ok(Array(spine));
        };
        if !matches!(m, Array(_)) {
            return Ok(Array(spine));
        }
        let Some(ch) = m.array()?.get(byte & 15) else {
            return Ok(Array(spine));
        };
        if ch.is_null() {
            return Ok(Array(spine));
        }
        base.extend_from_slice(prefix);
        base.push(byte as u8);
        if matches!(ch, Array(_)) {
            spine[ch.at(3)?.field("height")?.number()? as usize] = Value::map([
                ("prefix", Blob(base.clone())),
                ("sha384", ch.at(6)?.field("sha384")?.clone()),
                ("link", basin::weak(ch)?),
            ]);
            if ch.at(3)?.field("degree")?.number()? == 0 {
                return Ok(Array(spine));
            }
            node = View::root(b.load(ch)?).owned()?;
        } else {
            node = ch.clone();
        }
    }
    anyhow::bail!("page trie nesting limit")
}
pub fn build_block<S: Storage>(
    b: &mut Basin<S>,
    input: Vec<(num_bigint::BigInt, Vec<u8>)>,
) -> Result<BlockRoot> {
    build_block_with_inline_pages(b, input, 1280)
}
/// Bound page payloads per physical trie node while retaining the ordinary wire schema.
pub fn build_block_with_inline_pages<S: Storage>(
    b: &mut Basin<S>,
    input: Vec<(num_bigint::BigInt, Vec<u8>)>,
    inline_pages: usize,
) -> Result<BlockRoot> {
    build_block_with_algorithm(b, input, inline_pages, Algorithm::Crc64Nvme)
}
pub fn build_block_with_algorithm<S: Storage>(
    b: &mut Basin<S>,
    input: Vec<(num_bigint::BigInt, Vec<u8>)>,
    inline_pages: usize,
    algorithm: Algorithm,
) -> Result<BlockRoot> {
    build_block_with_page_size(b, input, inline_pages, algorithm, PAGE_SIZE)
}
pub fn build_block_with_page_size<S: Storage>(
    b: &mut Basin<S>,
    input: Vec<(num_bigint::BigInt, Vec<u8>)>,
    inline_pages: usize,
    algorithm: Algorithm,
    page_size: usize,
) -> Result<BlockRoot> {
    ensure!(
        page_size > 0
            && page_size <= 32 * 1024 * 1024
            && input.iter().all(|(_, v)| v.len() <= page_size),
        "invalid page size/data"
    );
    let pages = input
        .into_iter()
        .map(|(n, v)| Ok((lex(&n)?.into_bytes(), Array(vec![Blob(v)]))))
        .collect::<Result<Vec<_>>>()?;
    let t = trie::build_node(
        b,
        pages,
        &checksum::Pages {
            inline: inline_pages,
            algorithm,
        },
    )?;
    finish_block(b, t, algorithm, page_size)
}
struct Chunks;
impl Consumer for Chunks {
    fn migration(&self) -> u32 {
        1
    }
    fn empty(&self) -> Value {
        Sectors.empty()
    }
    fn entry(&self, k: &[u8], v: &Value) -> Result<Value> {
        Sectors.entry(k, v)
    }
    fn combine(&self, parts: &[Value]) -> Result<Value> {
        Sectors.combine(parts)
    }
    fn trie_inline_cost(&self) -> Option<fn(&Value) -> Result<usize>> {
        Some(|v| {
            let length = v.at(0)?.blob()?.len();
            Ok(if length >= 65536 {
                1280
            } else {
                (length * 1280).div_ceil(65536).max(1)
            })
        })
    }
}
fn source_summary(source: &Value) -> Result<&Value> {
    if matches!(source, Array(_)) {
        source.at(6)?.field("1")
    } else {
        source.index(6)?.at(1)
    }
}
fn source_edges(source: &Value) -> Result<Vec<Edge>> {
    if matches!(source, Array(_)) {
        return Ok(vec![source.clone()]);
    }
    let mut out = vec![];
    let members = source.index(6)?.at(3)?;
    if !members.is_null() {
        for member in members.array()? {
            if let Array(children) = member {
                for child in children {
                    if !child.is_null() {
                        out.extend(source_edges(child)?);
                    }
                }
            }
        }
    }
    basin::distinct(&out)
}
pub fn build_mixed_block<S: Storage>(
    b: &mut Basin<S>,
    content: &[u8],
    pages: Vec<(num_bigint::BigInt, Vec<u8>)>,
    policy: ChunkPolicy,
) -> Result<BlockRoot> {
    build_mixed_block_with_page_size(b, content, pages, policy, PAGE_SIZE)
}
pub fn build_mixed_block_with_page_size<S: Storage>(
    b: &mut Basin<S>,
    content: &[u8],
    pages: Vec<(num_bigint::BigInt, Vec<u8>)>,
    policy: ChunkPolicy,
    page_size: usize,
) -> Result<BlockRoot> {
    ensure!(
        page_size > 0
            && page_size <= 32 * 1024 * 1024
            && pages.iter().all(|(_, v)| v.len() <= page_size),
        "invalid page size/data"
    );
    let rows = chunks(content, policy)?
        .into_iter()
        .enumerate()
        .map(|(i, bytes)| Ok((lex(&(i + 1).into())?.into_bytes(), Array(vec![Blob(bytes)]))))
        .collect::<Result<Vec<_>>>()?;
    let prefix = trie::build_node(b, rows, &Chunks)?;
    let rows = pages
        .into_iter()
        .map(|(i, bytes)| Ok((lex(&i)?.into_bytes(), Array(vec![Blob(bytes)]))))
        .collect::<Result<Vec<_>>>()?;
    let suffix = trie::build_node(b, rows, &Sectors)?;
    finish_parts(b, prefix.node, suffix, Algorithm::Crc64Nvme, page_size)
}
pub fn build_content_block<S: Storage>(
    b: &mut Basin<S>,
    bytes: &[u8],
    policy: ChunkPolicy,
) -> Result<BlockRoot> {
    build_mixed_block(b, bytes, vec![], policy)
}
fn finish_block<S: Storage>(
    b: &mut Basin<S>,
    t: trie::Built,
    algorithm: Algorithm,
    page_size: usize,
) -> Result<BlockRoot> {
    let prefix = trie::build_node(b, vec![], &Chunks)?;
    finish_parts(b, prefix.node, t, algorithm, page_size)
}
fn finish_parts<S: Storage>(
    b: &mut Basin<S>,
    prefix: Value,
    suffix: trie::Built,
    algorithm: Algorithm,
    page_size: usize,
) -> Result<BlockRoot> {
    let leading = page_spine(b, &suffix.node, false)?;
    let lagging = page_spine(b, &suffix.node, true)?;
    let sum = Sectors.combine(&[
        source_summary(&prefix)?.clone(),
        source_summary(&suffix.node)?.clone(),
    ])?;
    let digest = algorithm.digest(&sum)?;
    let mut sources = vec![prefix, suffix.node];
    let mut edges = vec![];
    for source in &sources {
        edges.extend(source_edges(source)?);
    }
    let cost = sources
        .iter()
        .map(|source| {
            if matches!(source, Array(_)) {
                Ok(0)
            } else {
                source.index(5)?.field("inlined")?.number()
            }
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .sum::<u32>();
    if cost > 1280 || basin::distinct(&edges)?.len() > b.max_degree {
        for source in &mut sources {
            if matches!(source, Map(_)) && source.index(5)?.field("count")?.big()? > 0.into() {
                *source = b.seal(source.clone(), &source_edges(source)?)?;
            }
        }
    }
    let mut edges = vec![];
    for source in &sources {
        edges.extend(source_edges(source)?);
    }
    let edges = basin::distinct(&edges)?;
    let node = Value::map([
        ("0", Symbol("species".into())),
        ("1", DOMAIN.into()),
        ("2", BLOCK.into()),
        ("3", basin::query(&edges, b.max_degree, b.max_height)?),
        ("4", 0u32.into()),
        ("5", Value::map([("pageSize", (page_size as u32).into())])),
        (
            "6",
            Array(vec![2u32.into(), Null, Array(sources), leading, lagging]),
        ),
    ]);
    Ok(BlockRoot {
        edge: b.seal(node, &edges)?,
        digest,
    })
}
/// Replace/add/remove only the supplied pages, preserving opaque unchanged subtries.
pub fn update_block<S: Storage>(
    b: &mut Basin<S>,
    old: &BlockRoot,
    changes: Vec<(num_bigint::BigInt, Option<Vec<u8>>)>,
    inline_pages: usize,
    algorithm: Algorithm,
) -> Result<BlockRoot> {
    update_block_truncated(b, old, changes, None, inline_pages, algorithm)
}
pub fn update_block_truncated<S: Storage>(
    b: &mut Basin<S>,
    old: &BlockRoot,
    changes: Vec<(num_bigint::BigInt, Option<Vec<u8>>)>,
    remove_from: Option<num_bigint::BigInt>,
    inline_pages: usize,
    algorithm: Algorithm,
) -> Result<BlockRoot> {
    if changes.is_empty() && remove_from.is_none() {
        return Ok(old.clone());
    }
    let block = View::root(b.load(&old.edge)?).owned()?;
    ensure!(
        block.index(6)?.at(0)?.number()? == 2,
        "checksum migration mismatch"
    );
    let prefix = block.index(6)?.at(2)?.at(0)?.clone();
    let source = block.index(6)?.at(2)?.at(1)?.clone();
    let changes = changes
        .into_iter()
        .map(|(n, v)| Ok((lex(&n)?.into_bytes(), v.map(|v| Array(vec![Blob(v)])))))
        .collect::<Result<Vec<_>>>()?;
    let cutoff = remove_from.map(|n| lex(&n)).transpose()?;
    let t = trie::update_node_pruned(
        b,
        source.clone(),
        changes,
        cutoff.as_deref().map(str::as_bytes),
        &checksum::Pages {
            inline: inline_pages,
            algorithm,
        },
    )?;
    if matches!(source, Map(_)) && t.node == source {
        return Ok(old.clone());
    }
    finish_parts(
        b,
        prefix,
        t,
        algorithm,
        block.index(5)?.field("pageSize")?.number()? as usize,
    )
}
pub fn block<S: Storage>(b: &mut Basin<S>, root: &Edge, name: &str) -> Result<BlockRoot> {
    let (folder, file) = directory_entry(b, root, name)?;
    ensure!(!folder, "not a file");
    let file = file.owned()?;
    Ok(BlockRoot {
        edge: file.at(2)?.clone(),
        digest: file.at(1)?.blob()?.to_vec(),
    })
}
fn page_root<S: Storage>(basin: &mut Basin<S>, footer: &View) -> Result<View> {
    let pages = footer.item(2).item(1);
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
    let migration = 1u32;
    let mut file_map = BTreeMap::new();
    for (name, block) in blocks {
        path(&name)?;
        ensure!(!file_map.contains_key(&name), "duplicate pathname");
        ensure!(
            block.edge.at(2)?.text()? == BLOCK
                && block.edge.at(6)?.field("0")?.number()? == 2
                && block.digest.len() == 8,
            "invalid block descriptor"
        );
        file_map.insert(name, (block.edge, Blob(block.digest)));
    }
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
            Array(vec![Bool(false), digest.clone(), edge.clone()]),
        )?;
    }
    let root = finish(tree)?;
    let directory = build_directory(basin, &root)?;
    let mut descriptor = directory.descriptor;
    let edged = descriptor.at(2)?.number()? > 1280 || descriptor.at(3)?.number()? > 32;
    let edges = if edged {
        let e = basin.seal(descriptor.at(4)?.clone(), &directory.edges)?;
        if let Array(ref mut parts) = descriptor {
            parts[4] = e.clone();
        }
        vec![e]
    } else {
        directory.edges
    };
    let node = Value::map([
        ("0", Symbol("species".into())),
        ("1", DOMAIN.into()),
        ("2", PATH.into()),
        (
            "3",
            basin::query(&edges, basin.max_degree, basin.max_height)?,
        ),
        ("4", 0u32.into()),
        ("5", Null),
        ("6", Array(vec![migration.into(), Null, descriptor])),
    ]);
    basin.seal(node, &edges)
}
fn data<S: Storage>(basin: &mut Basin<S>, root: &Edge) -> Result<View> {
    let v = View::root(basin.load(root)?);
    basin::validate_node(v.reader()?, Some(PATH))?;
    let footer = v.field("6");
    ensure!(
        footer.reader()?.get_vector()?.len() == 3
            && value::item(footer.reader()?, 0)?.get_i64()? == 1,
        "unsupported volume migration"
    );
    Ok(footer)
}
pub fn list<S: Storage>(basin: &mut Basin<S>, root: &Edge, name: &str) -> Result<Vec<String>> {
    let (folder, entry) = directory_entry(basin, root, name)?;
    ensure!(folder, "not a directory");
    let contents = directory_contents(basin, entry)?;
    let mut names = vec![];
    trie::visit_inline(
        basin,
        contents,
        &[],
        &[],
        0,
        &mut |_, _| true,
        &mut |k, _| {
            names.push(String::from_utf8(k)?);
            Ok(true)
        },
    )?;
    Ok(names)
}
fn ready_source<S: Storage>(b: &mut Basin<S>, source: View) -> Result<Option<View>> {
    if source.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
        Ok(Some(source))
    } else {
        Ok(b.peek(&source.owned()?)?.map(View::root))
    }
}
fn sector_summary(footer: &View) -> Result<Value> {
    let contents = footer.item(2).owned()?;
    ensure!(contents.array()?.len() == 2, "invalid block contents");
    Sectors.combine(&[
        source_summary(contents.at(0)?)?.clone(),
        source_summary(contents.at(1)?)?.clone(),
    ])
}
fn page_size(footer: &View) -> Result<usize> {
    let n = View::root(footer.bytes.clone())
        .field("5")
        .field("pageSize")
        .owned()?
        .number()? as usize;
    ensure!(n > 0 && n <= 32 * 1024 * 1024, "invalid page size");
    Ok(n)
}
fn content_size(footer: &View) -> Result<u64> {
    Ok(u64::try_from(
        source_summary(&footer.item(2).item(0).owned()?)?
            .field("size")?
            .big()?,
    )?)
}
fn packed_range<S: Storage>(
    b: &mut Basin<S>,
    source: View,
    start: u64,
    length: usize,
) -> Result<Vec<u8>> {
    let root = if source.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
        source
    } else {
        View::root(b.load(&source.owned()?)?)
    };
    let at = std::cell::Cell::new(0u64);
    let error = std::cell::RefCell::new(None);
    let mut out = vec![];
    let end = start
        .checked_add(length as u64)
        .context("file range overflow")?;
    trie::visit_inline(
        b,
        root,
        &[],
        &[],
        1,
        &mut |_, sum| {
            let n = (|| -> Result<u64> { Ok(u64::try_from(sum.field("size")?.big()?)?) })();
            match n.and_then(|n| at.get().checked_add(n).context("content size overflow")) {
                Ok(finish) if finish <= start => {
                    at.set(finish);
                    false
                }
                Ok(_) => at.get() < end,
                Err(e) => {
                    *error.borrow_mut() = Some(e);
                    false
                }
            }
        },
        &mut |_, v| {
            let v = v.owned()?;
            let bytes = v.at(0)?.blob()?;
            let finish = at
                .get()
                .checked_add(bytes.len() as u64)
                .context("content size overflow")?;
            let a = start.max(at.get());
            let z = end.min(finish);
            if a < z {
                out.extend_from_slice(&bytes[(a - at.get()) as usize..(z - at.get()) as usize]);
            }
            at.set(finish);
            Ok(at.get() < end)
        },
    )?;
    if let Some(e) = error.into_inner() {
        return Err(e);
    }
    Ok(out)
}
fn open_block<S: Storage>(
    b: &mut Basin<S>,
    root: &Edge,
    name: &str,
    _shortcuts: bool,
) -> Result<(View, Vec<u8>)> {
    let descriptor = block(b, root, name)?;
    let footer = open_descriptor(b, &descriptor)?;
    Ok((footer, descriptor.digest))
}
fn open_descriptor<S: Storage>(b: &mut Basin<S>, descriptor: &BlockRoot) -> Result<View> {
    let block = View::root(b.load(&descriptor.edge)?);
    basin::validate_node(block.reader()?, Some(BLOCK))?;
    let f = block.field("6");
    ensure!(
        f.reader()?.get_vector()?.len() == 5 && f.item(0).owned()?.number()? == 2,
        "unsupported block migration"
    );
    let algorithm = Algorithm::from_migration(1)?;
    page_size(&f)?;
    let expected = algorithm.digest(&sector_summary(&f)?)?;
    ensure!(expected == descriptor.digest, "block checksum mismatch");
    Ok(f)
}
pub fn read<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    name: &str,
    shortcuts: bool,
) -> Result<Vec<u8>> {
    let (footer, expected) = open_block(basin, root, name, shortcuts)?;
    let size = content_size(&footer)?;
    ensure!(size <= basin.max_bytes as u64, "file read byte limit");
    let mut bytes = packed_range(basin, footer.item(2).item(0), 0, size as usize)?;
    bytes.extend(read_suffix(basin, footer.clone())?);
    ensure!(
        bytes.len() <= basin.max_bytes && Algorithm::Crc64Nvme.hash(&bytes) == expected,
        "file checksum/limit mismatch"
    );
    Ok(bytes)
}
fn read_suffix<S: Storage>(basin: &mut Basin<S>, footer: View) -> Result<Vec<u8>> {
    let page_size = page_size(&footer)?;
    let expected =
        Algorithm::Crc64Nvme.digest(source_summary(&footer.item(2).item(1).owned()?)?)?;
    let mut pages = vec![];
    let pages_root = page_root(basin, &footer)?;
    let algorithm = Algorithm::from_migration(1)?;
    trie::visit_inline(
        basin,
        pages_root,
        &[],
        &[],
        algorithm.migration(),
        &mut |_, _| true,
        &mut |k, v| {
            let n = unlex(std::str::from_utf8(&k)?)?;
            let value = v.owned()?;
            let blob = value.at(0)?.blob()?;
            ensure!(
                value.array()?.len() == 1 && !blob.is_empty() && blob.len() <= page_size,
                "invalid page"
            );
            pages.push((n, blob.to_vec()));
            Ok(true)
        },
    )?;
    let mut end = 0usize;
    for (p, b) in &pages {
        let pos = usize::try_from(p.clone())?
            .checked_mul(page_size)
            .context("file offset overflow")?;
        end = end.max(pos.checked_add(b.len()).context("file length overflow")?);
    }
    ensure!(end <= basin.max_bytes, "file read byte limit");
    let mut bytes = vec![0; end];
    for (p, b) in pages {
        let at = usize::try_from(p)? * page_size;
        bytes[at..at + b.len()].copy_from_slice(&b);
    }
    ensure!(algorithm.hash(&bytes) == expected, "file checksum mismatch");
    Ok(bytes)
}
fn shortcut_page<S: Storage>(
    b: &mut Basin<S>,
    footer: &View,
    full: &[u8],
) -> Result<Option<Value>> {
    let mut hints = footer.item(3).owned()?.array()?.to_vec();
    hints.extend(footer.item(4).owned()?.array()?.to_vec());
    hints.retain(|h| !h.is_null());
    hints.sort_by_key(|h| {
        h.field("link")
            .and_then(|l| l.field("height"))
            .and_then(Value::number)
            .unwrap_or(u32::MAX)
    });
    for h in hints {
        let attempt = (|| -> Result<Option<Value>> {
            let prefix = h.field("prefix")?.blob()?;
            if !full.starts_with(prefix) {
                return Ok(None);
            }
            let Some(e) = b.storage.resolve(h.field("link")?)? else {
                return Ok(None);
            };
            ensure!(
                basin::capability(&e)? == basin::weak_key(h.field("link")?)?
                    && e.at(6)?.field("sha384")? == h.field("sha384")?,
                "page shortcut identity mismatch"
            );
            let keys = e.at(5)?.field("keys")?;
            let k = &full[prefix.len()..];
            if keys.is_null() || k < keys.at(0)?.blob()? || k > keys.at(1)?.blob()? {
                return Ok(None);
            }
            let root = View::root(b.load(&e)?);
            trie::get_inline(b, root, k.to_vec(), 1)?
                .map(|v| v.owned())
                .transpose()
        })();
        if let Ok(Some(v)) = attempt {
            return Ok(Some(v));
        }
    }
    Ok(None)
}
fn page_value<S: Storage>(
    b: &mut Basin<S>,
    f: &View,
    full: Vec<u8>,
    shortcuts: bool,
) -> Result<Option<Value>> {
    if let Some(root) = ready_source(b, f.item(2).item(1))?
        && let Some(value) = trie::get_cached_inline(b, root, full.clone(), 1)?
    {
        return value.map(|v| v.owned()).transpose();
    }
    if shortcuts && let Some(v) = shortcut_page(b, f, &full).ok().flatten() {
        return Ok(Some(v));
    }
    let root = page_root(b, f)?;
    trie::get_inline(b, root, full, 1)?
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
    let _profile = crate::profile::span("volume.page");
    let (footer, _) = open_block(basin, root, name, shortcuts)?;
    let full = lex(index)?.into_bytes();
    let value = page_value(basin, &footer, full, shortcuts)?;
    value
        .map(|v| {
            ensure!(v.array()?.len() == 1, "invalid page");
            Ok(v.at(0)?.blob()?.to_vec())
        })
        .transpose()
}
/// Partial reads verify fetched basin-object SHA-384s; full reads also verify CRC64NVME.
pub fn read_range<S: Storage>(
    basin: &mut Basin<S>,
    root: &Edge,
    name: &str,
    start: u64,
    length: usize,
    shortcuts: bool,
) -> Result<Vec<u8>> {
    ensure!(
        length <= basin.max_bytes && start.checked_add(length as u64).is_some(),
        "file range byte limit/overflow"
    );
    let (footer, _) = open_block(basin, root, name, shortcuts)?;
    let size = content_size(&footer)?;
    let take = size.saturating_sub(start).min(length as u64) as usize;
    let mut out = if take > 0 {
        packed_range(basin, footer.item(2).item(0), start, take)?
    } else {
        vec![]
    };
    if out.len() < length {
        out.extend(read_suffix_range(
            basin,
            &footer,
            start.saturating_sub(size),
            length - out.len(),
            shortcuts,
        )?);
    }
    Ok(out)
}
fn read_suffix_range<S: Storage>(
    basin: &mut Basin<S>,
    footer: &View,
    start: u64,
    length: usize,
    shortcuts: bool,
) -> Result<Vec<u8>> {
    let page_size = page_size(footer)?;
    if length == 0 {
        return Ok(vec![]);
    }
    let source = footer.item(2).item(1).owned()?;
    let header = if matches!(source, Array(_)) {
        source.at(5)?
    } else {
        source.index(5)?
    };
    let keys = header.field("keys")?;
    if keys.is_null() {
        return Ok(vec![]);
    }
    let highest = unlex(std::str::from_utf8(keys.at(1)?.blob()?)?)?;
    let first = num_bigint::BigInt::from(start / page_size as u64);
    if first > highest {
        return Ok(vec![]);
    }
    let end = start
        .checked_add(length as u64)
        .context("file range overflow")?;
    let last = num_bigint::BigInt::from((end - 1) / page_size as u64).min(highest.clone());
    let window =
        ((last.clone() + 1u32) * page_size - num_bigint::BigInt::from(start)).min(length.into());
    let mut out = vec![0; usize::try_from(window)?];
    let mut actual = out.len();
    let mut page = first;
    while page <= last {
        let full = lex(&page)?.into_bytes();
        let value = page_value(basin, footer, full, shortcuts)?.context("missing page")?;
        ensure!(value.array()?.len() == 1, "invalid page");
        let bytes = value.at(0)?.blob()?;
        ensure!(
            !bytes.is_empty() && bytes.len() <= page_size,
            "invalid page"
        );
        let offset = &page * page_size - num_bigint::BigInt::from(start);
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
fn catalogue<S: Storage>(b: &mut Basin<S>, root: &Edge) -> Result<Catalogue> {
    fn walk(v: &Value, prefix: &str, c: &mut Catalogue) -> Result<()> {
        for (name, entry) in v.at(2)?.map_ref()? {
            let path = format!("{prefix}/{name}");
            if entry.at(0)?.boolean()? {
                c.dirs.insert(path.clone());
                walk(entry, &path, c)?;
            } else {
                c.files.insert(
                    path,
                    BlockRoot {
                        edge: entry.at(2)?.clone(),
                        digest: entry.at(1)?.blob()?.to_vec(),
                    },
                );
            }
        }
        Ok(())
    }
    let f = data(b, root)?;
    let tree = materialize_directory(b, f.item(2))?;
    let mut c = Catalogue {
        files: BTreeMap::new(),
        dirs: BTreeSet::new(),
    };
    walk(&tree, "", &mut c)?;
    Ok(c)
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
    let mut c = catalogue(basin, root)?;
    for (name, bytes) in changes {
        path(&name)?;
        if let Some(bytes) = bytes {
            let pages = bytes
                .chunks(PAGE_SIZE)
                .enumerate()
                .map(|(i, b)| (i.into(), b.to_vec()))
                .collect();
            c.files.insert(name, build_block(basin, pages)?);
        } else {
            c.files.remove(&name);
        }
    }
    save_catalogue(basin, c)
}

/// Read only file/sector descriptors; no page-trie descendants need to be fetched.
pub fn dense_page_count<S: Storage>(b: &mut Basin<S>, root: &Edge, name: &str) -> Result<u64> {
    Ok(PageReader::open(b, root, name)?.count)
}

/// Retains the resolved block descriptor, with a weak encoded-owner cursor so
/// idle file cursors cannot pin unbounded object bodies in RAM. Bulk
/// visitation descends the trie once, borrowing each page directly from its object.
pub struct PageReader {
    block: Edge,
    owner: std::sync::Mutex<std::sync::Weak<Vec<u8>>>,
    pub count: u64,
    pub page_size: usize,
}
pub struct PagePin {
    _owner: std::sync::Arc<Vec<u8>>,
}
impl PageReader {
    pub fn open<S: Storage>(b: &mut Basin<S>, root: &Edge, name: &str) -> Result<Self> {
        let _profile = crate::profile::span("volume.file_lookup");
        let descriptor = block(b, root, name)?;
        let footer = open_descriptor(b, &descriptor)?;
        ensure!(
            content_size(&footer)? == 0,
            "database block has content-defined prefix"
        );
        let pages = footer.item(2).item(1);
        let header = if pages.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
            pages.field("5").owned()?
        } else {
            pages.item(5).owned()?
        };
        let count = u64::try_from(header.field("count")?.big()?)?;
        let keys = header.field("keys")?;
        if count == 0 {
            ensure!(keys.is_null(), "nonempty page bounds");
        } else {
            ensure!(
                unlex(std::str::from_utf8(keys.at(0)?.blob()?)?)? == 0.into()
                    && unlex(std::str::from_utf8(keys.at(1)?.blob()?)?)? == (count - 1).into(),
                "sparse database page map"
            );
        }
        let stride = page_size(&footer)?;
        ensure!(
            u64::try_from(
                source_summary(&footer.item(2).item(1).owned()?)?
                    .field("size")?
                    .big()?
            )? == count
                .checked_mul(stride as u64)
                .context("database size overflow")?,
            "non-full database pages"
        );
        Ok(Self {
            block: descriptor.edge,
            owner: std::sync::Mutex::new(std::sync::Arc::downgrade(&footer.bytes)),
            count,
            page_size: stride,
        })
    }
    fn footer<S: Storage>(&self, b: &mut Basin<S>) -> Result<View> {
        let mut owner = self.owner.lock().unwrap();
        let bytes = match owner.upgrade() {
            Some(bytes) => bytes,
            None => {
                let bytes = b.load(&self.block)?;
                *owner = std::sync::Arc::downgrade(&bytes);
                bytes
            }
        };
        Ok(View::root(bytes).field("6"))
    }
    /// Keep the active cursor alive for a read batch, without retaining its
    /// encoded object for the entire mount lifetime.
    pub fn pin<S: Storage>(&self, b: &mut Basin<S>) -> Result<PagePin> {
        Ok(PagePin {
            _owner: self.footer(b)?.bytes,
        })
    }
    pub fn page<S: Storage>(&self, b: &mut Basin<S>, index: u64) -> Result<Option<Vec<u8>>> {
        let footer = self.footer(b)?;
        page_value(b, &footer, lex(&index.into())?.into_bytes(), true)?
            .map(|v| {
                ensure!(v.array()?.len() == 1, "invalid page");
                Ok(v.at(0)?.blob()?.to_vec())
            })
            .transpose()
    }
    pub fn visit<S: Storage>(
        &self,
        b: &mut Basin<S>,
        mut emit: impl FnMut(u64, &[u8]) -> Result<()>,
    ) -> Result<()> {
        let _profile = crate::profile::span("volume.pages_visit");
        let footer = self.footer(b)?;
        let root = page_root(b, &footer)?;
        trie::prefetch_inline(b, &root, 1)?;
        let mut seen = BTreeSet::new();
        trie::visit_inline(b, root, &[], &[], 1, &mut |_, _| true, &mut |key, v| {
            let index = u64::try_from(unlex(std::str::from_utf8(&key)?)?)?;
            ensure!(
                index < self.count && seen.insert(index),
                "sparse database page map"
            );
            let array = v.reader()?.get_vector()?;
            ensure!(array.len() == 1, "invalid page");
            emit(index, array.index(0)?.get_blob()?.0)?;
            Ok(true)
        })?;
        ensure!(seen.len() as u64 == self.count, "missing Turso page");
        Ok(())
    }
}

/// Path-copy only changed directories, preserving unopened sibling contents.
pub fn replace_blocks<S: Storage>(
    b: &mut Basin<S>,
    root: &Edge,
    blocks: Vec<(String, BlockRoot)>,
) -> Result<Edge> {
    fn replace<S: Storage>(
        b: &mut Basin<S>,
        descriptor: Value,
        parts: &[&str],
        block: &BlockRoot,
    ) -> Result<Value> {
        let source = descriptor.at(4)?;
        let bytes = if matches!(source, Array(_)) {
            b.load(source)?
        } else {
            std::sync::Arc::new(basin::frame(&value::encode(source)?)?)
        };
        let mut entries = BTreeMap::new();
        trie::visit_inline(
            b,
            View::root(bytes),
            &[],
            &[],
            0,
            &mut |_, _| true,
            &mut |key, v| {
                entries.insert(String::from_utf8(key)?, v.owned()?);
                Ok(true)
            },
        )?;
        let next = if parts.len() == 1 {
            if let Some(previous) = entries.get(parts[0]) {
                ensure!(!previous.at(0)?.boolean()?, "file/directory collision");
            }
            Array(vec![
                Bool(false),
                Blob(block.digest.clone()),
                block.edge.clone(),
            ])
        } else {
            let child = entries
                .remove(parts[0])
                .context("missing parent directory")?;
            ensure!(child.at(0)?.boolean()?, "parent is not a directory");
            replace(b, child, &parts[1..], block)?
        };
        entries.insert(parts[0].into(), next);
        let digest = directory(entries.clone())?.at(1)?.clone();
        for v in entries.values_mut() {
            if v.at(0)?.boolean()?
                && matches!(v.at(4)?, Map(_))
                && (v.at(2)?.number()? >= 1280 || v.at(3)?.number()? >= 32)
            {
                *v = DirectoryEntries.trie_externalize(b, v)?;
            }
        }
        let rows = entries
            .into_iter()
            .map(|(k, v)| (k.into_bytes(), v))
            .collect();
        let trie = trie::build_node(b, rows, &DirectoryEntries)?;
        let (inline, nesting) = directory_stats(&trie.node)?;
        Ok(Array(vec![
            Bool(true),
            digest,
            inline.into(),
            nesting.into(),
            trie.node,
        ]))
    }
    let migration = 1u32;
    let mut descriptor = data(b, root)?.item(2).owned()?;
    for (name, block) in blocks {
        ensure!(
            block.edge.at(2)?.text()? == BLOCK
                && block.edge.at(6)?.field("0")?.number()? == 2
                && block.digest.len() == 8,
            "invalid block"
        );
        descriptor = replace(b, descriptor, &path(&name)?, &block)?;
    }
    let edges = directory_refs(descriptor.at(4)?)?;
    b.seal(
        Value::map([
            ("0", Symbol("species".into())),
            ("1", DOMAIN.into()),
            ("2", PATH.into()),
            ("3", basin::query(&edges, b.max_degree, b.max_height)?),
            ("4", 0u32.into()),
            ("5", Null),
            ("6", Array(vec![migration.into(), Null, descriptor])),
        ]),
        &edges,
    )
}

#[cfg(test)]
mod boundary_tests {
    use super::*;
    #[test]
    fn page_spines_target_stored_trie_nodes() -> Result<()> {
        let mut b = Basin::new(basin::MemoryStorage::default(), vec![42; 32])?;
        let block = build_block(
            &mut b,
            (0..20000u32)
                .map(|i| (i.into(), vec![(i & 255) as u8]))
                .collect(),
        )?;
        let r = View::root(b.load(&block.edge)?).owned()?;
        for stack in [r.index(6)?.at(3)?, r.index(6)?.at(4)?] {
            for (h, hint) in stack.array()?.iter().enumerate() {
                if !hint.is_null() {
                    assert_eq!(hint.field("link")?.field("height")?.number()? as usize, h);
                }
            }
        }
        Ok(())
    }
}
