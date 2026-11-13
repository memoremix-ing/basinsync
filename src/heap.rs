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

pub const YOUNG: &str = "heap/young/";
pub const OLD: &str = "heap/old/";

pub struct Limits {
    pub max_height: u64,
    pub max_degree: usize,
    pub max_token_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_height: 128,
            max_degree: 128,
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
    auth: Auth,
    length: u64,
    edges: Vec<WireEdge>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireEdge {
    auth: Auth,
}
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
#[derive(Clone, Debug)]
pub struct Child {
    pub revision: String,
    pub length: u64,
    pub etag: String,
}

pub struct Request {
    pub flow: String,
    pub viewpoint: Viewpoint,
    pub nodes: Vec<Result<Node, NodeError>>,
    pub proofs: BTreeMap<String, Result<Child, NodeError>>,
}
impl Request {
    pub fn parse(bytes: &[u8], limits: &Limits) -> Result<Self> {
        // Never propagate deserializer errors that could quote authentication material.
        let wire: WireRequest =
            serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("invalid heap request"))?;
        event::valid_flow(&wire.flow)?;
        crate::epilogue::flow_key(&wire.flow, &wire.viewpoint)?;
        let nodes = wire
            .nodes
            .into_iter()
            .map(|value| {
                let wire: WireNode = serde_json::from_value(value).map_err(|_| {
                    invalid("invalid_node", "invalid node fields or authentication")
                })?;
                let (height, id) = authenticate(wire.auth, limits)?;
                let mut edges = BTreeSet::new();
                for edge in wire.edges {
                    let (child_height, child_id) = authenticate(edge.auth, limits)?;
                    if child_height >= height {
                        return Err(invalid(
                            "invalid_height",
                            "parent height must exceed every child height",
                        ));
                    }
                    edges.insert(child_id);
                    if edges.len() > limits.max_degree {
                        return Err(invalid(
                            "degree_limit",
                            "node degree exceeds the service limit",
                        ));
                    }
                }
                if wire.length > i64::MAX as u64 {
                    return Err(invalid(
                        "invalid_length",
                        "content length exceeds the database integer range",
                    ));
                }
                Ok(Node {
                    id,
                    length: wire.length,
                    edges,
                })
            })
            .collect();
        Ok(Self {
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
        let candidates = std::mem::take(&mut self.proofs);
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
                self.proofs.insert(id, proof);
            }
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
        "A_{flow}/v.{}/e.{}",
        lexidecimal::encode(&0.into()),
        viewpoint.lexidecimal()
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub length: u64,
    pub edges: BTreeSet<String>,
}
impl Node {
    pub fn validate(&self) -> Result<()> {
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
    pub edges: BTreeSet<String>,
    pub id: String,
    pub length: u64,
    pub revision: String,
}
impl Allocation {
    fn validate(&self) -> Result<()> {
        Node {
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
                    Some(range_get::presign_write(bucket, &young, node.length).await?)
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
            results.insert(index, NodeResult { actions });
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
    fn ordered_node_ids_and_per_node_validation() {
        let child = node_id(0, 0, b"child");
        let parent = node_id(1, 0, b"parent");
        assert!(parent < child);
        assert!(retainer("雪/flow", &Viewpoint::zero()) < child);
        assert!("M_flow/v.0/e.0" < child.as_str());
        Node {
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
        let envelopes = crate::envbuf::all(&bytes)?;
        assert_eq!(envelopes.len(), 2);
        assert!(event::blob_ranges(&bytes)?.is_empty());
        assert!(!bytes.windows(secret.len()).any(|w| w == secret));
        let mut recovered = crate::timeline::Watershed::default();
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
        for fault in 0..3 {
            let mut command = command.clone();
            match fault {
                0 => command.nodes[0].length += 1,
                1 => command.reserved = "2000-01-01T00:00:00Z".into(),
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
        let mut recovered = crate::timeline::Watershed::default();
        let mut parent = None::<String>;
        for step in 0..40u32 {
            let n = step % 11;
            let node = Node {
                id: node_id(0, 0, format!("history-client-token-{n}").as_bytes()),
                edges: BTreeSet::new(),
                length: n as u64,
            };
            let request = Request {
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
            parent = Some(event::digest(&bytes));
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
    }
}
