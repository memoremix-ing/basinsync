use crate::value::{self, Value};
use Value::*;
use anyhow::{Context, Result, ensure};
use hmac::{Hmac, Mac};
use num_bigint::BigInt;
use sha2::{Digest, Sha384};
use std::{collections::BTreeMap, sync::Arc};
pub const DOMAIN: &str = "sync.memoremix.com";
pub type Edge = Value;
/// An address cannot be embedded in a parent until storage allocates its revision.
pub struct PendingEdge(Edge);
impl PendingEdge {
    pub fn as_value(&self) -> &Value {
        &self.0
    }
    pub fn allocated(&self, revision: &str) -> Result<Edge> {
        ensure!(valid_revision(revision), "invalid node revision");
        let mut edge = self.0.clone();
        if let Array(a) = &mut edge {
            a[6].set("revision", Text(revision.into()))?;
        }
        Ok(edge)
    }
}
pub fn valid_revision(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            14 => b == b'4',
            19 => matches!(b, b'8' | b'9' | b'a' | b'b'),
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}
pub fn hex(b: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(b.len() * 2);
    for v in b {
        out.push(HEX[(v >> 4) as usize] as char);
        out.push(HEX[(v & 15) as usize] as char);
    }
    out
}
pub fn key(s: &str) -> Result<Vec<u8>> {
    ensure!(
        s.len().is_multiple_of(2) && s.bytes().all(|v| v.is_ascii_hexdigit()),
        "invalid hexadecimal key"
    );
    (0..s.len())
        .step_by(2)
        .map(|i| Ok(u8::from_str_radix(&s[i..i + 2], 16)?))
        .collect()
}
pub fn sha384(bytes: &[u8]) -> Vec<u8> {
    Sha384::digest(bytes).to_vec()
}
pub fn hmac(secret: &[u8], bytes: &[u8]) -> Vec<u8> {
    let mut h = Hmac::<Sha384>::new_from_slice(secret).expect("HMAC accepts arbitrary key lengths");
    h.update(bytes);
    h.finalize().into_bytes().to_vec()
}
pub fn frame(message: &[u8]) -> Result<Vec<u8>> {
    let n = u32::try_from(message.len())?;
    let end = (message.len() + 16).next_multiple_of(8);
    let mut out = vec![0xee; end];
    out[..4].copy_from_slice(b"enV\xa3");
    out[4..8].copy_from_slice(&n.to_le_bytes());
    out[8..8 + message.len()].copy_from_slice(message);
    out[end - 8..end - 4].copy_from_slice(&n.to_le_bytes());
    out[end - 4..].copy_from_slice(b"\xa3vNE");
    Ok(out)
}
pub fn unframe(b: &[u8]) -> Result<&[u8]> {
    ensure!(b.len() >= 16, "truncated node");
    let n = u32::from_le_bytes(b[4..8].try_into()?) as usize;
    let end = n
        .checked_add(16)
        .context("envelope length overflow")?
        .next_multiple_of(8);
    ensure!(
        b[..4] == *b"enV\xa3"
            && end == b.len()
            && b[end - 8..end - 4] == b[4..8]
            && b[end - 4..] == *b"\xa3vNE"
            && b[8 + n..end - 8].iter().all(|v| *v == 0xee),
        "invalid node envelope"
    );
    Ok(&b[8..8 + n])
}
pub fn node_reader(bytes: &[u8]) -> Result<flexbuffers::Reader<&[u8]>> {
    let r = flexbuffers::Reader::get_root(unframe(bytes)?)?;
    validate_node(r.clone(), None)?;
    Ok(r)
}
pub fn validate_node(r: flexbuffers::Reader<&[u8]>, path: Option<&str>) -> Result<()> {
    use value::field;
    ensure!(
        r.flexbuffer_type() == flexbuffers::FlexBufferType::Map,
        "node must be a map"
    );
    ensure!(
        value::read(field(r.clone(), "0")?)? == Symbol("species".into())
            && !field(r.clone(), "1")?.get_str()?.is_empty()
            && field(r.clone(), "4")?.get_i64()? == 0,
        "unsupported node schema"
    );
    if let Some(p) = path {
        ensure!(
            field(r.clone(), "1")?.get_str()? == DOMAIN && field(r, "2")?.get_str()? == p,
            "wrong species"
        );
    }
    Ok(())
}
pub fn validate_edge(e: &Edge) -> Result<()> {
    validate_pending(e)?;
    ensure!(
        valid_revision(footer(e)?.field("revision")?.text()?),
        "invalid node revision"
    );
    Ok(())
}
fn validate_pending(e: &Edge) -> Result<()> {
    ensure!(
        e.array()?.len() == 7
            && e.at(0)? == &Symbol("match".into())
            && !e.at(1)?.text()?.is_empty()
            && e.at(4)?.number()? == 0,
        "unsupported edge schema"
    );
    ensure!(
        e.at(6)?.field("version")?.number()? == 0
            && e.at(6)?.field("sha384")?.blob()?.len() == 48
            && e.at(6)?.field("entropy")?.blob()?.len() == 32,
        "invalid edge descriptor"
    );
    e.at(3)?.field("height")?.number()?;
    e.at(6)?.field("length")?.number()?;
    Ok(())
}
pub fn footer(e: &Edge) -> Result<&Value> {
    e.at(6)
}
fn auth_key(e: &Edge) -> Result<String> {
    Ok(format!(
        "{}/{}/{}",
        e.at(3)?.field("height")?.number()?,
        footer(e)?.field("version")?.number()?,
        hex(footer(e)?.field("entropy")?.blob()?)
    ))
}
pub fn capability(e: &Edge) -> Result<String> {
    Ok(format!(
        "{}/{}",
        auth_key(e)?,
        footer(e)?.field("revision")?.text()?
    ))
}
pub fn weak(e: &Edge) -> Result<Value> {
    Ok(Value::map([
        ("height", e.at(3)?.field("height")?.clone()),
        ("version", footer(e)?.field("version")?.clone()),
        ("entropy", footer(e)?.field("entropy")?.clone()),
        ("revision", footer(e)?.field("revision")?.clone()),
    ]))
}
pub fn weak_key(link: &Value) -> Result<String> {
    Ok(format!(
        "{}/{}/{}/{}",
        link.field("height")?.number()?,
        link.field("version")?.number()?,
        hex(link.field("entropy")?.blob()?),
        link.field("revision")?.text()?
    ))
}
pub fn derive(e: &Edge) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    validate_pending(e)?;
    let prk = hmac(&[0; 48], footer(e)?.field("entropy")?.blob()?);
    let part = |name: &str, n: usize| {
        hmac(
            &prk,
            &[format!("basinsync/basin-node/0/{name}").as_bytes(), &[1]].concat(),
        )[..n]
            .to_vec()
    };
    Ok((part("token", 32), part("secret", 32), part("nonce", 12)))
}
pub fn distinct(edges: &[Edge]) -> Result<Vec<Edge>> {
    let mut result = BTreeMap::<String, Edge>::new();
    for e in edges {
        validate_edge(e)?;
        let k = auth_key(e)?;
        if let Some(old) = result.get(&k) {
            ensure!(
                footer(old)?.field("sha384")? == footer(e)?.field("sha384")?
                    && footer(old)?.field("revision")? == footer(e)?.field("revision")?,
                "conflicting edge descriptors"
            );
        }
        result.insert(k, e.clone());
    }
    Ok(result.into_values().collect())
}
pub fn empty_query() -> Value {
    Value::map([
        ("height", 0u32.into()),
        ("degree", 0u32.into()),
        ("breadth", Big(0.into())),
        ("rotations", Null),
        ("versions", Null),
        ("schemas", Null),
        ("migrations", Null),
    ])
}
pub fn query(edges: &[Edge], max_degree: usize, max_height: u32) -> Result<Value> {
    let edges = distinct(edges)?;
    ensure!(edges.len() <= max_degree, "basin degree limit");
    if edges.is_empty() {
        return Ok(empty_query());
    }
    let height = edges
        .iter()
        .map(|e| e.at(3)?.field("height")?.number())
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .max()
        .unwrap()
        .checked_add(1)
        .context("height overflow")?;
    ensure!(height <= max_height, "basin height limit");
    let mut breadth = BigInt::from(edges.len());
    let mut ranges = BTreeMap::<&str, Vec<u32>>::from([
        ("rotations", vec![]),
        ("versions", vec![]),
        ("schemas", vec![]),
        ("migrations", vec![]),
    ]);
    for e in &edges {
        let q = e.at(3)?;
        breadth += q.field("breadth")?.big()?;
        for (name, own) in [
            ("rotations", footer(e)?.field("rotation")?),
            ("versions", footer(e)?.field("version")?),
            ("schemas", e.at(4)?),
            ("migrations", footer(e)?.field("0")?),
        ] {
            let list = ranges.get_mut(name).unwrap();
            list.push(own.number()?);
            if !q.field(name)?.is_null() {
                for v in q.field(name)?.array()? {
                    list.push(v.number()?);
                }
            }
        }
    }
    let mut q = empty_query();
    q.set("height", height.into())?;
    q.set("degree", edges.len().into())?;
    q.set("breadth", Big(breadth))?;
    for (name, vs) in ranges {
        q.set(
            name,
            Array(vec![
                (*vs.iter().min().unwrap()).into(),
                (*vs.iter().max().unwrap()).into(),
            ]),
        )?;
    }
    Ok(q)
}
/// A browser host can fetch this edge asynchronously, insert it, then retry the read.
#[derive(Debug, Clone)]
pub struct MissingNode {
    pub edge: Edge,
}
impl std::fmt::Display for MissingNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "missing basin node")
    }
}
impl std::error::Error for MissingNode {}
pub trait Storage {
    fn put(&mut self, edge: &PendingEdge, bytes: &[u8], edges: &[Edge]) -> Result<String>;
    fn get(&mut self, edge: &Edge) -> Result<Vec<u8>>;
    fn resolve(&mut self, _link: &Value) -> Result<Option<Edge>> {
        Ok(None)
    }
}
#[derive(Default)]
pub struct MemoryStorage {
    pub objects: BTreeMap<String, (Edge, Vec<u8>)>,
    pub capabilities: BTreeMap<String, Edge>,
    pub reads: usize,
    next_revision: u64,
    pub edges: BTreeMap<String, Vec<Edge>>,
}
impl MemoryStorage {
    pub fn restore(&mut self, e: &Edge, b: &[u8], edges: &[Edge]) -> Result<()> {
        validate_edge(e)?;
        let k = capability(e)?;
        if let Some((_, old)) = self.objects.get(&k) {
            ensure!(old == b, "immutable storage conflict");
        }
        self.edges.insert(k.clone(), edges.to_vec());
        self.objects.insert(k.clone(), (e.clone(), b.to_vec()));
        self.capabilities.insert(k, e.clone());
        Ok(())
    }
}
impl Storage for MemoryStorage {
    fn put(&mut self, pending: &PendingEdge, b: &[u8], edges: &[Edge]) -> Result<String> {
        let auth = auth_key(pending.as_value())?;
        for (e, old) in self.objects.values() {
            if auth_key(e)? == auth {
                ensure!(old == b, "immutable storage conflict");
                return Ok(footer(e)?.field("revision")?.text()?.into());
            }
        }
        // Predictable UUIDv4-shaped identities are for this in-memory test store only.
        let revision = loop {
            self.next_revision += 1;
            let r = format!("00000000-0000-4000-8000-{:012x}", self.next_revision);
            if !self.capabilities.contains_key(&format!("{auth}/{r}")) {
                break r;
            }
        };
        self.restore(&pending.allocated(&revision)?, b, edges)?;
        Ok(revision)
    }
    fn get(&mut self, e: &Edge) -> Result<Vec<u8>> {
        self.reads += 1;
        Ok(self
            .objects
            .get(&capability(e)?)
            .ok_or_else(|| MissingNode { edge: e.clone() })?
            .1
            .clone())
    }
    fn resolve(&mut self, link: &Value) -> Result<Option<Edge>> {
        Ok(self.capabilities.get(&weak_key(link)?).cloned())
    }
}
pub struct Basin<S: Storage> {
    pub storage: S,
    pub seed: Vec<u8>,
    pub rotation: u32,
    pub max_degree: usize,
    pub max_height: u32,
    pub max_bytes: usize,
    pub max_cache_bytes: usize,
    cache: BTreeMap<String, Arc<Vec<u8>>>,
}
impl<S: Storage> Basin<S> {
    pub fn new(storage: S, seed: Vec<u8>) -> Result<Self> {
        ensure!(
            seed.len() >= 32,
            "seed must contain at least 256 secret bits"
        );
        Ok(Self {
            storage,
            seed,
            rotation: 0,
            max_degree: 320,
            max_height: 128,
            max_bytes: 64 * 1024 * 1024,
            max_cache_bytes: 16 * 1024 * 1024,
            cache: BTreeMap::new(),
        })
    }
    pub fn seal(&mut self, mut node: Value, edges: &[Edge]) -> Result<Edge> {
        let refs = distinct(edges)?;
        node.set("3", query(&refs, self.max_degree, self.max_height)?)?;
        let bytes = frame(&value::encode(&node)?)?;
        ensure!(bytes.len() <= self.max_bytes, "basin node byte limit");
        let digest = sha384(&bytes);
        let entropy = hmac(
            &self.seed,
            &[b"basinsync/basin-node/entropy/0".as_slice(), &digest].concat(),
        )[..32]
            .to_vec();
        let weight = refs.iter().try_fold(BigInt::from(bytes.len()), |n, e| {
            Ok::<_, anyhow::Error>(n + footer(e)?.field("weight")?.big()?)
        })?;
        let edge = Array(vec![
            Symbol("match".into()),
            node.index(1)?.clone(),
            node.index(2)?.clone(),
            node.index(3)?.clone(),
            node.index(4)?.clone(),
            node.index(5)?.clone(),
            Value::map([
                ("0", node.index(6)?.at(0)?.clone()),
                ("1", node.index(6)?.at(1)?.clone()),
                ("version", 0u32.into()),
                ("length", bytes.len().into()),
                ("weight", Big(weight)),
                ("sha384", Blob(digest)),
                ("entropy", Blob(entropy)),
                ("rotation", self.rotation.into()),
            ]),
        ]);
        let pending = PendingEdge(edge);
        let revision = self.storage.put(&pending, &bytes, &refs)?;
        pending.allocated(&revision)
    }
    pub fn load(&mut self, e: &Edge) -> Result<Arc<Vec<u8>>> {
        validate_edge(e)?;
        let k = format!(
            "{}/{}",
            capability(e)?,
            hex(footer(e)?.field("sha384")?.blob()?)
        );
        let bytes = if let Some(v) = self.cache.get(&k) {
            v.clone()
        } else {
            let b = self.storage.get(e)?;
            ensure!(
                b.len() == footer(e)?.field("length")?.number()? as usize
                    && sha384(&b) == footer(e)?.field("sha384")?.blob()?,
                "basin node digest/length mismatch"
            );
            let bytes = Arc::new(b);
            if bytes.len() <= self.max_cache_bytes {
                while !self.cache.is_empty()
                    && (self.cache.len() >= 128
                        || self.cache.values().map(|v| v.len()).sum::<usize>() + bytes.len()
                            > self.max_cache_bytes)
                {
                    self.cache.pop_first();
                }
                self.cache.insert(k, bytes.clone());
            }
            bytes
        };
        let r = node_reader(&bytes)?;
        for (k, expected) in [
            ("1", e.at(1)?),
            ("2", e.at(2)?),
            ("3", e.at(3)?),
            ("4", e.at(4)?),
            ("5", e.at(5)?),
        ] {
            ensure!(
                value::matches(value::field(r.clone(), k)?, expected)?,
                "edge summary mismatch"
            );
        }
        let f = value::field(r, "6")?;
        ensure!(
            value::matches(value::item(f.clone(), 0)?, footer(e)?.field("0")?)?
                && value::matches(value::item(f, 1)?, footer(e)?.field("1")?)?,
            "edge summary mismatch"
        );
        Ok(bytes)
    }
    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }
}

