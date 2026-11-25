//! Internal, shallow KernelSpace reservations and Basin backup roots.
use crate::{event, heap, lexidecimal::Viewpoint, timeline, turso};
use anyhow::{Context, Result, ensure};
use num_bigint::BigUint;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use turso_core::Connection;

pub mod promotion;
pub(crate) mod roots;

pub const ID: &str = "kernel.turso";
pub const YOUNG: &str = "kernelspace/basin/heap/young/";
pub const OLD: &str = "kernelspace/basin/heap/old/";
pub const SCHEMA: &str = "CREATE TABLE basin (id INTEGER PRIMARY KEY CHECK(id=1), milestone TEXT NOT NULL); INSERT INTO basin VALUES(1,'0'); CREATE TABLE kernel_state (id INTEGER PRIMARY KEY CHECK(id=1), next_viewpoint TEXT NOT NULL, activity TEXT NOT NULL); INSERT INTO kernel_state VALUES(1,'0','0'); CREATE TABLE kernelspace_nodes (id TEXT PRIMARY KEY NOT NULL, content_length INTEGER NOT NULL CHECK(content_length>=0), reserved DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, etag TEXT NOT NULL DEFAULT '', promoted DATETIME NOT NULL DEFAULT '', revision TEXT NOT NULL, freed DATETIME NOT NULL DEFAULT '', marked DATETIME NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '{}', sha384 TEXT NOT NULL); CREATE INDEX kernelspace_nodes_freed ON kernelspace_nodes(freed,id); CREATE INDEX kernelspace_nodes_promotion ON kernelspace_nodes(promoted,marked); CREATE TABLE kernelspace_edges (node TEXT NOT NULL, retainer TEXT NOT NULL, PRIMARY KEY(node,retainer), CHECK(retainer<node)); CREATE INDEX kernelspace_edges_retainer ON kernelspace_edges(retainer,node); CREATE TABLE marking_tasks (flow TEXT NOT NULL, viewpoint TEXT NOT NULL, upstream TEXT NOT NULL, prioritized DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(flow,viewpoint)); CREATE INDEX marking_tasks_prioritized ON marking_tasks(prioritized,flow,viewpoint); CREATE TABLE kernel_commits (viewpoint TEXT PRIMARY KEY NOT NULL, upstream TEXT NOT NULL, covered TEXT NOT NULL, sha384 TEXT NOT NULL);";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub revision: String,
    pub length: u64,
    pub sha384: String,
}
impl Node {
    pub fn new(length: u64, sha384: String) -> Self {
        let token = uuid::Uuid::new_v4();
        Self {
            id: heap::node_id(0, 0, token.as_bytes()),
            revision: uuid::Uuid::new_v4().to_string(),
            length,
            sha384,
        }
    }
    pub fn key(&self, generation: &str) -> Result<String> {
        self.validate()?;
        ensure!(
            generation == YOUNG || generation == OLD,
            "invalid KernelSpace generation"
        );
        Ok(format!("{generation}{}/{}", self.id, self.revision))
    }
    pub fn validate(&self) -> Result<()> {
        heap::Node {
            context: Default::default(),
            id: self.id.clone(),
            length: self.length,
            edges: Default::default(),
        }
        .validate()?;
        ensure!(
            self.id
                .starts_with(&format!("n-{}/", crate::lexidecimal::encode(&(-1).into()))),
            "backup nodes must have height zero"
        );
        ensure!(
            uuid::Uuid::parse_str(&self.revision)?.get_version_num() == 4
                && uuid::Uuid::parse_str(&self.revision)?.to_string() == self.revision,
            "expected UUIDv4 revision"
        );
        ensure!(
            self.length >= turso::PAGE_SIZE as u64
                && self.length.is_multiple_of(turso::PAGE_SIZE as u64),
            "invalid database node length"
        );
        ensure!(
            self.sha384.len() == 96
                && self
                    .sha384
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid node checksum"
        );
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Graph {
    pub version: String,
    pub milestone: String,
    pub coordinate: String,
    pub crc32c: String,
    pub parent: String,
    pub databases: BTreeMap<String, Node>,
}
impl Graph {
    pub fn new(prefix: &timeline::Prefix, databases: BTreeMap<String, Node>) -> Result<Self> {
        let result = Self {
            version: turso::VERSION.into(),
            milestone: prefix.milestone().to_string(),
            coordinate: prefix.coordinate().to_string(),
            crc32c: crate::checksum::format(prefix.crc32c()),
            parent: prefix.digest().context("backup has no predecessor")?.into(),
            databases,
        };
        result.validate()?;
        Ok(result)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(self.version == turso::VERSION, "unsupported backup engine");
        for text in [&self.milestone, &self.coordinate] {
            let n: BigUint = text.parse()?;
            ensure!(n.to_string() == *text, "noncanonical backup prefix");
        }
        ensure!(
            self.milestone != "0"
                && self.coordinate != "0"
                && self.parent.len() == 96
                && self
                    .parent
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid backup prefix"
        );
        crate::checksum::parse(&self.crc32c)?;
        ensure!(
            self.databases.len() == 2
                && self.databases.contains_key(turso::ID)
                && self.databases.contains_key(ID),
            "backup must contain both databases"
        );
        for node in self.databases.values() {
            node.validate()?;
        }
        ensure!(
            self.databases[turso::ID].id != self.databases[ID].id,
            "duplicate backup node"
        );
        Ok(())
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        Ok(flexbuffers::to_vec(self)?)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        crate::flexbuffer::check_layout(bytes)?;
        let graph: Self = flexbuffers::from_slice(bytes)?;
        graph.validate()?;
        Ok(graph)
    }
    pub fn checkpoint(
        &self,
        viewpoint: Viewpoint,
        blob: &[u8],
    ) -> Result<crate::epilogue::Checkpoint> {
        ensure!(
            Self::decode(blob)? == *self,
            "backup message disagrees with graph"
        );
        Ok(crate::epilogue::Checkpoint {
            crc32c: crate::checksum::parse(&self.crc32c)?,
            coordinate: self.coordinate.parse()?,
            viewpoint,
            milestone: self.milestone.parse()?,
            digest: self.parent.clone(),
            sha384: event::digest(blob),
            version: self.version.clone(),
        })
    }
}
/// A `commitkernel` command. Like a Commitflow marker it carries the root
/// message's exact bytes, so its digest never depends on re-encoding: other
/// writers may lay out the same FlexBuffers map differently.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "CommitWire", into = "CommitWire")]
pub struct Commit {
    pub viewpoint: String,
    pub graph: Graph,
    pub blob: Vec<u8>,
}
impl Commit {
    pub fn new(viewpoint: String, graph: Graph) -> Result<Self> {
        let blob = graph.encode()?;
        Ok(Self {
            viewpoint,
            graph,
            blob,
        })
    }
    pub fn from_blob(viewpoint: String, blob: Vec<u8>) -> Result<Self> {
        Ok(Self {
            viewpoint,
            graph: Graph::decode(&blob)?,
            blob,
        })
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitWire {
    viewpoint: String,
    sha384: String,
    #[serde(with = "serde_bytes")]
    blob: Vec<u8>,
}
impl TryFrom<CommitWire> for Commit {
    type Error = anyhow::Error;
    fn try_from(wire: CommitWire) -> Result<Self> {
        ensure!(
            wire.sha384 == event::digest(&wire.blob),
            "commitkernel digest mismatch"
        );
        Self::from_blob(wire.viewpoint, wire.blob)
    }
}
impl From<Commit> for CommitWire {
    fn from(commit: Commit) -> Self {
        Self {
            viewpoint: commit.viewpoint,
            sha384: event::digest(&commit.blob),
            blob: commit.blob,
        }
    }
}
#[derive(Clone)]
pub enum Operation {
    Reserve(Graph),
    Promote(promotion::Change),
    Commit {
        command: Commit,
        etags: BTreeMap<String, String>,
    },
}
pub struct Request {
    pub span: tracing::Span,
    pub operation: Operation,
    pub reply: tokio::sync::oneshot::Sender<Result<Viewpoint>>,
}

pub(crate) fn text(conn: &std::sync::Arc<Connection>, sql: &str) -> Result<String> {
    let mut result = None;
    turso::rows(conn, sql, |row| {
        ensure!(result.is_none(), "expected scalar");
        result = Some(row.get::<String>(0)?);
        Ok(())
    })?;
    result.context("missing kernel state")
}
pub(crate) fn next(conn: &std::sync::Arc<Connection>) -> Result<Viewpoint> {
    Viewpoint::parse(&text(
        conn,
        "SELECT next_viewpoint FROM kernel_state WHERE id=1",
    )?)
}
pub(crate) fn activity(conn: &std::sync::Arc<Connection>) -> Result<BigUint> {
    Ok(text(conn, "SELECT activity FROM kernel_state WHERE id=1")?.parse()?)
}
fn q(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}
fn retainer(kind: &str, viewpoint: &Viewpoint) -> String {
    format!(
        "_{kind}_basin/v.{}/e.{}",
        crate::lexidecimal::encode(&0.into()),
        viewpoint.lexidecimal()
    )
}
fn advancing(conn: &std::sync::Arc<Connection>, graph: &Graph) -> Result<()> {
    let mut previous = None;
    turso::rows(
        conn,
        "SELECT covered FROM kernel_commits ORDER BY viewpoint DESC LIMIT 1",
        |row| {
            previous = Some(
                crate::lexidecimal::decode(&row.get::<String>(0)?)?
                    .to_biguint()
                    .context("negative backup prefix")?,
            );
            Ok(())
        },
    )?;
    if let Some(previous) = previous {
        ensure!(
            graph.milestone.parse::<BigUint>()? > previous,
            "backup prefix must advance"
        );
    }
    Ok(())
}
pub(crate) fn reserve(
    conn: &std::sync::Arc<Connection>,
    graph: &Graph,
    viewpoint: &Viewpoint,
) -> Result<()> {
    graph.validate()?;
    advancing(conn, graph)?;
    for node in graph.databases.values() {
        let mut existing = None;
        turso::rows(
            conn,
            &format!(
                "SELECT content_length,revision,sha384 FROM kernelspace_nodes WHERE id={}",
                q(&node.id)
            ),
            |r| {
                existing = Some((r.get::<i64>(0)?, r.get::<String>(1)?, r.get::<String>(2)?));
                Ok(())
            },
        )?;
        if let Some(row) = existing {
            ensure!(
                row == (
                    i64::try_from(node.length)?,
                    node.revision.to_string(),
                    node.sha384.clone()
                ),
                "conflicting kernel reservation"
            );
        } else {
            conn.execute(format!("INSERT INTO kernelspace_nodes(id,content_length,revision,sha384) VALUES({},{},{},{})",q(&node.id),node.length,q(&node.revision.to_string()),q(&node.sha384)))?;
        }
        conn.execute(format!(
            "INSERT OR IGNORE INTO kernelspace_edges VALUES({},{})",
            q(&node.id),
            q(&retainer("a", viewpoint))
        ))?;
    }
    Ok(())
}
pub(crate) fn commit(
    conn: &std::sync::Arc<Connection>,
    command: &Commit,
    etags: &BTreeMap<String, String>,
    upstream: &BigUint,
) -> Result<()> {
    let viewpoint = Viewpoint::parse(&command.viewpoint)?;
    ensure!(next(conn)? == viewpoint, "Kernel Viewpoint mismatch");
    command.graph.validate()?;
    advancing(conn, &command.graph)?;
    for node in command.graph.databases.values() {
        let mut matched = false;
        turso::rows(
            conn,
            &format!(
                "SELECT content_length,revision,sha384 FROM kernelspace_nodes WHERE id={} AND EXISTS(SELECT 1 FROM kernelspace_edges WHERE node={} AND retainer={})",
                q(&node.id),
                q(&node.id),
                q(&retainer("a", &viewpoint))
            ),
            |r| {
                matched = r.get::<i64>(0)? == i64::try_from(node.length)?
                    && r.get::<String>(1)? == node.revision
                    && r.get::<String>(2)? == node.sha384;
                Ok(())
            },
        )?;
        ensure!(matched, "missing or changed kernel reservation");
        let etag = etags
            .get(&node.id)
            .filter(|s| !s.is_empty())
            .context("unverified kernel edge")?;
        conn.execute(format!(
            "UPDATE kernelspace_nodes SET etag={} WHERE id={}",
            q(etag),
            q(&node.id)
        ))?;
        conn.execute(format!(
            "INSERT INTO kernelspace_edges VALUES({},{})",
            q(&node.id),
            q(&retainer("m", &viewpoint))
        ))?;
    }
    conn.execute(format!(
        "DELETE FROM kernelspace_edges WHERE retainer={}",
        q(&retainer("a", &viewpoint))
    ))?;
    let index = roots::Index::from_command(command, upstream)?;
    conn.execute(format!(
        "INSERT INTO kernel_commits(viewpoint,upstream,covered,sha384) VALUES({},{},{},{})",
        q(&viewpoint.lexidecimal()),
        q(&crate::promotion::upstream_key(upstream)),
        q(&crate::promotion::upstream_key(&index.covered)),
        q(&index.sha384)
    ))?;
    conn.execute(format!(
        "INSERT INTO marking_tasks(flow,viewpoint,upstream) VALUES('basin',{},{})",
        q(&viewpoint.lexidecimal()),
        q(&crate::promotion::upstream_key(upstream))
    ))?;
    conn.execute(format!(
        "UPDATE kernel_state SET next_viewpoint={} WHERE id=1",
        q(&viewpoint.next().decimal())
    ))?;
    Ok(())
}
pub(crate) fn committed(view: &std::sync::Arc<turso::cow::View>) -> Result<Vec<roots::Index>> {
    let conn = view.connect()?;
    let mut result = vec![];
    turso::rows(
        &conn,
        "SELECT viewpoint,upstream,covered,sha384 FROM kernel_commits ORDER BY viewpoint",
        |row| {
            result.push(roots::Index::from_row(row)?);
            Ok(())
        },
    )?;
    Ok(result)
}

/// Read the immutable revision outside the writer; the transaction rechecks its descriptor.
pub async fn verify(bucket: &s3::Bucket, graph: &Graph) -> Result<BTreeMap<String, String>> {
    graph.validate()?;
    let mut etags = BTreeMap::new();
    for node in graph.databases.values() {
        let mut found = None;
        for generation in [YOUNG, OLD] {
            let (head, status) = crate::object_read::if_present(bucket)?
                .head_object(node.key(generation)?)
                .await?;
            match status {
                200 => {
                    ensure!(
                        head.content_length == Some(i64::try_from(node.length)?),
                        "kernel node length mismatch"
                    );
                    ensure!(
                        head.metadata.as_ref().and_then(|m| m.get("sha384")) == Some(&node.sha384),
                        "kernel node checksum metadata mismatch"
                    );
                    found = Some(head.e_tag.context("kernel node has no ETag")?);
                    break;
                }
                404 | 412 => {}
                _ => anyhow::bail!("kernel node HEAD returned HTTP {status}"),
            }
        }
        etags.insert(
            node.id.clone(),
            found.context("kernel node is not uploaded")?,
        );
    }
    Ok(etags)
}
pub async fn image(bucket: &s3::Bucket, node: &Node) -> Result<Vec<u8>> {
    for generation in [OLD, YOUNG] {
        let response = crate::object_read::if_present(bucket)?
            .get_object(node.key(generation)?)
            .await?;
        match response.status_code() {
            200 => {
                let bytes = response.as_slice();
                ensure!(
                    bytes.len() as u64 == node.length && event::digest(bytes) == node.sha384,
                    "kernel database node checksum/length mismatch"
                );
                return Ok(bytes.to_vec());
            }
            404 | 412 => {}
            status => anyhow::bail!("kernel node GET returned HTTP {status}"),
        }
    }
    anyhow::bail!("missing kernel database node")
}

pub async fn upload(
    bucket: &s3::Bucket,
    node: &Node,
    path: &std::path::Path,
    mut headers: axum::http::HeaderMap,
) -> Result<()> {
    headers.insert(
        axum::http::header::CONTENT_LENGTH,
        node.length.to_string().parse()?,
    );
    let signed = headers
        .iter()
        .map(|(k, v)| Ok((k.to_string(), v.to_str()?.to_string())))
        .collect::<Result<BTreeMap<_, _>>>()?;
    let access = crate::range_get::signed_request(bucket, &node.key(YOUNG)?, "PUT", signed).await?;
    let mut request = bucket
        .http_client()
        .put(&access.url)
        .body(tokio::fs::File::open(path).await?);
    for (key, value) in access.headers {
        request = request.header(key, value);
    }
    if let Some(timeout) = bucket.request_timeout {
        request = request.timeout(timeout);
    }
    let response = request.send().await.map_err(|error| error.without_url())?;
    ensure!(
        response.status().is_success(),
        "kernel node upload returned HTTP {}",
        response.status()
    );
    Ok(())
}
