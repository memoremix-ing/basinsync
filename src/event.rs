use crate::{
    flexbuffer::{self, Extension},
    lexidecimal::Viewpoint,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha384};
use std::collections::BTreeMap;

pub const NAMESPACE: &str = "sync.memoremix.com";
pub const COMMIT_KERNEL: &str = "sts/0/databasin/commitkernel";
pub const COMMIT_FLOW: &str = "sts/0/databasin/commitflow";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Marker {
    #[serde(default)]
    pub context: BTreeMap<String, String>,
    pub edges: std::collections::BTreeSet<String>,
    #[serde(skip)]
    pub verified: BTreeMap<String, crate::heap::Child>,
    pub viewpoint: String,
    pub sha384: String,
    #[serde(with = "serde_bytes")]
    pub blob: Vec<u8>,
}

impl Marker {
    pub fn validate(&self) -> Result<Viewpoint> {
        crate::details::context_headers(&self.context)?;
        let viewpoint = Viewpoint::parse(&self.viewpoint)?;
        for id in &self.edges {
            crate::heap::Node {
                context: Default::default(),
                id: id.clone(),
                length: 0,
                edges: Default::default(),
            }
            .validate()?;
        }
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
        (1..=160).contains(&flow.len())
            && flow != "."
            && flow != ".."
            && flow.bytes().all(|c| c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || matches!(c, b'.' | b'_' | b'-')),
        "Flow id must be 1–160 lowercase ASCII letters, digits, '.', '_' or '-', excluding '.' and '..'"
    );
    Ok(())
}

pub fn normalize_flow(flow: &str) -> Result<String> {
    let flow = flow.to_ascii_lowercase();
    valid_flow(&flow)?;
    Ok(flow)
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
    let root = crate::flexbuffer::root(bytes).context("decode DifferentialEvent")?;
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
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FlowIds {
        normalized: Vec<(String, String)>,
        max_length: usize,
        invalid: Vec<String>,
    }

    /// Flow ID rules shared with the TypeScript API tests.
    #[test]
    fn flow_ids_are_portable_and_canonical() {
        let ids: FlowIds =
            serde_json::from_str(include_str!("../tests/vectors/flow-ids.json")).unwrap();
        for (raw, canonical) in &ids.normalized {
            assert_eq!(&normalize_flow(raw).unwrap(), canonical);
            assert!(valid_flow(canonical).is_ok());
            assert!(valid_flow(raw).is_err(), "{raw:?} is not canonical");
        }
        assert!(normalize_flow(&"A".repeat(ids.max_length)).is_ok());
        assert!(normalize_flow(&"a".repeat(ids.max_length + 1)).is_err());
        for id in &ids.invalid {
            assert!(normalize_flow(id).is_err(), "{id:?}");
        }
    }
    #[test]
    fn unary_batch_and_binary_blob() {
        let blob = vec![0, 255, 0, 128];
        let marker = Marker {
            context: Default::default(),
            edges: Default::default(),
            verified: Default::default(),
            viewpoint: "0".into(),
            sha384: format!("{:x}", Sha384::digest(&blob)),
            blob: blob.clone(),
        };
        let state = crate::timeline::Basin::default();
        let (_, command) = state
            .prepare(BTreeMap::from([("snow-flow".into(), marker)]))
            .unwrap();
        let encoded = encode(command).unwrap();
        let payload = decode(&encoded).unwrap();
        assert_eq!(payload.markers["snow-flow"].blob, blob);
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
        kernel: Option<Box<crate::turso::wal::Delta>>,
        kernels: Vec<crate::kernel::Commit>,
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
    let root = crate::flexbuffer::root(bytes)?.get_vector()?;
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
        kernel: None,
        kernels: vec![],
    })
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha384::digest(bytes))
}

pub const RANGE_MANIFEST: &str = "sts/0/databasin/rangemanifest";

/// One event envelope, followed only by optional storage-margin envelopes.
pub fn envelope(bytes: &[u8]) -> Result<crate::envbuf::Envelope<'_>> {
    let event = crate::envbuf::at(bytes, 0)?;
    ensure!(
        event.format == crate::envbuf::NESTED,
        "expected one event EnvBuf"
    );
    let mut end = event.end;
    while end < bytes.len() {
        let margin = crate::envbuf::at(bytes, end)?;
        ensure!(
            margin.format == crate::envbuf::MARGIN,
            "unexpected envelope after event"
        );
        end = margin.end;
    }
    Ok(event)
}

