//! Token-free heap reservations. Raw authentication material stops at this boundary.
use crate::{
    event,
    lexidecimal::{self, Viewpoint},
    range_get::{self, Access},
};
use anyhow::{Result, ensure};
use num_bigint::BigInt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const RESERVE_HEAP: &str = "sts/0/databasin/reserveheap";
pub const YOUNG: &str = "heap/young/";
pub const OLD: &str = "heap/old/";

pub struct Limits {
    pub max_height: u64,
    pub max_token_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_height: 128,
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
    edges: Vec<serde_json::Value>,
}

pub struct Request {
    pub flow: String,
    pub viewpoint: Viewpoint,
    pub nodes: Vec<Result<Node, NodeError>>,
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
                let Auth(height, version, token) = wire.auth;
                if height > limits.max_height {
                    return Err(invalid(
                        "height_limit",
                        "node height exceeds the service limit",
                    ));
                }
                if height != 0 {
                    return Err(invalid(
                        "unsupported_height",
                        "only height zero is supported",
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
                if !wire.edges.is_empty() {
                    return Err(invalid(
                        "unsupported_edges",
                        "shallow nodes must have no edges",
                    ));
                }
                if wire.length > i64::MAX as u64 {
                    return Err(invalid(
                        "invalid_length",
                        "content length exceeds the database integer range",
                    ));
                }
                Ok(Node {
                    id: node_id(height, version, &token),
                    length: wire.length,
                })
            })
            .collect();
        Ok(Self {
            flow: wire.flow,
            viewpoint: wire.viewpoint,
            nodes,
        })
    }
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
}
impl Node {
    pub fn validate(&self) -> Result<()> {
        let parts: Vec<_> = self.id.split('/').collect();
        ensure!(
            parts.len() == 4
                && parts[0] == format!("n-{}", lexidecimal::encode(&(-1).into()))
                && parts[1] == format!("v.{}", lexidecimal::encode(&0.into())),
            "invalid shallow node id"
        );
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub flow: String,
    pub viewpoint: String,
    pub reserved: String,
    pub nodes: Vec<Node>,
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
            let young = format!("{YOUNG}{}", node.id);
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
                read: range_get::presign_whole(bucket, &format!("{OLD}{}", node.id)).await?,
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
                .map(|n| n.as_ref().unwrap_err().code)
                .collect::<Vec<_>>(),
            [
                "unsupported_height",
                "unsupported_version",
                "unsupported_edges",
                "invalid_node"
            ]
        );
    }

    #[test]
    fn heap_frames_reconstruct_without_tokens_and_reject_false_commands() -> Result<()> {
        let secret = b"heap-test-secret-only-the-client-knows-92741";
        let request = request("f", secret, 128);
        let mut writer = crate::timeline::Watershed::default().into_stager();
        let (prepared, outcome) = writer.prepare_heap(&request)?;
        assert_eq!(outcome.results.len(), 1);
        let bytes = prepared.unwrap().bytes().to_vec();
        assert!(!bytes.windows(secret.len()).any(|w| w == secret));
        let mut recovered = crate::timeline::Watershed::default();
        recovered.apply_entry(1u8.into(), &bytes)?;
        let state = recovered.database.as_ref().unwrap();
        assert!(!state.image.windows(secret.len()).any(|w| w == secret));
        assert!(recovered.latest("f")?.is_none());
        let event::Entry::Wal { heap, delta, .. } = event::decode_entry(&bytes)? else {
            unreachable!()
        };
        let base = &delta.logical.base.as_ref().unwrap().0;
        let logical = crate::turso::State::ingest_logical(base, &delta.logical)?;
        assert_eq!(logical.image, state.image);
        for fault in 0..3 {
            let mut command = heap[0].clone();
            match fault {
                0 => command.nodes[0].length += 1,
                1 => command.reserved = "2000-01-01T00:00:00Z".into(),
                _ => command.viewpoint = "1".into(),
            }
            let bad = event::FlowChunks::heap(&command)?.finish(*delta.clone())?;
            let mut empty = crate::timeline::Watershed::default();
            assert!(empty.apply_entry(1u8.into(), &bad).is_err());
            assert_eq!(empty.milestone, 0u8.into());
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
                length: n as u64,
            };
            let request = Request {
                flow: format!("f-{}", step % 4),
                viewpoint: Viewpoint::zero(),
                nodes: vec![Ok(node.clone()), Ok(node)],
            };
            let base = num_bigint::BigUint::from(step);
            let (captured, outcome) = writer.prepare_heap(&base, parent.as_deref(), &request)?;
            assert!(outcome.errors.is_empty());
            assert_eq!(outcome.results.len(), 2);
            let (command, delta) = captured.unwrap();
            let physical = delta.physical.ingest(&image, &base, parent.as_deref())?;
            let logical = crate::turso::State::ingest_logical(&image, &delta.logical)?;
            assert_eq!(logical.image, physical, "heap history step {step}");
            let bytes = event::FlowChunks::heap(&command)?.finish(delta)?;
            recovered.apply_entry((step + 1).into(), &bytes)?;
            assert_eq!(recovered.database.as_ref().unwrap().image, physical);
            parent = Some(event::digest(&bytes));
            image = physical;
        }
        Ok(())
    }
}
