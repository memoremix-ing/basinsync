use crate::lexidecimal::Viewpoint;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha384};
use std::collections::BTreeMap;

pub const NAMESPACE: &str = "sync.memoremix.com";
pub const COMMIT_FLOW: &str = "sts/0/databasin/commitflow";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Marker {
    pub viewpoint: String,
    pub sha384: String,
    #[serde(with = "serde_bytes")]
    pub blob: Vec<u8>,
}

impl Marker {
    pub fn validate(&self) -> Result<Viewpoint> {
        let viewpoint = Viewpoint::parse(&self.viewpoint)?;
        ensure!(
            self.sha384 == format!("{:x}", Sha384::digest(&self.blob)),
            "CommitMarker digest mismatch"
        );
        Ok(viewpoint)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitFlow {
    pub markers: BTreeMap<String, Marker>,
}

pub type Batch = Vec<(String, String, CommitFlow)>;

pub fn valid_flow(flow: &str) -> Result<()> {
    ensure!(
        !flow.contains('\0'),
        "Flow id cannot contain NUL (FlexBuffers map key)"
    );
    Ok(())
}

pub fn encode(flow: String, marker: Marker) -> Result<Vec<u8>> {
    valid_flow(&flow)?;
    marker.validate()?;
    let batch: Batch = vec![(
        NAMESPACE.into(),
        COMMIT_FLOW.into(),
        CommitFlow {
            markers: BTreeMap::from([(flow, marker)]),
        },
    )];
    flexbuffers::to_vec(batch).context("encode DifferentialEvent")
}

pub fn decode(bytes: &[u8]) -> Result<CommitFlow> {
    let batch: Batch = flexbuffers::from_slice(bytes).context("decode DifferentialEvent")?;
    ensure!(
        batch.len() == 1,
        "DifferentialEvent must contain one command"
    );
    let (namespace, command, payload) = batch.into_iter().next().unwrap();
    ensure!(
        namespace == NAMESPACE && command == COMMIT_FLOW,
        "unknown Basin command"
    );
    ensure!(!payload.markers.is_empty(), "empty marker batch");
    for (flow, marker) in &payload.markers {
        valid_flow(flow)?;
        marker.validate()?;
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unary_batch_and_binary_blob() {
        let blob = vec![0, 255, 0, 128];
        let marker = Marker {
            viewpoint: "0".into(),
            sha384: format!("{:x}", Sha384::digest(&blob)),
            blob: blob.clone(),
        };
        let encoded = encode("雪/flow".into(), marker).unwrap();
        let payload = decode(&encoded).unwrap();
        assert_eq!(payload.markers["雪/flow"].blob, blob);
        assert!(decode(&flexbuffers::to_vec(Vec::<u8>::new()).unwrap()).is_err());
        let bad = vec![(
            NAMESPACE,
            "other",
            CommitFlow {
                markers: BTreeMap::new(),
            },
        )];
        assert!(decode(&flexbuffers::to_vec(bad).unwrap()).is_err());
    }
}