/// Locate the object-absolute manifest range inside the event envelope.
pub fn manifest_range(bytes: &[u8]) -> Result<Option<std::ops::Range<usize>>> {
    if !bytes.starts_with(b"enV") {
        return Ok(None);
    }
    let event = envelope(bytes)?;
    let frame = crate::envbuf::before(event.content, event.content.len())?;
    ensure!(
        frame.format == crate::envbuf::FLEXBUFFERS
            && tuple(frame.content)?.index(2)?.get_str()? == RANGE_MANIFEST,
        "event must end with rangemanifest"
    );
    Ok(Some(
        frame.start + event.content_start..frame.end + event.content_start,
    ))
}

/// The complete event envelope; storage margins are outside its identity.
pub fn entry_digest(bytes: &[u8]) -> Result<String> {
    Ok(digest(coordinate_bytes(bytes)?))
}

/// Borrow the logical coordinate bytes without rewriting or copying the event.
pub fn coordinate_bytes(bytes: &[u8]) -> Result<&[u8]> {
    if bytes.starts_with(b"enV") {
        Ok(&bytes[..envelope(bytes)?.end])
    } else {
        Ok(bytes)
    }
}

/// Timeline-global byte start, authenticated by this event's existing digest.
pub fn coordinate(bytes: &[u8]) -> Result<Option<num_bigint::BigUint>> {
    let Some(range) = manifest_range(bytes)? else {
        return Ok(None);
    };
    let frame = crate::envbuf::at(bytes, range.start)?;
    let query = tuple(frame.content)?.index(3)?.get_map()?;
    let Some(value) = query.index("coordinate").ok() else {
        return Ok(None);
    };
    let Extension::BigInt(value) = flexbuffer::read(value)? else {
        anyhow::bail!("event coordinate must be bigint");
    };
    Ok(Some(
        value.to_biguint().context("negative event coordinate")?,
    ))
}

/// Event size, excluding the separate storage margins.
pub fn coordinate_length(bytes: &[u8]) -> Result<usize> {
    Ok(coordinate_bytes(bytes)?.len())
}

/// Strip the separate storage suffix by borrowing the unchanged event envelope.
pub fn trim_retry_margins(bytes: &[u8]) -> Result<std::borrow::Cow<'_, [u8]>> {
    Ok(std::borrow::Cow::Borrowed(&bytes[..envelope(bytes)?.end]))
}

pub fn encode_wal_at(
    commands: Vec<FlowCommand>,
    delta: crate::turso::wal::Delta,
    coordinate: &num_bigint::BigUint,
) -> Result<Vec<u8>> {
    FlowChunks::new(&commands)?.finish_at(delta, coordinate)
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    coordinate: Option<Vec<u8>>,
    envelopes: BTreeMap<String, Option<CommandPrefix>>,
}

