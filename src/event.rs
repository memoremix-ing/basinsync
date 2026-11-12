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
        "unknown Watershed command"
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
        let state = crate::timeline::Watershed::default();
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
#[cfg(test)]
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

#[cfg(test)]
fn encode_vector_wal(
    commands: Vec<FlowCommand>,
    delta: crate::turso::wal::Delta,
) -> Result<Vec<u8>> {
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

fn decode_vector_entry(bytes: &[u8]) -> Result<Entry> {
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

pub const RANGE_MANIFEST: &str = "sts/0/databasin/rangemanifest";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlobRange {
    pub flow: String,
    pub viewpoint: Viewpoint,
    pub offset: u64,
    pub length: u64,
    pub sha384: String,
}

type CommandPrefix = (Vec<u8>, String, String);
#[derive(Serialize)]
struct RangeManifest {
    envelopes: BTreeMap<String, CommandPrefix>,
}

/// Commitflow bytes are finalized before the database transaction: subsequent
/// ingestion and manifest envelopes can only append, leaving these offsets fixed.
pub struct FlowChunks {
    bytes: Vec<u8>,
    ranges: Vec<BlobRange>,
    envelopes: BTreeMap<String, CommandPrefix>,
}
impl FlowChunks {
    pub fn new(commands: &[FlowCommand]) -> Result<Self> {
        let mut chunks = Self {
            bytes: vec![],
            ranges: vec![],
            envelopes: BTreeMap::new(),
        };
        for command in commands {
            ensure!(!command.markers.is_empty(), "empty marker batch");
            let start = chunks.bytes.len();
            chunks.append(COMMIT_FLOW, command)?;
            let envelope = crate::envbuf::at(&chunks.bytes, start)?;
            chunks
                .ranges
                .extend(ranges_in(envelope.content, envelope.content_start)?);
        }
        Ok(chunks)
    }
    pub fn ranges(&self) -> &[BlobRange] {
        &self.ranges
    }
    fn append(&mut self, path: &str, body: &impl Serialize) -> Result<()> {
        let species = Extension::WellKnownSymbol("species".into()).payload()?;
        let content = flexbuffers::to_vec((species.clone(), NAMESPACE, path, body))?;
        let end = crate::envbuf::append(&mut self.bytes, &content, crate::envbuf::FLEXBUFFERS)?;
        self.envelopes.insert(
            crate::lexidecimal::encode(&end.into()),
            (species, NAMESPACE.into(), path.into()),
        );
        Ok(())
    }
    pub fn finish(self, delta: crate::turso::wal::Delta) -> Result<Vec<u8>> {
        self.finish_body(&IngestTurso {
            turso: BTreeMap::from([(crate::turso::ID.into(), delta)]),
        })
    }
    pub(crate) fn finish_body(mut self, body: &impl Serialize) -> Result<Vec<u8>> {
        self.append(INGEST_TURSO, body)?;
        let species = Extension::WellKnownSymbol("species".into()).payload()?;
        let content = flexbuffers::to_vec((
            species,
            NAMESPACE,
            RANGE_MANIFEST,
            RangeManifest {
                envelopes: self.envelopes,
            },
        ))?;
        crate::envbuf::append(&mut self.bytes, &content, crate::envbuf::FLEXBUFFERS)?;
        Ok(self.bytes)
    }
}

fn tuple(content: &[u8]) -> Result<flexbuffers::VectorReader<&[u8]>> {
    let tuple = flexbuffers::Reader::get_root(content)?.get_vector()?;
    ensure!(
        tuple.len() == 4
            && flexbuffer::read(tuple.index(0)?)? == Extension::WellKnownSymbol("species".into()),
        "invalid command tuple/species"
    );
    ensure!(
        tuple.index(1)?.get_str()? == NAMESPACE,
        "unknown command namespace"
    );
    Ok(tuple)
}

fn ranges_in(content: &[u8], base: usize) -> Result<Vec<BlobRange>> {
    ranges_from(tuple(content)?, content, base)
}
fn ranges_from(
    command: flexbuffers::VectorReader<&[u8]>,
    content: &[u8],
    base: usize,
) -> Result<Vec<BlobRange>> {
    ensure!(
        command.index(2)?.get_str()? == COMMIT_FLOW,
        "expected commitflow command"
    );
    let markers = command.index(3)?.get_map()?.index("markers")?.get_map()?;
    ensure!(!markers.is_empty(), "empty marker batch");
    let mut ranges = Vec::new();
    for flow in markers.iter_keys() {
        valid_flow(flow)?;
        let marker = markers.index(flow)?.get_map()?;
        let blob = marker.index("blob")?.get_blob()?.0;
        // The reader returns a checked slice of this exact FlexBuffer allocation.
        let offset = (blob.as_ptr() as usize)
            .checked_sub(content.as_ptr() as usize)
            .context("blob outside command")?;
        ensure!(
            offset
                .checked_add(blob.len())
                .is_some_and(|end| end <= content.len()),
            "blob outside command"
        );
        let sha384 = marker.index("sha384")?.get_str()?.to_owned();
        ensure!(sha384 == digest(blob), "CommitMarker digest mismatch");
        ranges.push(BlobRange {
            flow: flow.into(),
            viewpoint: Viewpoint::parse(marker.index("viewpoint")?.get_str()?)?,
            offset: u64::try_from(base.checked_add(offset).context("blob offset overflow")?)?,
            length: blob.len() as u64,
            sha384,
        });
    }
    Ok(ranges)
}

pub fn encode_wal(commands: Vec<FlowCommand>, delta: crate::turso::wal::Delta) -> Result<Vec<u8>> {
    FlowChunks::new(&commands)?.finish(delta)
}

fn decode_envelopes(bytes: &[u8]) -> Result<(Entry, Vec<BlobRange>)> {
    let envelopes = crate::envbuf::all(bytes)?;
    ensure!(
        envelopes.len() >= 2,
        "missing ingestion or range manifest envelope"
    );
    let last = envelopes.last().unwrap();
    let manifest = tuple(last.content)?;
    ensure!(
        manifest.index(2)?.get_str()? == RANGE_MANIFEST,
        "last envelope must be rangemanifest"
    );
    let body = manifest.index(3)?.get_map()?;
    ensure!(body.len() == 1, "invalid range manifest fields");
    let index = body.index("envelopes")?.get_map()?;
    ensure!(
        index.len() == envelopes.len() - 1,
        "range manifest coverage mismatch"
    );
    let mut commands = Vec::new();
    let mut delta = None;
    let mut ranges = Vec::new();
    let mut previous = String::new();
    for key in index.iter_keys() {
        ensure!(
            key > previous.as_str(),
            "range manifest keys must be unique and sorted"
        );
        previous = key.into();
        let _ = crate::lexidecimal::decode(key)?;
    }
    for (n, envelope) in envelopes.iter().enumerate() {
        ensure!(
            envelope.format == crate::envbuf::FLEXBUFFERS,
            "command envelope must contain FlexBuffers"
        );
        if n + 1 == envelopes.len() {
            break;
        }
        let command = tuple(envelope.content)?;
        let path = command.index(2)?.get_str()?;
        let key = crate::lexidecimal::encode(&envelope.end.into());
        let prefix = index.index(key.as_str())?.get_vector()?;
        ensure!(
            prefix.len() == 3
                && flexbuffer::read(prefix.index(0)?)?
                    == Extension::WellKnownSymbol("species".into())
                && prefix.index(1)?.get_str()? == NAMESPACE
                && prefix.index(2)?.get_str()? == path,
            "range manifest prefix mismatch"
        );
        if n + 2 == envelopes.len() {
            ensure!(
                path == INGEST_TURSO,
                "penultimate envelope must ingest Turso frames"
            );
            let mut body = IngestTurso::deserialize(command.index(3)?)?;
            ensure!(body.turso.len() == 1, "expected one Turso database");
            delta = Some(
                body.turso
                    .remove(crate::turso::ID)
                    .context("missing default.turso delta")?,
            );
        } else {
            ensure!(path == COMMIT_FLOW, "unknown command envelope");
            ranges.extend(ranges_in(envelope.content, envelope.content_start)?);
            commands.push(FlowCommand::deserialize(command.index(3)?)?);
        }
    }
    Ok((
        Entry::Wal {
            commands,
            delta: Box::new(delta.context("missing Turso ingestion")?),
        },
        ranges,
    ))
}

pub fn decode_entry(bytes: &[u8]) -> Result<Entry> {
    if bytes.starts_with(b"enV") {
        Ok(decode_envelopes(bytes)?.0)
    } else {
        decode_vector_entry(bytes)
    }
}

pub fn blob_ranges(bytes: &[u8]) -> Result<Vec<BlobRange>> {
    if bytes.starts_with(b"enV") {
        Ok(decode_envelopes(bytes)?.1)
    } else {
        historical_ranges(bytes)
    }
}

/// Historical image-delta fixtures remain readable without a persistent range index.
fn historical_ranges(bytes: &[u8]) -> Result<Vec<BlobRange>> {
    let root = flexbuffers::Reader::get_root(bytes)?.get_vector()?;
    let mut ranges = Vec::new();
    for item in root.iter() {
        let command = item.get_vector()?;
        if command.len() == 4 && command.index(2)?.get_str()? == COMMIT_FLOW {
            ranges.extend(ranges_from(command, bytes, 0)?);
        }
    }
    Ok(ranges)
}

#[cfg(test)]
mod envelope_tests {
    use super::*;
    fn commands() -> Vec<FlowCommand> {
        [0usize, 1, 7, 8, 255, 256, 65535, 65536]
            .into_iter()
            .enumerate()
            .map(|(i, length)| {
                let blob = (0..length).map(|n| (n % 251) as u8).collect::<Vec<_>>();
                FlowCommand {
                    markers: BTreeMap::from([(
                        format!("{i}-雪"),
                        Marker {
                            viewpoint: "0".into(),
                            sha384: digest(&blob),
                            blob,
                        },
                    )]),
                }
            })
            .collect()
    }
    #[test]
    fn ranges_survive_ingestion_append_and_match_exact_blob_slices() -> Result<()> {
        let commands = commands();
        let chunks = FlowChunks::new(&commands)?;
        let locations = chunks.ranges().to_vec();
        let mut writer = crate::turso::wal::Writer::open(&crate::turso::State::genesis()?.image)?;
        let delta = writer.prepare(&0u8.into(), None, &commands)?;
        let old = encode_vector_wal(commands.clone(), delta.clone())?;
        assert!(matches!(decode_entry(&old)?, Entry::Wal { .. }));
        let bytes = chunks.finish(delta)?;
        let frames = crate::envbuf::all(&bytes)?;
        assert_eq!(frames.len(), commands.len() + 2);
        assert_eq!(
            crate::envbuf::before(&bytes, bytes.len())?,
            *frames.last().unwrap()
        );
        assert_eq!(blob_ranges(&bytes)?, locations.clone());
        for location in locations {
            let original = &commands
                .iter()
                .flat_map(|c| &c.markers)
                .find(|(f, _)| **f == location.flow)
                .unwrap()
                .1
                .blob;
            let start = location.offset as usize;
            assert_eq!(&bytes[start..start + location.length as usize], original);
            assert_eq!(digest(original), location.sha384);
        }
        let mut recovered = crate::timeline::Watershed::default();
        recovered.apply_entry(1u8.into(), &bytes)?;
        assert_eq!(recovered.database.unwrap().image, writer.image()?);
        Ok(())
    }
    #[test]
    fn missing_manifest_wrong_prefix_and_shifted_boundaries_are_rejected() -> Result<()> {
        let commands = commands();
        let mut writer = crate::turso::wal::Writer::open(&crate::turso::State::genesis()?.image)?;
        let delta = writer.prepare(&0u8.into(), None, &commands)?;
        let bytes = encode_wal(commands, delta)?;
        let frames = crate::envbuf::all(&bytes)?;
        assert!(decode_entry(&bytes[..frames.last().unwrap().start]).is_err());
        let mut bad = bytes.clone();
        let manifest = frames.last().unwrap();
        let relative = manifest
            .content
            .windows(COMMIT_FLOW.len())
            .position(|p| p == COMMIT_FLOW.as_bytes())
            .unwrap();
        bad[manifest.content_start + relative + COMMIT_FLOW.len() - 1] ^= 1;
        assert!(decode_entry(&bad).is_err());
        let mut bad = bytes.clone();
        bad.remove(frames[0].end - 1);
        assert!(decode_entry(&bad).is_err());
        Ok(())
    }
    #[test]
    fn valid_physical_frames_cannot_install_a_false_blob_location() -> Result<()> {
        for fault in 0..3 {
            let commands = commands();
            let mut locations = FlowChunks::new(&commands)?.ranges().to_vec();
            match fault {
                0 => locations[1].offset += 1,
                1 => locations[1].length += 1,
                _ => locations[1].sha384 = "00".repeat(48),
            }
            let mut writer =
                crate::turso::wal::Writer::open(&crate::turso::State::genesis()?.image)?;
            let delta = writer.prepare_with_ranges(&0u8.into(), None, &commands, &locations)?;
            let bytes = encode_wal(commands, delta)?;
            let mut recovered = crate::timeline::Watershed::default();
            let error = recovered.apply_entry(1u8.into(), &bytes).err().unwrap();
            assert!(error.to_string().contains("marker location"), "{error:?}");
            assert_eq!(recovered.milestone, num_bigint::BigUint::from(0u8));
            assert!(recovered.database.is_none());
        }
        Ok(())
    }
}
