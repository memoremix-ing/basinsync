use crate::{
    Value,
    basin::{self, Basin, DOMAIN, Edge, Storage},
    bromberg,
    trie::{self, Consumer, View},
    value,
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
                    out.extend(directory_refs(v.at(1)?.field("contents")?)?);
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
            Ok(
                1 + if v.at(0)?.boolean()? && matches!(v.at(1)?.field("contents")?, Map(_)) {
                    v.at(1)?.field("inlined")?.number()? as usize
                } else {
                    0
                },
            )
        })
    }
    fn trie_externalize<S: Storage>(&self, b: &mut Basin<S>, v: &Value) -> Result<Value> {
        if v.at(0)?.boolean()? && matches!(v.at(1)?.field("contents")?, Map(_)) {
            let d = v.at(1)?;
            let contents = d.field("contents")?;
            let edge = b.seal(contents.clone(), &directory_refs(contents)?)?;
            Ok(Array(vec![
                Bool(true),
                Value::map([
                    ("sha384", d.field("sha384")?.clone()),
                    ("inlined", d.field("inlined")?.clone()),
                    ("nesting", d.field("nesting")?.clone()),
                    ("contents", edge),
                ]),
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
            directory_refs(v.at(1)?.field("contents")?)
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
            if v.at(0)?.boolean()? {
                let d = v.at(1)?;
                if matches!(d.field("contents")?, Map(_)) {
                    depth = depth.max(d.field("nesting")?.number()? as usize);
                }
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
            let contents = d.field("contents")?;
            let cut = d.field("inlined")?.number()? >= 1280 || d.field("nesting")?.number()? >= 32;
            let source = if cut {
                b.seal(contents.clone(), &child.edges)?
            } else {
                contents.clone()
            };
            Array(vec![
                Bool(true),
                Value::map([
                    ("sha384", d.field("sha384")?.clone()),
                    ("inlined", d.field("inlined")?.clone()),
                    ("nesting", d.field("nesting")?.clone()),
                    ("contents", source),
                ]),
            ])
        } else {
            v.clone()
        };
        rows.push((name.as_bytes().to_vec(), stored));
    }
    let t = trie::build_node(b, rows, &DirectoryEntries)?;
    let (inline, nesting) = directory_stats(&t.node)?;
    Ok(DirectoryBuilt {
        descriptor: Value::map([
            ("sha384", tree.at(1)?.clone()),
            ("inlined", inline.into()),
            ("nesting", nesting.into()),
            ("contents", t.node),
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
    source_root(b, source.field("contents"))
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
            return Ok((folder, if folder { entry.item(1) } else { entry }));
        }
        ensure!(folder, "parent is not a directory");
        source = entry.item(1);
    }
    anyhow::bail!("missing pathname")
}
fn materialize_directory<S: Storage>(b: &mut Basin<S>, source: View) -> Result<Value> {
    let digest = source.field("sha384").owned()?;
    let node = directory_contents(b, source)?;
    let mut rows = vec![];
    trie::visit_inline(b, node, &[], &[], 0, &mut |_, _| true, &mut |k, v| {
        rows.push((String::from_utf8(k)?, v));
        Ok(true)
    })?;
    let mut entries = BTreeMap::new();
    for (name, v) in rows {
        let entry = if v.item(0).owned()?.boolean()? {
            let child = materialize_directory(b, v.item(1))?;
            ensure!(
                child.at(1)? == &v.item(1).field("sha384").owned()?,
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
    let pages = input
        .into_iter()
        .map(|(n, v)| Ok((lex(&n)?.into_bytes(), Array(vec![Blob(v)]))))
        .collect::<Result<Vec<_>>>()?;
    let t = trie::build_node(b, pages, &Sectors)?;
    let leading = page_spine(b, &t.node, false)?;
    let lagging = page_spine(b, &t.node, true)?;
    let digest = t
        .node
        .index(6)?
        .at(1)?
        .field("brombergSL2")?
        .blob()?
        .to_vec();
    let edged = t.node.index(5)?.field("inlined")?.number()? > 1280;
    let source = if edged {
        b.seal(t.node, &t.edges)?
    } else {
        t.node
    };
    let edges = if edged { vec![source.clone()] } else { t.edges };
    let node = Value::map([
        ("0", Symbol("species".into())),
        ("1", DOMAIN.into()),
        ("2", BLOCK.into()),
        ("3", basin::query(&edges, b.max_degree, b.max_height)?),
        ("4", 0u32.into()),
        ("5", Null),
        (
            "6",
            Array(vec![0u32.into(), Null, source, leading, lagging]),
        ),
    ]);
    Ok(BlockRoot {
        edge: b.seal(node, &edges)?,
        digest,
    })
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
    let edged = descriptor.field("inlined")?.number()? > 1280
        || descriptor.field("nesting")?.number()? > 32;
    let edges = if edged {
        let e = basin.seal(descriptor.field("contents")?.clone(), &directory.edges)?;
        if let Map(ref mut m) = descriptor {
            m.insert("contents".into(), e.clone());
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
        ("6", Array(vec![0u32.into(), Null, descriptor])),
    ]);
    basin.seal(node, &edges)
}
fn data<S: Storage>(basin: &mut Basin<S>, root: &Edge) -> Result<View> {
    let v = View::root(basin.load(root)?);
    basin::validate_node(v.reader()?, Some(PATH))?;
    let footer = v.field("6");
    ensure!(
        footer.reader()?.get_vector()?.len() == 3
            && value::item(footer.reader()?, 0)?.get_i64()? == 0,
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
    let pages = footer.item(2);
    if pages.reader()?.flexbuffer_type() == flexbuffers::FlexBufferType::Map {
        pages.field("6").item(1).owned()
    } else {
        pages.item(6).field("1").owned()
    }
}
fn open_block<S: Storage>(
    b: &mut Basin<S>,
    root: &Edge,
    name: &str,
    _shortcuts: bool,
) -> Result<(View, Vec<u8>)> {
    let (folder, file) = directory_entry(b, root, name)?;
    ensure!(!folder, "not a file");
    let file = file.owned()?;
    let block = View::root(b.load(file.at(2)?)?);
    basin::validate_node(block.reader()?, Some(BLOCK))?;
    let f = block.field("6");
    ensure!(
        f.reader()?.get_vector()?.len() == 5,
        "unsupported block migration"
    );
    let expected = sector_summary(&f)?.field("brombergSL2")?.blob()?.to_vec();
    ensure!(expected == file.at(1)?.blob()?, "block checksum mismatch");
    Ok((f, expected))
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
            trie::get_inline(b, root, k.to_vec(), 0)?
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
    if let Some(root) = ready_source(b, f.item(2))? {
        if let Some(value) = trie::get_cached_inline(b, root, full.clone(), 0)? {
            return value.map(|v| v.owned()).transpose();
        }
    }
    if shortcuts {
        if let Some(v) = shortcut_page(b, f, &full).ok().flatten() {
            return Ok(Some(v));
        }
    }
    let root = page_root(b, f)?;
    trie::get_inline(b, root, full, 0)?
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
    let value = page_value(basin, &footer, full, shortcuts)?;
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
    let source = footer.item(2).owned()?;
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
        let value = page_value(basin, &footer, full, shortcuts)?.context("missing page")?;
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
