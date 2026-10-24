use crate::{
    flexbuffer::{self, Extension},
    lexidecimal::Viewpoint,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha384};
use std::collections::BTreeMap;

pub const NAMESPACE: &str = "sync.memoremix.com";
pub const COMMIT_FLOW: &str = "sts/0/databasin/commitflow";

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitFlow {
    pub deltas: Deltas,
    pub markers: BTreeMap<String, Marker>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Deltas {
    pub turso: BTreeMap<String, crate::turso::Delta>,
}

pub type Batch = Vec<(Vec<u8>, String, String, CommitFlow)>;

pub fn valid_flow(flow: &str) -> Result<()> {
    ensure!(
        !flow.contains('\0'),
        "Flow id cannot contain NUL (FlexBuffers map key)"
    );
    Ok(())
}

pub fn encode(command: CommitFlow) -> Result<Vec<u8>> {
    let batch: Batch = vec![(
        Extension::WellKnownSymbol("species".into()).payload()?,
        NAMESPACE.into(),
        COMMIT_FLOW.into(),
        command,
    )];
    flexbuffers::to_vec(batch).context("encode DifferentialEvent")
}

pub fn decode(bytes: &[u8]) -> Result<CommitFlow> {
    let root = flexbuffers::Reader::get_root(bytes).context("decode DifferentialEvent")?;
    let batch = root.get_vector()?;
    ensure!(
        batch.len() == 1,
        "DifferentialEvent must contain one command"
    );
    let tuple = batch.index(0)?.get_vector()?;
    ensure!(tuple.len() == 4, "invalid command tuple");
    ensure!(
        flexbuffer::read(tuple.index(0)?)? == Extension::WellKnownSymbol("species".into()),
        "command tuple must begin with Symbol.species"
    );
    let namespace = tuple.index(1)?.get_str()?;
    let command = tuple.index(2)?.get_str()?;
    ensure!(
        namespace == NAMESPACE && command == COMMIT_FLOW,
        "unknown Basin command"
    );
    let payload = CommitFlow::deserialize(tuple.index(3)?)?;
    ensure!(
        payload.deltas.turso.len() == 1 && payload.deltas.turso.contains_key(crate::turso::ID),
        "expected default.turso delta"
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
        let state = crate::timeline::Basin::default();
        let (_, command) = state
            .prepare(BTreeMap::from([("雪/flow".into(), marker)]))
            .unwrap();
        let encoded = encode(command).unwrap();
        let payload = decode(&encoded).unwrap();
        assert_eq!(payload.markers["雪/flow"].blob, blob);
        assert!(decode(&flexbuffers::to_vec(Vec::<u8>::new()).unwrap()).is_err());
        let bad = vec![(
            b"#species".to_vec(),
            NAMESPACE,
            "other",
            CommitFlow {
                deltas: Deltas {
                    turso: BTreeMap::new(),
                },
                markers: BTreeMap::new(),
            },
        )];
        assert!(decode(&flexbuffers::to_vec(bad).unwrap()).is_err());
    }
}

pub const INGEST_TURSO: &str = "sts/0/databasin/ingestturso";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FlowCommand {
    pub markers: BTreeMap<String, Marker>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IngestTurso {
    pub turso: BTreeMap<String, crate::turso::wal::Delta>,
}
#[derive(Serialize)]
#[serde(untagged)]
enum CommandBody {
    Flow(FlowCommand),
    Ingest(IngestTurso),
}
pub enum Entry {
    Legacy(CommitFlow),
    Wal {
        commands: Vec<FlowCommand>,
        delta: Box<crate::turso::wal::Delta>,
    },
}

pub fn encode_wal(commands: Vec<FlowCommand>, delta: crate::turso::wal::Delta) -> Result<Vec<u8>> {
    ensure!(!commands.is_empty(), "empty command vector");
    let species = Extension::WellKnownSymbol("species".into()).payload()?;
    let mut batch = Vec::with_capacity(commands.len() + 1);
    for command in commands {
        batch.push((
            species.clone(),
            NAMESPACE,
            COMMIT_FLOW,
            CommandBody::Flow(command),
        ));
    }
    batch.push((
        species,
        NAMESPACE,
        INGEST_TURSO,
        CommandBody::Ingest(IngestTurso {
            turso: BTreeMap::from([(crate::turso::ID.into(), delta)]),
        }),
    ));
    flexbuffers::to_vec(batch).context("encode DifferentialEvent")
}

pub fn decode_entry(bytes: &[u8]) -> Result<Entry> {
    let root = flexbuffers::Reader::get_root(bytes)?.get_vector()?;
    if root.len() == 1 {
        return Ok(Entry::Legacy(decode(bytes)?));
    }
    ensure!(root.len() >= 2, "empty command vector");
    let mut commands = Vec::new();
    let mut delta = None;
    for n in 0..root.len() {
        let tuple = root.index(n)?.get_vector()?;
        ensure!(
            tuple.len() == 4
                && flexbuffer::read(tuple.index(0)?)?
                    == Extension::WellKnownSymbol("species".into()),
            "invalid command tuple/species"
        );
        ensure!(
            tuple.index(1)?.get_str()? == NAMESPACE,
            "unknown command namespace"
        );
        let op = tuple.index(2)?.get_str()?;
        if n + 1 == root.len() {
            ensure!(op == INGEST_TURSO, "last command must ingest Turso frames");
            let mut body = IngestTurso::deserialize(tuple.index(3)?)?;
            ensure!(body.turso.len() == 1, "expected one Turso database");
            delta = Some(
                body.turso
                    .remove(crate::turso::ID)
                    .context("missing default.turso delta")?,
            );
        } else {
            ensure!(op == COMMIT_FLOW, "expected commitflow command");
            let body = FlowCommand::deserialize(tuple.index(3)?)?;
            ensure!(!body.markers.is_empty(), "empty marker batch");
            for flow in body.markers.keys() {
                valid_flow(flow)?;
            }
            commands.push(body);
        }
    }
    Ok(Entry::Wal {
        commands,
        delta: Box::new(delta.unwrap()),
    })
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha384::digest(bytes))
}