/// Reserve the outer header before finalizing Commitflow bytes and blob ranges.
/// Ingestion, manifest, and outer footer append without shifting those ranges.
pub struct FlowChunks {
    bytes: Vec<u8>,
    ranges: Vec<BlobRange>,
    envelopes: BTreeMap<String, Option<CommandPrefix>>,
}
impl FlowChunks {
    pub fn new(commands: &[FlowCommand]) -> Result<Self> {
        let mut chunks = Self {
            bytes: vec![0; 8],
            ranges: vec![],
            envelopes: BTreeMap::new(),
        };
        for command in commands {
            chunks.append_commit(command)?;
        }
        Ok(chunks)
    }
    pub fn append_commit(&mut self, command: &FlowCommand) -> Result<()> {
        ensure!(!command.markers.is_empty(), "empty marker batch");
        let start = self.bytes.len();
        self.append(COMMIT_FLOW, command)?;
        let envelope = crate::envbuf::at(&self.bytes, start)?;
        self.ranges
            .extend(ranges_in(envelope.content, envelope.content_start)?);
        Ok(())
    }
    pub fn ranges(&self) -> &[BlobRange] {
        &self.ranges
    }
    fn append(&mut self, path: &str, body: &impl Serialize) -> Result<()> {
        let species = Extension::WellKnownSymbol("species".into()).payload()?;
        let content = flexbuffers::to_vec((species.clone(), NAMESPACE, path, body))?;
        let end = crate::envbuf::append(&mut self.bytes, &content, crate::envbuf::FLEXBUFFERS)?;
        self.envelopes.insert(
            crate::lexidecimal::encode(&(end - 8).into()),
            Some((species, NAMESPACE.into(), path.into())),
        );
        Ok(())
    }
    pub fn append_margin(&mut self, content: &[u8]) -> Result<()> {
        let end = crate::envbuf::append(&mut self.bytes, content, crate::envbuf::MARGIN)?;
        if self
            .envelopes
            .last_key_value()
            .is_some_and(|(_, prefix)| prefix.is_none())
        {
            self.envelopes.pop_last();
        }
        self.envelopes
            .insert(crate::lexidecimal::encode(&(end - 8).into()), None);
        Ok(())
    }
    pub fn finish(self, delta: crate::turso::wal::Delta) -> Result<Vec<u8>> {
        self.finish_body(&IngestTurso {
            turso: BTreeMap::from([(crate::turso::ID.into(), delta)]),
        })
    }
    pub(crate) fn finish_body(mut self, body: &impl Serialize) -> Result<Vec<u8>> {
        self.append(INGEST_TURSO, body)?;
        self.finish_manifest()
    }
    pub fn finish_at(
        mut self,
        delta: crate::turso::wal::Delta,
        coordinate: &num_bigint::BigUint,
    ) -> Result<Vec<u8>> {
        self.append(
            INGEST_TURSO,
            &IngestTurso {
                turso: BTreeMap::from([(crate::turso::ID.into(), delta)]),
            },
        )?;
        self.finish_manifest_at(Some(coordinate))
    }
    pub fn finish_group(
        mut self,
        deltas: BTreeMap<String, crate::turso::wal::Delta>,
        kernels: &[crate::kernel::Commit],
        coordinate: &num_bigint::BigUint,
    ) -> Result<Vec<u8>> {
        for command in kernels {
            self.append(COMMIT_KERNEL, command)?;
        }
        self.append(INGEST_TURSO, &IngestTurso { turso: deltas })?;
        self.finish_manifest_at(Some(coordinate))
    }
    fn finish_manifest(self) -> Result<Vec<u8>> {
        self.finish_manifest_at(None)
    }
    fn finish_manifest_at(mut self, coordinate: Option<&num_bigint::BigUint>) -> Result<Vec<u8>> {
        let content = flexbuffer::command(
            RANGE_MANIFEST,
            &RangeManifest {
                coordinate: coordinate.map(flexbuffer::bigint_payload).transpose()?,
                envelopes: self.envelopes,
            },
            &coordinate
                .map(|p| vec![("coordinate", p)])
                .unwrap_or_default(),
        )?;
        crate::envbuf::append(&mut self.bytes, &content, crate::envbuf::FLEXBUFFERS)?;
        let mut bytes = crate::envbuf::finish_nested(self.bytes)?;
        crate::envbuf::append_counter_margin(&mut bytes, 0)?;
        Ok(bytes)
    }
}