/// Resolve a shared-heap object without looking up the allocation in the Basin.
pub fn node_key(link: &Value, generation: &str) -> Result<String> {
    ensure!(matches!(generation, "young" | "old"), "invalid generation");
    let height = link.field("height")?.number()?;
    let version = link.field("version")?.number()?;
    let revision = link.field("revision")?.text()?;
    let entropy = link.field("entropy")?.blob()?;
    ensure!(
        version == 0 && valid_revision(revision) && entropy.len() == 32,
        "invalid node pointer"
    );
    let prk = hmac(&[0; 48], entropy);
    let token = hmac(
        &prk,
        &[b"basinsync/basin-node/0/token".as_slice(), &[1]].concat(),
    )[..32]
        .to_vec();
    fn lex(n: u32, negative: bool) -> String {
        let hex = format!("{n:x}");
        let size = (hex.len() - 1) as u8;
        let body: String = hex
            .bytes()
            .map(|b| {
                if negative {
                    char::from(b"fedcba9876543210"[(b as char).to_digit(16).unwrap() as usize])
                } else {
                    char::from(b)
                }
            })
            .collect();
        format!(
            "0{}{}{body}",
            if negative { 'y' } else { 'z' },
            char::from(if negative { b'v' - size } else { b'g' + size })
        )
    }
    Ok(format!(
        "userspace/heap/{generation}/n-{}/v.{}/t.{}/d_{}/{revision}",
        lex(height, true),
        lex(version, false),
        lex(token.len() as u32, false),
        hex(&sha384(&token))
    ))
}
