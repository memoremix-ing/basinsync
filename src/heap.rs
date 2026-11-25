//! Token-free heap reservations. Raw authentication material stops at this boundary.
use crate::{
    event,
    lexidecimal::{self, Viewpoint},
    range_get::{self, Access},
};
use anyhow::{Result, ensure};
use num_bigint::BigInt;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const YOUNG: &str = "userspace/heap/young/";
pub const OLD: &str = "userspace/heap/old/";

pub fn canonical_context(context: &BTreeMap<String, String>) -> Result<BTreeMap<String, String>> {
    crate::details::context_headers(context)?;
    Ok(context
        .iter()
        .map(|(key, value)| (key.to_ascii_lowercase(), value.clone()))
        .collect())
}

pub struct Limits {
    pub max_height: u64,
    pub max_degree: usize,
    pub max_token_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_height: 128,
            max_degree: 320,
            max_token_bytes: 64,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct NodeError {
    pub code: &'static str,
    pub message: &'static str,
}
fn invalid(code: &'static str, message: &'static str) -> NodeError {
    NodeError { code, message }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRequest {
    #[serde(deserialize_with = "crate::json0::deserialize_text")]
    flow: String,
    #[serde(deserialize_with = "crate::json0::deserialize_viewpoint")]
    viewpoint: Viewpoint,
    nodes: Vec<serde_json::Value>,
}
#[derive(Deserialize)]
struct Auth(
    u64,
    u64,
    #[serde(deserialize_with = "crate::json0::deserialize_bytes")] Vec<u8>,
);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireNode {
    #[serde(default, deserialize_with = "crate::json0::deserialize_text_map")]
    context: BTreeMap<String, String>,
    auth: Auth,
    length: u64,
    edges: Vec<WireEdge>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireEdge {
    auth: Auth,
    #[serde(default)]
    revision: Option<WireRevision>,
}
#[derive(Deserialize)]
struct WireRevision(#[serde(deserialize_with = "crate::json0::deserialize_text")] String);
fn authenticate(auth: Auth, limits: &Limits) -> Result<(u64, String), NodeError> {
    let Auth(height, version, token) = auth;
    if height > limits.max_height {
        return Err(invalid(
            "height_limit",
            "node height exceeds the service limit",
        ));
    }
    if version != 0 {
        return Err(invalid(
            "unsupported_version",
            "only version zero is supported",
        ));
    }
    if token.len() > limits.max_token_bytes {
        return Err(invalid(
            "token_limit",
            "access token exceeds the service limit",
        ));
    }
    Ok((height, node_id(height, version, &token)))
}
pub fn authenticate_edges(
    wire: Vec<WireEdge>,
    limits: &Limits,
    parent_height: Option<u64>,
) -> Result<BTreeSet<String>, NodeError> {
    Ok(authenticate_pinned_edges(wire, limits, parent_height)?.0)
}
pub fn authenticate_pinned_edges(
    wire: Vec<WireEdge>,
    limits: &Limits,
    parent_height: Option<u64>,
) -> Result<(BTreeSet<String>, BTreeMap<String, String>), NodeError> {
    let mut edges = BTreeSet::new();
    let mut revisions = BTreeMap::new();
    for edge in wire {
        let (height, id) = authenticate(edge.auth, limits)?;
        if parent_height.is_some_and(|p| height >= p) {
            return Err(invalid(
                "invalid_height",
                "parent height must exceed every child height",
            ));
        }
        if let Some(wire_revision) = edge.revision {
            // Decode text without leaking authentication material in errors.
            let revision = wire_revision.0;
            if valid_revision(&revision).is_err() {
                return Err(invalid(
                    "invalid_revision",
                    "expected a canonical UUIDv4 node revision",
                ));
            }
            if revisions
                .insert(id.clone(), revision.clone())
                .is_some_and(|old| old != revision)
            {
                return Err(invalid("revision_collision", "conflicting child revisions"));
            }
        }
        edges.insert(id);
        if edges.len() > limits.max_degree {
            return Err(invalid(
                "degree_limit",
                "node degree exceeds the service limit",
            ));
        }
    }
    Ok((edges, revisions))
}
pub fn marker_retainer(flow: &str, viewpoint: &Viewpoint) -> String {
    retainer(flow, viewpoint).replacen("_a_", "_m_", 1)
}
#[derive(Clone, Debug)]
pub struct Child {
    pub revision: String,
    pub length: u64,
    pub etag: String,
}

pub struct Request {
    pub revisions: BTreeMap<usize, BTreeMap<String, String>>,
    pub flow: String,
    pub viewpoint: Viewpoint,
    pub nodes: Vec<Result<Node, NodeError>>,
    pub proofs: BTreeMap<String, Result<Child, NodeError>>,
}
impl Request {
    pub fn parse(bytes: &[u8], limits: &Limits) -> Result<Self> {
        // Never propagate deserializer errors that could quote authentication material.
        let mut wire: WireRequest =
            serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("invalid heap request"))?;
        wire.flow = event::normalize_flow(&wire.flow)?;
        crate::epilogue::check_flow_key(&wire.flow, &wire.viewpoint)?;
        let mut revisions = BTreeMap::new();
        let nodes = wire
            .nodes
            .into_iter()
            .enumerate()
            .map(|(index, value)| {
                let wire: WireNode = serde_json::from_value(value).map_err(|_| {
                    invalid("invalid_node", "invalid node fields or authentication")
                })?;
                let context = canonical_context(&wire.context)
                    .map_err(|_| invalid("invalid_context", "invalid S3 context metadata"))?;
                let (height, id) = authenticate(wire.auth, limits)?;
                let (edges, pinned) = authenticate_pinned_edges(wire.edges, limits, Some(height))?;
                revisions.insert(index, pinned);
                if wire.length > i64::MAX as u64 {
                    return Err(invalid(
                        "invalid_length",
                        "content length exceeds the database integer range",
                    ));
                }
                Ok(Node {
                    context,
                    id,
                    length: wire.length,
                    edges,
                })
            })
            .collect();
        Ok(Self {
            revisions,
            flow: wire.flow,
            viewpoint: wire.viewpoint,
            nodes,
            proofs: BTreeMap::new(),
        })
    }
    pub async fn verify_children(
        &mut self,
        bucket: &s3::Bucket,
        permits: std::sync::Arc<tokio::sync::Semaphore>,
    ) {
        verify_children(&mut self.proofs, bucket, permits).await;
    }
}
pub type Proofs = BTreeMap<String, Result<Child, NodeError>>;
pub async fn verify_children(
    proofs: &mut Proofs,
    bucket: &s3::Bucket,
    permits: std::sync::Arc<tokio::sync::Semaphore>,
) {
    let candidates = std::mem::take(proofs);
    let mut running = tokio::task::JoinSet::new();
    let mut pending = candidates.into_iter();
    loop {
        while running.len() < 8 {
            let Some((id, proof)) = pending.next() else {
                break;
            };
            let bucket = bucket.clone();
            let permits = permits.clone();
            running.spawn(async move {
                let verified = match proof {
                    Ok(mut child) if child.etag.is_empty() => {
                        let _permit = permits
                            .acquire_owned()
                            .await
                            .expect("heap HEAD limiter stays open");
                        match child_etag(&bucket, &id, &child).await {
                            Ok(etag) => {
                                child.etag = etag;
                                Ok(child)
                            }
                            Err(error) => Err(error),
                        }
                    }
                    other => other,
                };
                (id, verified)
            });
        }
        let Some(result) = running.join_next().await else {
            break;
        };
        if let Ok((id, proof)) = result {
            proofs.insert(id, proof);
        }
    }
}

async fn child_etag(bucket: &s3::Bucket, id: &str, child: &Child) -> Result<String, NodeError> {
    let reader = crate::object_read::if_present(bucket)
        .map_err(|_| invalid("child_unavailable", "child object verification failed"))?;
    for generation in [YOUNG, OLD] {
        let result = reader
            .head_object(key(generation, id, &child.revision))
            .await;
        match result {
            Ok((head, 200)) => {
                if head.content_length.and_then(|n| u64::try_from(n).ok()) != Some(child.length) {
                    return Err(invalid(
                        "child_length_mismatch",
                        "child object length differs from its reservation",
                    ));
                }
                return head
                    .e_tag
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| invalid("child_unavailable", "child object has no ETag"));
            }
            Ok((_, 404 | 412)) => {}
            _ => {
                return Err(invalid(
                    "child_unavailable",
                    "child object verification failed",
                ));
            }
        }
    }
    Err(invalid(
        "child_missing",
        "child object is absent from both generations",
    ))
}

pub fn node_id(height: u64, version: u64, token: &[u8]) -> String {
    format!(
        "n-{}/v.{}/t.{}/d_{}",
        lexidecimal::encode(&!BigInt::from(height)),
        lexidecimal::encode(&BigInt::from(version)),
        lexidecimal::encode(&BigInt::from(token.len())),
        event::digest(token)
    )
}
pub fn retainer(flow: &str, viewpoint: &Viewpoint) -> String {
    format!(
        "_a_{flow}/v.{}/e.{}",
        lexidecimal::encode(&0.into()),
        viewpoint.lexidecimal()
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub context: BTreeMap<String, String>,
    pub id: String,
    pub length: u64,
    pub edges: BTreeSet<String>,
}
impl Node {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            canonical_context(&self.context)? == self.context,
            "noncanonical node context"
        );
        let parts: Vec<_> = self.id.split('/').collect();
        ensure!(
            parts.len() == 4
                && parts[0].starts_with("n-")
                && parts[1] == format!("v.{}", lexidecimal::encode(&0.into())),
            "invalid node id"
        );
        let height = node_height(&self.id)?;
        for edge in &self.edges {
            Node {
                context: Default::default(),
                id: edge.clone(),
                length: 0,
                edges: BTreeSet::new(),
            }
            .validate()?;
            ensure!(node_height(edge)? < height, "invalid edge height");
        }
        let size = parts[2]
            .strip_prefix("t.")
            .ok_or_else(|| anyhow::anyhow!("missing token size"))?;
        let size = lexidecimal::decode(size)?;
        ensure!(
            size >= 0.into() && format!("t.{}", lexidecimal::encode(&size)) == parts[2],
            "invalid token size"
        );
        let digest = parts[3]
            .strip_prefix("d_")
            .ok_or_else(|| anyhow::anyhow!("missing derived subkey"))?;
        ensure!(
            digest.len() == 96
                && digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid derived subkey"
        );
        ensure!(self.length <= i64::MAX as u64, "invalid content length");
        Ok(())
    }
}

pub fn node_height(id: &str) -> Result<BigInt> {
    let encoded = id
        .split('/')
        .next()
        .and_then(|s| s.strip_prefix("n-"))
        .ok_or_else(|| anyhow::anyhow!("missing height"))?;
    let n = lexidecimal::decode(encoded)?;
    ensure!(
        n < 0.into() && lexidecimal::encode(&n) == encoded,
        "invalid complemented height"
    );
    Ok(!n)
}

pub fn valid_revision(revision: &str) -> Result<()> {
    let uuid = uuid::Uuid::parse_str(revision)?;
    ensure!(
        uuid.get_version_num() == 4
            && uuid.get_variant() == uuid::Variant::RFC4122
            && uuid.to_string() == revision,
        "invalid node revision"
    );
    Ok(())
}
pub fn key(generation: &str, id: &str, revision: &str) -> String {
    format!("{generation}{id}/{revision}")
}
#[derive(Clone, Debug)]
pub struct Allocation {
    pub context: BTreeMap<String, String>,
    pub edges: BTreeSet<String>,
    pub id: String,
    pub length: u64,
    pub revision: String,
}
impl Allocation {
    fn validate(&self) -> Result<()> {
        Node {
            context: self.context.clone(),
            id: self.id.clone(),
            length: self.length,
            edges: self.edges.clone(),
        }
        .validate()?;
        valid_revision(&self.revision)
    }
}
#[derive(Clone, Debug)]
pub struct Command {
    pub flow: String,
    pub viewpoint: String,
    pub reserved: String,
    pub nodes: Vec<Allocation>,
    pub children: BTreeMap<String, Child>,
}
impl Command {
    pub fn validate(&self) -> Result<Viewpoint> {
        event::valid_flow(&self.flow)?;
        ensure!(!self.nodes.is_empty(), "empty heap reservation command");
        time::OffsetDateTime::parse(
            &self.reserved,
            &time::format_description::well_known::Rfc3339,
        )?;
        let mut ids = std::collections::BTreeSet::new();
        for node in &self.nodes {
            node.validate()?;
            ensure!(ids.insert(&node.id), "duplicate reserved node");
        }
        Viewpoint::parse(&self.viewpoint)
    }
}

pub struct Reserved {
    pub context: BTreeMap<String, String>,
    pub id: String,
    pub revision: String,
    pub length: u64,
    pub write: bool,
    pub preview: bool,
}
#[derive(Default)]
pub struct Outcome {
    pub errors: BTreeMap<usize, NodeError>,
    pub results: BTreeMap<usize, Reserved>,
}
#[derive(Serialize)]
pub struct Actions {
    pub write: Option<Access>,
    pub preview: Option<Access>,
    pub read: Access,
}
#[derive(Serialize)]
pub struct NodeResult {
    #[serde(serialize_with = "crate::json0::serialize_text")]
    pub revision: String,
    pub actions: Actions,
}
#[derive(Serialize)]
pub struct Response {
    pub errors: Option<BTreeMap<usize, NodeError>>,
    pub results: Option<BTreeMap<usize, NodeResult>>,
}
impl Outcome {
    pub async fn actions(self, bucket: &s3::Bucket) -> Result<Response> {
        let mut results = BTreeMap::new();
        for (index, node) in self.results {
            let young = key(YOUNG, &node.id, &node.revision);
            let actions = Actions {
                write: if node.write {
                    Some(
                        range_get::presign_write(bucket, &young, node.length, &node.context)
                            .await?,
                    )
                } else {
                    None
                },
                preview: if node.preview {
                    Some(range_get::presign_whole(bucket, &young).await?)
                } else {
                    None
                },
                read: range_get::presign_whole(bucket, &key(OLD, &node.id, &node.revision)).await?,
            };
            results.insert(
                index,
                NodeResult {
                    revision: node.revision,
                    actions,
                },
            );
        }
        Ok(Response {
            errors: (!self.errors.is_empty()).then_some(self.errors),
            results: (!results.is_empty()).then_some(results),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    pub(crate) fn request(flow: &str, token: &[u8], length: u64) -> Request {
        let token = format!(
            "0*{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token)
        );
        Request::parse(serde_json::json!({"flow":flow,"viewpoint":"0x0","nodes":[{"auth":[0,0,token],"length":length,"edges":[]}]}).to_string().as_bytes(),&Limits::default()).unwrap()
    }
    #[test]
    fn revision_pins_and_responses_use_json0_strings() {
        let revision = "00000000-0000-4000-8000-000000000001";
        let wire = serde_json::json!([{"auth":[0,0,"0*"],"revision":format!("0{revision}")}]);
        let (ids, pinned) = authenticate_pinned_edges(
            serde_json::from_value(wire).unwrap(),
            &Limits::default(),
            Some(1),
        )
        .unwrap();
        assert_eq!(pinned[ids.first().unwrap()], revision);
        for wire in [
            serde_json::json!([{"auth":[0,0,"0*"],"revision":revision}]),
            serde_json::json!([{"auth":[0,0,"0*"],"revision":"bad-revision"}]),
        ] {
            let result = serde_json::from_value(wire).map_err(|_| ()).and_then(|v| {
                authenticate_pinned_edges(v, &Limits::default(), Some(1)).map_err(|_| ())
            });
            assert!(result.is_err());
        }
        let result = NodeResult {
            revision: revision.into(),
            actions: Actions {
                write: None,
                preview: None,
                read: Access {
                    url: "https://example.com/node".into(),
                    headers: Default::default(),
                },
            },
        };
        assert_eq!(
            serde_json::to_value(result).unwrap()["revision"],
            format!("0{revision}")
        );
    }

    #[test]
    fn ordered_node_ids_and_per_node_validation() {
        let child = node_id(0, 0, b"child");
        let parent = node_id(1, 0, b"parent");
        assert!(parent < child);
        assert!(retainer("snow-flow", &Viewpoint::zero()) < child);
        assert!(marker_retainer("snow-flow", &Viewpoint::zero()) < child);
        Node {
            context: Default::default(),
            id: child,
            edges: BTreeSet::new(),
            length: 0,
        }
        .validate()
        .unwrap();
        assert!(request("f", &[42; 64], 1).nodes[0].is_ok());
        assert_eq!(
            request("f", &[42; 65], 1).nodes[0]
                .as_ref()
                .unwrap_err()
                .code,
            "token_limit"
        );
        let request=Request::parse(br#"{"flow":"f","viewpoint":"0x0","nodes":[{"auth":[1,0,"0*"],"length":0,"edges":[]},{"auth":[0,1,"0*"],"length":0,"edges":[]},{"auth":[0,0,"0*"],"length":0,"edges":["edge"]},{"auth":[0,0,"secret-not-json0"],"length":0,"edges":[]}]}"#,&Limits::default()).unwrap();
        assert_eq!(
            request
                .nodes
                .iter()
                .skip(1)
                .map(|n| n.as_ref().unwrap_err().code)
                .collect::<Vec<_>>(),
            ["unsupported_version", "invalid_node", "invalid_node"]
        );
    }

    #[test]
    fn heap_frames_reconstruct_without_tokens_and_reject_false_commands() -> Result<()> {
        let secret = b"heap-test-secret-only-the-client-knows-92741";
        let request = request("f", secret, 128);
        let mut writer = crate::turso::wal::Writer::open(&crate::turso::State::genesis()?.image)?;
        let (captured, outcome) = writer.prepare_heap(&0u8.into(), None, &request)?;
        assert_eq!(outcome.results.len(), 1);
        let (command, delta) = captured.unwrap();
        let bytes = event::encode_wal(vec![], delta)?;
        let envelopes = crate::envbuf::all(crate::event::envelope(&bytes)?.content)?;
        assert_eq!(envelopes.len(), 2);
        assert_eq!(
            crate::envbuf::before(&bytes, bytes.len())?.content,
            &0u64.to_le_bytes()
        );
        assert!(event::blob_ranges(&bytes)?.is_empty());
        assert!(!bytes.windows(secret.len()).any(|w| w == secret));
        let mut recovered = crate::timeline::Basin::default();
        recovered.apply_entry(1u8.into(), &bytes)?;
        let state = recovered.database.as_ref().unwrap();
        assert!(!state.image.windows(secret.len()).any(|w| w == secret));
        assert!(recovered.latest("f")?.is_none());
        let event::Entry::Wal { delta, .. } = event::decode_entry(&bytes)? else {
            unreachable!()
        };
        let base = &delta.logical.base.as_ref().unwrap().0;
        let logical = crate::turso::State::ingest_logical(base, &delta.logical)?;
        assert_eq!(logical.image, state.image);
        state.verify_heap(None, &command)?;
        for fault in 0..4 {
            let mut command = command.clone();
            match fault {
                0 => command.nodes[0].length += 1,
                1 => command.reserved = "2000-01-01T00:00:00Z".into(),
                2 => {
                    command.nodes[0]
                        .context
                        .insert("changed".into(), "metadata".into());
                }
                _ => command.viewpoint = "1".into(),
            }
            assert!(state.verify_heap(None, &command).is_err());
        }
        Ok(())
    }

    #[test]
    fn repeated_heap_histories_have_identical_logical_and_physical_images() -> Result<()> {
        let mut image = crate::turso::State::genesis()?.image;
        let mut writer = crate::turso::wal::Writer::open(&image)?;
        let mut recovered = crate::timeline::Basin::default();
        let mut parent = None::<String>;
        for step in 0..40u32 {
            let n = step % 11;
            let node = Node {
                context: BTreeMap::from([
                    ("owner".into(), format!("owner-{n}")),
                    ("tag".into(), format!("0x{n:x}")),
                ]),
                id: node_id(0, 0, format!("history-client-token-{n}").as_bytes()),
                edges: BTreeSet::new(),
                length: n as u64,
            };
            let request = Request {
                revisions: Default::default(),
                flow: format!("f-{}", step % 4),
                viewpoint: Viewpoint::zero(),
                nodes: vec![Ok(node.clone()), Ok(node)],
                proofs: BTreeMap::new(),
            };
            let base = num_bigint::BigUint::from(step);
            let (captured, outcome) = writer.prepare_heap(&base, parent.as_deref(), &request)?;
            assert!(outcome.errors.is_empty());
            assert_eq!(outcome.results.len(), 2);
            let (command, delta) = captured.unwrap();
            let physical = delta.physical.ingest(&image, &base, parent.as_deref())?;
            let logical = crate::turso::State::ingest_logical(&image, &delta.logical)?;
            assert_eq!(logical.image, physical, "heap history step {step}");
            let bytes = event::encode_wal(vec![], delta)?;
            recovered.apply_entry((step + 1).into(), &bytes)?;
            let before = crate::turso::State::from_image(image.clone())?;
            recovered
                .database
                .as_ref()
                .unwrap()
                .verify_heap(Some(&before), &command)?;
            assert_eq!(recovered.database.as_ref().unwrap().image, physical);
            parent = Some(event::entry_digest(&bytes)?);
            image = physical;
        }
        Ok(())
    }
    #[test]
    fn authenticated_edges_enforce_height_degree_and_child_limits() {
        use base64::Engine;
        let auth = |h: u64, token: &[u8]| {
            serde_json::json!([
                h,
                0,
                format!(
                    "0*{}",
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token)
                )
            ])
        };
        let parse = |edges: serde_json::Value| {
            Request::parse(serde_json::json!({"flow":"f","viewpoint":"0x0","nodes":[{"auth":auth(2,b"parent"),"length":1,"edges":edges}]}).to_string().as_bytes(),&Limits {max_degree:2,..Limits::default()}).unwrap()
        };
        let edges =
            serde_json::json!([{"auth":auth(0,b"a")},{"auth":auth(1,b"b")},{"auth":auth(0,b"a")}]);
        assert_eq!(parse(edges).nodes[0].as_ref().unwrap().edges.len(), 2);
        for (edges, code) in [
            (
                serde_json::json!([{"auth":auth(0,b"a")},{"auth":auth(0,b"b")},{"auth":auth(0,b"c")}]),
                "degree_limit",
            ),
            (serde_json::json!([{"auth":auth(2,b"a")}]), "invalid_height"),
            (serde_json::json!([{"auth":auth(3,b"a")}]), "invalid_height"),
            (
                serde_json::json!([{"auth":auth(0,&[42;65])}]),
                "token_limit",
            ),
            (
                serde_json::json!([{"auth":[0,1,"0*"]}]),
                "unsupported_version",
            ),
            (
                serde_json::json!([{"auth":[0,0,"bad-secret"]}]),
                "invalid_node",
            ),
        ] {
            assert_eq!(parse(edges).nodes[0].as_ref().unwrap_err().code, code);
        }
        for degree in [320, 321] {
            let edges: Vec<_> = (0..degree)
                .map(|i| serde_json::json!({"auth":auth(0,format!("child-{i}").as_bytes())}))
                .collect();
            let request = Request::parse(
                serde_json::json!({"flow":"f","viewpoint":"0x0","nodes":[{"auth":auth(1,b"parent"),"length":1,"edges":edges}]}).to_string().as_bytes(),
                &Limits::default(),
            ).unwrap();
            if degree == 320 {
                assert_eq!(request.nodes[0].as_ref().unwrap().edges.len(), 320);
            } else {
                assert_eq!(request.nodes[0].as_ref().unwrap_err().code, "degree_limit");
            }
        }
    }
}