fn tuple(content: &[u8]) -> Result<flexbuffers::VectorReader<&[u8]>> {
    let tuple = crate::flexbuffer::root(content)?.get_vector()?;
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
    let bytes = envelope(bytes)?.content;
    let frames = crate::envbuf::all(bytes)?;
    let envelopes: Vec<_> = frames
        .iter()
        .filter(|e| e.format != crate::envbuf::MARGIN)
        .collect();
    ensure!(
        envelopes.len() >= 2,
        "missing ingestion or range manifest envelope"
    );
    let last = envelopes.last().unwrap();
    ensure!(
        last.end == bytes.len(),
        "retry margin must be outside event envelope"
    );
    let manifest = tuple(last.content)?;
    ensure!(
        manifest.index(2)?.get_str()? == RANGE_MANIFEST,
        "last envelope must be rangemanifest"
    );
    let body = manifest.index(3)?.get_map()?;
    ensure!(
        body.len() == 1 || (body.len() == 2 && body.index("coordinate").is_ok()),
        "invalid range manifest fields"
    );
    let index = body.index("envelopes")?.get_map()?;
    let mut expected_entries = envelopes.len() - 1;
    for (n, frame) in frames
        .iter()
        .enumerate()
        .take_while(|(_, frame)| frame.start < last.start)
    {
        if frame.format == crate::envbuf::MARGIN && frames[n + 1].format != crate::envbuf::MARGIN {
            let key = crate::lexidecimal::encode(&frame.end.into());
            ensure!(
                index.index(key.as_str())?.flexbuffer_type() == flexbuffers::FlexBufferType::Null,
                "margin run must have a null range manifest entry"
            );
            expected_entries += 1;
        }
    }
    ensure!(
        index.len() == expected_entries,
        "range manifest coverage mismatch"
    );
    let mut commands = Vec::new();
    let mut delta = None;
    let mut kernel = None;
    let mut kernels = Vec::new();
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
            ensure!(
                (1..=2).contains(&body.turso.len()),
                "unexpected Turso database group"
            );
            kernel = body.turso.remove(crate::kernel::ID).map(Box::new);
            ensure!(body.turso.len() == 1, "unknown Turso database");
            delta = Some(
                body.turso
                    .remove(crate::turso::ID)
                    .context("missing default.turso delta")?,
            );
        } else if path == COMMIT_KERNEL {
            let body = crate::kernel::Commit::deserialize(command.index(3)?)?;
            body.graph.validate()?;
            Viewpoint::parse(&body.viewpoint)?;
            kernels.push(body);
        } else {
            ensure!(path == COMMIT_FLOW, "unknown command envelope");
            ranges.extend(ranges_in(envelope.content, envelope.content_start + 8)?);
            commands.push(FlowCommand::deserialize(command.index(3)?)?);
        }
    }
    Ok((
        Entry::Wal {
            commands,
            delta: Box::new(delta.context("missing Turso ingestion")?),
            kernel,
            kernels,
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
    let root = crate::flexbuffer::root(bytes)?.get_vector()?;
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
    fn frames(bytes: &[u8]) -> Result<Vec<crate::envbuf::Envelope<'_>>> {
        let event = envelope(bytes)?;
        let mut frames = crate::envbuf::all(event.content)?;
        for frame in &mut frames {
            frame.start += 8;
            frame.content_start += 8;
            frame.end += 8;
        }
        frames.extend(
            crate::envbuf::all(&bytes[event.end..])?
                .into_iter()
                .map(|mut f| {
                    f.start += event.end;
                    f.end += event.end;
                    f.content_start += event.end;
                    f
                }),
        );
        Ok(frames)
    }
    fn append_margin(bytes: &mut Vec<u8>, message: &[u8]) -> Result<()> {
        crate::envbuf::append(bytes, message, crate::envbuf::MARGIN)?;
        Ok(())
    }
    #[test]
    fn margin_is_skipped_without_affecting_marker_ranges_or_recovery() -> Result<()> {
        let commands = commands();
        let mut writer = crate::turso::wal::Writer::open(&crate::turso::State::genesis()?.image)?;
        let mut chunks = FlowChunks::new(&[])?;
        chunks.append_margin(&[])?;
        let first_margin_end = chunks.bytes.len();
        chunks.append_margin(&[255, 0, 1])?;
        for (n, command) in commands.iter().enumerate() {
            chunks.append_commit(command)?;
            if n == 0 {
                chunks.append_margin(&[])?;
                chunks.append_margin(&[1])?;
            }
        }
        let locations = chunks.ranges().to_vec();
        let delta = writer.prepare_with_ranges(&0u8.into(), None, &commands, &locations)?;
        chunks.append_margin(&[2])?;
        chunks.append_margin(&[3])?;
        chunks.append(
            INGEST_TURSO,
            &IngestTurso {
                turso: BTreeMap::from([(crate::turso::ID.into(), delta)]),
            },
        )?;
        chunks.append_margin(&[4])?;
        chunks.append_margin(&[])?;
        assert_eq!(chunks.envelopes.values().filter(|v| v.is_none()).count(), 4);
        assert!(
            !chunks
                .envelopes
                .contains_key(&crate::lexidecimal::encode(&(first_margin_end - 8).into()))
        );
        // Missing, split, mistyped, and shifted run entries must fail closed.
        let (margin_key, _) = chunks
            .envelopes
            .iter()
            .find(|(_, value)| value.is_none())
            .unwrap();
        for fault in 0..4 {
            let mut index = chunks.envelopes.clone();
            match fault {
                0 => {
                    index.remove(margin_key);
                }
                1 => {
                    index.insert(
                        crate::lexidecimal::encode(&(first_margin_end - 8).into()),
                        None,
                    );
                }
                2 => {
                    index.insert(
                        margin_key.clone(),
                        Some((
                            Extension::WellKnownSymbol("species".into()).payload()?,
                            NAMESPACE.into(),
                            COMMIT_FLOW.into(),
                        )),
                    );
                }
                _ => {
                    index.remove(margin_key);
                    index.insert(
                        crate::lexidecimal::encode(&(first_margin_end - 8 + 1).into()),
                        None,
                    );
                }
            }
            let bad = FlowChunks {
                bytes: chunks.bytes.clone(),
                ranges: vec![],
                envelopes: index,
            }
            .finish_manifest()?;
            assert!(decode_entry(&bad).is_err(), "fault {fault}");
        }
        let mut padded = chunks.finish_manifest()?;
        let manifest = frames(&padded)?
            .into_iter()
            .rfind(|f| f.format != crate::envbuf::MARGIN)
            .unwrap();
        let expected_manifest = manifest.start..manifest.end;
        assert_eq!(manifest_range(&padded)?, Some(expected_manifest.clone()));
        append_margin(&mut padded, &[])?;
        append_margin(&mut padded, &[1, 2, 3])?;
        assert_eq!(manifest_range(&padded)?, Some(expected_manifest));
        assert_eq!(blob_ranges(&padded)?, locations);
        let mut recovered = crate::timeline::Basin::default();
        recovered.apply_entry(1u8.into(), &padded)?;
        assert_eq!(recovered.database.unwrap().image, writer.image()?);
        let mut bad = padded.clone();
        bad[first_margin_end - 1] ^= 1;
        assert!(decode_entry(&bad).is_err());
        // Raw content is readable and cannot silently disappear from a command feed.
        padded[11] = 3;
        padded[first_margin_end - 4] = 3;
        assert!(decode_entry(&padded).is_err());
        Ok(())
    }
    fn commands() -> Vec<FlowCommand> {
        [0usize, 1, 7, 8, 15, 16, 17, 255, 256, 65535, 65536]
            .into_iter()
            .enumerate()
            .map(|(i, length)| {
                let blob = (0..length).map(|n| (n % 251) as u8).collect::<Vec<_>>();
                FlowCommand {
                    markers: BTreeMap::from([(
                        format!("{i}-snow"),
                        Marker {
                            context: Default::default(),
                            edges: Default::default(),
                            verified: Default::default(),
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
        assert_eq!(manifest_range(&old)?, None);
        let bytes = chunks.finish(delta)?;
        let frames = frames(&bytes)?;
        // Published feeds end with a retry margin; the manifest is the last frame before it.
        assert_eq!(frames.last().unwrap().format, crate::envbuf::MARGIN);
        let last = frames
            .iter()
            .rfind(|f| f.format != crate::envbuf::MARGIN)
            .unwrap();
        assert_eq!(manifest_range(&bytes)?, Some(last.start..last.end));
        let headers = crate::timeline::entry_headers(&bytes, 0)?;
        assert_eq!(headers["if-none-match"], "*");
        assert_eq!(
            headers["x-amz-meta-manifest-range"],
            format!("bytes={}-{}", last.start, last.end - 1)
        );
        assert!(
            frames
                .iter()
                .all(|frame| (frame.end - frame.start).is_multiple_of(8))
        );
        assert_eq!(
            crate::envbuf::before(&bytes, bytes.len())?.format,
            crate::envbuf::MARGIN
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
        let mut recovered = crate::timeline::Basin::default();
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
        let frames = frames(&bytes)?;
        let manifest = frames
            .iter()
            .rfind(|f| f.format != crate::envbuf::MARGIN)
            .unwrap();
        assert!(decode_entry(&bytes[..manifest.start]).is_err());
        assert!(manifest_range(&bytes[..manifest.start]).is_err());
        assert!(manifest_range(b"enV").is_err());
        let mut bad = bytes.clone();
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
            let mut recovered = crate::timeline::Basin::default();
            let error = recovered.apply_entry(1u8.into(), &bytes).err().unwrap();
            assert!(error.to_string().contains("marker location"), "{error:?}");
            assert_eq!(recovered.milestone, num_bigint::BigUint::from(0u8));
            assert!(recovered.database.is_none());
        }
        Ok(())
    }
}
