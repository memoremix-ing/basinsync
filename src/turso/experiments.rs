use super::*;
use anyhow::Context;
use turso_core::{
    Clock, MonotonicInstant, WallClockInstant,
    io::{FileId, FileSyncType},
};

#[derive(Default)]
struct Recorder {
    current: Vec<u8>,
    segments: Vec<Blob>,
}
struct WalIO {
    inner: MemoryIO,
    recorder: Arc<Mutex<Recorder>>,
}
impl Clock for WalIO {
    fn current_time_monotonic(&self) -> MonotonicInstant {
        self.inner.current_time_monotonic()
    }
    fn current_time_wall_clock(&self) -> WallClockInstant {
        self.inner.current_time_wall_clock()
    }
}
impl IO for WalIO {
    fn open_file(
        &self,
        path: &str,
        flags: OpenFlags,
        direct: bool,
    ) -> turso_core::Result<Arc<dyn File>> {
        let inner = self.inner.open_file(path, flags, direct)?;
        if path.ends_with("-wal") {
            Ok(Arc::new(WalFile {
                inner,
                recorder: self.recorder.clone(),
            }))
        } else {
            Ok(inner)
        }
    }
    fn remove_file(&self, path: &str) -> turso_core::Result<()> {
        self.inner.remove_file(path)
    }
    fn file_id(&self, path: &str) -> turso_core::Result<FileId> {
        self.inner.file_id(path)
    }
}
struct WalFile {
    inner: Arc<dyn File>,
    recorder: Arc<Mutex<Recorder>>,
}
impl File for WalFile {
    fn lock_file(&self, exclusive: bool) -> turso_core::Result<()> {
        self.inner.lock_file(exclusive)
    }
    fn unlock_file(&self) -> turso_core::Result<()> {
        self.inner.unlock_file()
    }
    fn pread(&self, pos: u64, c: Completion) -> turso_core::Result<Completion> {
        self.inner.pread(pos, c)
    }
    fn pwrite(
        &self,
        pos: u64,
        buffer: Arc<Buffer>,
        c: Completion,
    ) -> turso_core::Result<Completion> {
        let completed = self.inner.pwrite(pos, buffer.clone(), c)?;
        assert!(
            completed.finished(),
            "experiment requires synchronous MemoryIO"
        );
        let mut recorder = self.recorder.lock().unwrap();
        let start = pos as usize;
        let size = recorder.current.len().max(start + buffer.len());
        recorder.current.resize(size, 0);
        recorder.current[start..start + buffer.len()].copy_from_slice(buffer.as_slice());
        Ok(completed)
    }
    fn sync(&self, c: Completion, kind: FileSyncType) -> turso_core::Result<Completion> {
        self.inner.sync(c, kind)
    }
    fn size(&self) -> turso_core::Result<u64> {
        self.inner.size()
    }
    fn truncate(&self, len: u64, c: Completion) -> turso_core::Result<Completion> {
        let completed = self.inner.truncate(len, c)?;
        assert!(completed.finished());
        let mut recorder = self.recorder.lock().unwrap();
        if len == 0 && !recorder.current.is_empty() {
            let bytes = std::mem::take(&mut recorder.current);
            recorder.segments.push(Blob(bytes));
        } else {
            recorder.current.resize(len as usize, 0);
        }
        Ok(completed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WalFrames {
    base: String,
    milestone: String,
    segments: Vec<Blob>,
}
impl WalFrames {
    fn pages(&self) -> Result<(usize, BTreeMap<u64, Vec<u8>>)> {
        let mut pages = BTreeMap::new();
        let mut size = 0;
        ensure!(!self.segments.is_empty(), "missing WAL segment");
        for segment in &self.segments {
            let bytes = &segment.0;
            ensure!(
                bytes.len() >= 32 && (bytes.len() - 32).is_multiple_of(PAGE_SIZE + 24),
                "truncated WAL"
            );
            let word =
                |offset: usize| u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap());
            let magic = word(0);
            ensure!(
                (magic == 0x377f0682 || magic == 0x377f0683)
                    && word(4) == 3007000
                    && word(8) == PAGE_SIZE as u32,
                "invalid WAL header"
            );
            let little = magic == 0x377f0682;
            let mut crc = checksum(&bytes[..24], (0, 0), little);
            ensure!(crc == (word(24), word(28)), "WAL header checksum");
            let mut transaction = BTreeMap::new();
            let mut committed = false;
            for frame in bytes[32..].chunks_exact(PAGE_SIZE + 24) {
                let fw = |offset: usize| {
                    u32::from_be_bytes(frame[offset..offset + 4].try_into().unwrap())
                };
                ensure!(
                    fw(0) > 0 && frame[8..16] == bytes[16..24],
                    "WAL salt/page mismatch"
                );
                crc = checksum(&frame[..8], crc, little);
                crc = checksum(&frame[24..], crc, little);
                ensure!(crc == (fw(16), fw(20)), "WAL frame checksum");
                transaction.insert(fw(0) as u64, frame[24..].to_vec());
                committed = fw(4) > 0;
                if committed {
                    size = fw(4) as usize * PAGE_SIZE;
                    pages.append(&mut transaction);
                    pages.retain(|&number, _| number <= fw(4) as u64);
                }
            }
            ensure!(committed && transaction.is_empty(), "uncommitted WAL tail");
        }
        ensure!(size >= PAGE_SIZE, "missing WAL commit");
        Ok((size, pages))
    }
    fn ingest(&self, before: &[u8], base: &str) -> Result<Vec<u8>> {
        ensure!(self.base == base, "WAL base Milestone mismatch");
        ensure!(
            self.milestone.parse::<num_bigint::BigUint>()?
                == base.parse::<num_bigint::BigUint>()? + 1u8,
            "WAL Milestone gap"
        );
        let (size, pages) = self.pages()?;
        ensure!(
            size <= before.len() + pages.len() * PAGE_SIZE,
            "uncovered WAL growth"
        );
        let mut image = before.to_vec();
        image.resize(size, 0);
        for (number, data) in pages {
            let start = (number as usize - 1) * PAGE_SIZE;
            ensure!(start + PAGE_SIZE <= size, "WAL page beyond database");
            image[start..start + PAGE_SIZE].copy_from_slice(&data);
        }
        Ok(image)
    }
}
fn checksum(bytes: &[u8], mut s: (u32, u32), little: bool) -> (u32, u32) {
    for words in bytes.chunks_exact(8) {
        let read = |x: &[u8]| {
            if little {
                u32::from_le_bytes(x.try_into().unwrap())
            } else {
                u32::from_be_bytes(x.try_into().unwrap())
            }
        };
        s.0 = s.0.wrapping_add(read(&words[..4])).wrapping_add(s.1);
        s.1 = s.1.wrapping_add(read(&words[4..])).wrapping_add(s.0);
    }
    s
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WalDelta {
    version: String,
    logical: LogicalFrames,
    physical: WalFrames,
}
struct Live {
    state: State,
    recorder: Arc<Mutex<Recorder>>,
    cursor: String,
}
impl Live {
    fn open(image: &[u8]) -> Result<Self> {
        let recorder = Arc::new(Mutex::new(Recorder::default()));
        let io = Arc::new(WalIO {
            inner: MemoryIO::new(),
            recorder: recorder.clone(),
        });
        let native = Native::open_on(io, image, None, true)?;
        let state = State {
            native,
            image: vec![],
        };
        let cursor = state.milestone()?;
        *recorder.lock().unwrap() = Recorder::default();
        Ok(Self {
            state,
            recorder,
            cursor,
        })
    }
    fn commit(&mut self, markers: &BTreeMap<String, Marker>) -> Result<WalDelta> {
        for (flow, marker) in markers {
            crate::event::valid_flow(flow)?;
            let expected = self
                .state
                .latest(flow)?
                .map_or_else(Viewpoint::zero, |v| v.next());
            ensure!(marker.validate()? == expected, "Viewpoint gap");
        }
        let milestone = (self.cursor.parse::<num_bigint::BigUint>()? + 1u8).to_string();
        State::transact(&self.state.native, &milestone, markers)?;
        self.capture(milestone)
    }
    fn capture(&mut self, milestone: String) -> Result<WalDelta> {
        let native = &self.state.native;
        let bytes = read_file(&*native.io, &*native.storage.get_logical_log_file())?;
        let frames = std::mem::take(&mut *native.storage.frames.lock().unwrap());
        ensure!(
            frames.len() == 1 && bytes.len() > LOG_HDR_SIZE,
            "missing logical transaction"
        );
        let logical = LogicalFrames {
            base: None,
            header: Blob(bytes[..LOG_HDR_SIZE].to_vec()),
            frames,
        };
        logical.validated_bytes()?;
        native.checkpoint()?;
        let mut recorder = self.recorder.lock().unwrap();
        if !recorder.current.is_empty() {
            let current = std::mem::take(&mut recorder.current);
            recorder.segments.push(Blob(current));
        }
        let physical = WalFrames {
            base: self.cursor.clone(),
            milestone: milestone.clone(),
            segments: std::mem::take(&mut recorder.segments),
        };
        physical.pages()?;
        self.cursor = milestone;
        Ok(WalDelta {
            version: VERSION.into(),
            logical,
            physical,
        })
    }
    fn image(&self) -> Result<Vec<u8>> {
        self.state.native.image()
    }
}

#[test]
fn wal_capture_reconstructs_without_database_diff() -> Result<()> {
    let base = State::genesis()?;
    let mut before = base.image;
    let mut live = Live::open(&before)?;
    for n in 0..20 {
        let markers = BTreeMap::from([(
            format!("flow-{}", n % 4),
            Marker {
                viewpoint: (n / 4).to_string(),
                sha384: hash(&[]),
                blob: vec![],
            },
        )]);
        let delta = live.commit(&markers)?;
        let physical = delta.physical.ingest(&before, &n.to_string())?;
        let logical = State::ingest_logical(&before, &delta.logical)?;
        assert_eq!(physical, live.image()?);
        assert_eq!(logical.image, physical);
        before = physical;
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct WalCommand {
    markers: BTreeMap<String, Marker>,
    deltas: WalDeltas,
}

#[derive(Serialize, Deserialize)]
struct WalDeltas {
    turso: BTreeMap<String, WalDelta>,
}
fn encode_wal(markers: BTreeMap<String, Marker>, delta: WalDelta) -> Result<Vec<u8>> {
    Ok(flexbuffers::to_vec(vec![(
        crate::flexbuffer::Extension::WellKnownSymbol("species".into()).payload()?,
        crate::event::NAMESPACE,
        crate::event::COMMIT_FLOW,
        WalCommand {
            markers,
            deltas: WalDeltas {
                turso: BTreeMap::from([(ID.into(), delta)]),
            },
        },
    )])?)
}
fn decode_wal(bytes: &[u8]) -> Result<WalCommand> {
    let root = flexbuffers::Reader::get_root(bytes)?.get_vector()?;
    ensure!(root.len() == 1, "expected unary command");
    let tuple = root.index(0)?.get_vector()?;
    ensure!(
        tuple.len() == 4
            && crate::flexbuffer::read(tuple.index(0)?)?
                == crate::flexbuffer::Extension::WellKnownSymbol("species".into()),
        "invalid command species"
    );
    ensure!(
        tuple.index(1)?.get_str()? == crate::event::NAMESPACE
            && tuple.index(2)?.get_str()? == crate::event::COMMIT_FLOW,
        "unknown command"
    );
    Ok(WalCommand::deserialize(tuple.index(3)?)?)
}
fn recover_wal(before: &[u8], base: &str, bytes: &[u8]) -> Result<State> {
    let command = decode_wal(bytes)?;
    let delta = command
        .deltas
        .turso
        .get(ID)
        .context("missing Turso delta")?;
    ensure!(delta.version == VERSION, "incompatible Turso version");
    delta.logical.validated_bytes()?;
    let prior = State::from_image(before.to_vec())?;
    let image = delta.physical.ingest(before, base)?;
    let next = State::from_image(image)?;
    let mut expected = prior.flows()?;
    for (flow, marker) in command.markers {
        let v = marker.validate()?;
        ensure!(
            v == expected
                .get(&flow)
                .map_or_else(Viewpoint::zero, |v| v.next()),
            "Viewpoint gap"
        );
        expected.insert(flow, v);
    }
    ensure!(
        next.flows()? == expected && next.milestone()? == delta.physical.milestone,
        "recovered state mismatch"
    );
    Ok(next)
}

fn recover_wal_sparse(prior: &State, bytes: &[u8]) -> Result<State> {
    let command = decode_wal(bytes)?;
    let delta = command
        .deltas
        .turso
        .get(ID)
        .context("missing Turso delta")?;
    ensure!(delta.version == VERSION, "incompatible Turso version");
    delta.logical.validated_bytes()?;
    let base = prior.milestone()?;
    for (flow, marker) in &command.markers {
        ensure!(
            marker.validate()?
                == prior
                    .latest(flow)?
                    .map_or_else(Viewpoint::zero, |v| v.next()),
            "Viewpoint gap"
        );
    }
    let next = State::from_image(delta.physical.ingest(&prior.image, &base)?)?;
    ensure!(
        next.milestone()? == delta.physical.milestone,
        "recovered Milestone mismatch"
    );
    for (flow, marker) in &command.markers {
        ensure!(
            next.latest(flow)? == Some(marker.validate()?),
            "recovered Viewpoint mismatch"
        );
    }
    Ok(next)
}

struct Prepared {
    milestone: u64,
    bytes: Vec<u8>,
    acknowledgements: Vec<tokio::sync::oneshot::Sender<std::result::Result<u64, String>>>,
    start: std::time::Instant,
}
#[derive(Serialize)]
struct Published {
    milestone: u64,
    requests: usize,
    latency_us: f64,
    put_us: f64,
    event_bytes: usize,
    completed_us: f64,
}
async fn publish_ordered<F, Fut>(
    mut queue: tokio::sync::mpsc::Receiver<Prepared>,
    mut put: F,
) -> Result<Vec<Published>>
where
    F: FnMut(u64, Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let origin = std::time::Instant::now();
    let mut durable = 1;
    let mut published = Vec::new();
    while let Some(prepared) = queue.recv().await {
        let start = std::time::Instant::now();
        let size = prepared.bytes.len();
        let result = if prepared.milestone == durable + 1 {
            put(prepared.milestone, prepared.bytes).await
        } else {
            anyhow::bail!("publication Milestone gap")
        };
        let put_us = start.elapsed().as_secs_f64() * 1e6;
        match result {
            Ok(()) => {
                durable = prepared.milestone;
                let requests = prepared.acknowledgements.len();
                let latency_us = prepared.start.elapsed().as_secs_f64() * 1e6;
                for ack in prepared.acknowledgements {
                    let _ = ack.send(Ok(durable));
                }
                published.push(Published {
                    milestone: durable,
                    requests,
                    latency_us,
                    put_us,
                    event_bytes: size,
                    completed_us: origin.elapsed().as_secs_f64() * 1e6,
                });
            }
            Err(error) => {
                queue.close();
                for ack in prepared.acknowledgements {
                    let _ = ack.send(Err(error.to_string()));
                }
                while let Some(pending) = queue.recv().await {
                    for ack in pending.acknowledgements {
                        let _ = ack.send(Err("prior upload failed".into()));
                    }
                }
                return Err(error);
            }
        }
    }
    Ok(published)
}

#[tokio::test]
async fn acknowledgements_wait_for_durability_and_failed_prefix_stops_pipeline() -> Result<()> {
    use tokio::sync::{Notify, mpsc, oneshot};
    let gate = Arc::new(Notify::new());
    let stored = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel(2);
    let mut answers = Vec::new();
    for milestone in 2..4 {
        let (ack, answer) = oneshot::channel();
        answers.push(answer);
        tx.send(Prepared {
            milestone,
            bytes: vec![],
            acknowledgements: vec![ack],
            start: std::time::Instant::now(),
        })
        .await?;
    }
    let task = tokio::spawn({
        let gate = gate.clone();
        let stored = stored.clone();
        async move {
            publish_ordered(rx, move |m, _| {
                let gate = gate.clone();
                let stored = stored.clone();
                async move {
                    gate.notified().await;
                    stored.lock().unwrap().push(m);
                    if m == 3 {
                        anyhow::bail!("durable PUT reply lost");
                    }
                    Ok(())
                }
            })
            .await
        }
    });
    assert!(matches!(
        answers[0].try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    gate.notify_one();
    assert_eq!(answers.remove(0).await?.map_err(anyhow::Error::msg)?, 2);
    let (ack, last) = oneshot::channel();
    tx.send(Prepared {
        milestone: 4,
        bytes: vec![],
        acknowledgements: vec![ack],
        start: std::time::Instant::now(),
    })
    .await?;
    assert!(matches!(
        answers[0].try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    gate.notify_one();
    assert!(answers.remove(0).await?.is_err());
    assert!(last.await?.is_err());
    drop(tx);
    assert!(task.await?.is_err());
    assert_eq!(*stored.lock().unwrap(), vec![2, 3]);
    Ok(())
}

#[test]
fn wal_growth_deletion_rollback_and_corruption() -> Result<()> {
    let mut image = State::genesis()?.image;
    let mut live = Live::open(&image)?;
    let markers: BTreeMap<_, _> = (0..400)
        .map(|n| {
            (
                format!(
                    "flow-{n:04}/{}",
                    "雪".repeat(if n == 1 { 10000 } else { 100 })
                ),
                Marker {
                    viewpoint: "0".into(),
                    sha384: hash(&[]),
                    blob: vec![],
                },
            )
        })
        .collect();
    let delta = live.commit(&markers)?;
    let wire = encode_wal(markers, delta.clone())?;
    let reconstructed = recover_wal(&image, "0", &wire)?;
    assert_eq!(reconstructed.image, live.image()?);
    assert_eq!(
        State::ingest_logical(&image, &delta.logical)?.image,
        reconstructed.image
    );
    image = reconstructed.image;
    let mut before_cursor = delta.physical.milestone;
    for sql in [
        "DELETE FROM flows WHERE rowid % 2 = 0",
        "DELETE FROM flows",
        "INSERT INTO flows VALUES ('reuse', '340282366920938463463374607431768211456')",
    ] {
        let native = &live.state.native;
        native
            .conn
            .execute("BEGIN CONCURRENT; INSERT INTO flows VALUES ('abandoned','999'); ROLLBACK")?;
        let next = (before_cursor.parse::<u64>()? + 1).to_string();
        native.conn.execute("BEGIN CONCURRENT")?;
        native.conn.execute(sql)?;
        native
            .conn
            .execute(format!("UPDATE basin SET milestone='{next}'"))?;
        native.conn.execute("COMMIT")?;
        let delta = live.capture(next.clone())?;
        let physical = delta.physical.ingest(&image, &before_cursor)?;
        assert_eq!(physical, live.image()?);
        assert_eq!(
            physical,
            State::ingest_logical(&image, &delta.logical)?.image
        );
        for cut in [0, 1, 31, 32, delta.physical.segments[0].0.len() - 1] {
            let mut bad = delta.physical.clone();
            bad.segments[0].0.truncate(cut);
            assert!(bad.pages().is_err());
        }
        for pos in [0, 16, 24, 32, 56, delta.physical.segments[0].0.len() - 1] {
            let mut bad = delta.physical.clone();
            bad.segments[0].0[pos] ^= 1;
            assert!(bad.pages().is_err());
        }
        assert!(delta.physical.ingest(&image, "999").is_err());
        let mut bad = delta.physical.clone();
        bad.milestone = "999".into();
        assert!(bad.ingest(&image, &before_cursor).is_err());
        let opened = State::from_image(physical.clone())?;
        assert_eq!(
            opened.native.conn.pragma_query("integrity_check")?,
            vec![vec![Value::build_text("ok")]]
        );
        assert!(opened.latest("abandoned")?.is_none());
        image = physical;
        before_cursor = next;
    }
    Ok(())
}

proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config::with_cases(32))]
    #[test]
    fn randomized_wal_histories_match_logical_replay(ops in proptest::collection::vec(proptest::collection::vec(0u16..128,1..16),2..30)) {
        let mut before=State::genesis().unwrap().image;
        let mut live=Live::open(&before).unwrap();
        for (n,batch) in ops.into_iter().enumerate() {
            let mut markers=BTreeMap::new();
            for id in batch {
                let flow=format!("{id}/雪");
                let vp=live.state.latest(&flow).unwrap().map_or_else(Viewpoint::zero,|v|v.next());
                markers.insert(flow,Marker {viewpoint:vp.decimal(),sha384:hash(&[]),blob:vec![]});
            }
            let delta=live.commit(&markers).unwrap();
            let wire=encode_wal(markers,delta.clone()).unwrap();
            let next=recover_wal(&before,&n.to_string(),&wire).unwrap();
            let sparse=recover_wal_sparse(&State::from_image(before.clone()).unwrap(),&wire).unwrap();
            proptest::prop_assert_eq!(&sparse.image,&next.image);
            proptest::prop_assert_eq!(&next.image,&live.image().unwrap());
            proptest::prop_assert_eq!(&next.image,&State::ingest_logical(&before,&delta.logical).unwrap().image);
            before=next.image;
        }
    }
}

enum Engine {
    Image { state: State, verify: bool },
    Copy { state: State, hashed: bool },
    Live(Live),
    Vector(Live),
}
impl Engine {
    fn open(kind: &str, image: &[u8]) -> Result<Self> {
        Ok(match kind {
            "image-verify" => Self::Image {
                state: State::from_image(image.to_vec())?,
                verify: true,
            },
            "image-no-replay" => Self::Image {
                state: State::from_image(image.to_vec())?,
                verify: false,
            },
            "wal-copy-hashed" => Self::Copy {
                state: State::from_image(image.to_vec())?,
                hashed: true,
            },
            "wal-copy" => Self::Copy {
                state: State::from_image(image.to_vec())?,
                hashed: false,
            },
            "wal-live" => Self::Live(Live::open(image)?),
            "wal-vector" => Self::Vector(Live::open(image)?),
            _ => anyhow::bail!("unknown engine"),
        })
    }
    fn prepare(&mut self, milestone: u64, markers: BTreeMap<String, Marker>) -> Result<Vec<u8>> {
        match self {
            Self::Image { state, verify } => {
                for (flow, marker) in &markers {
                    ensure!(
                        marker.validate()?
                            == state
                                .latest(flow)?
                                .map_or_else(Viewpoint::zero, |v| v.next()),
                        "Viewpoint gap"
                    );
                }
                let native = Native::open(&state.image, None)?;
                State::transact(&native, &milestone.to_string(), &markers)?;
                let (next, delta) = state.capture_policy(native, false, *verify, &mut |_| {})?;
                *state = next;
                Ok(crate::event::encode(crate::event::CommitFlow {
                    markers,
                    deltas: crate::event::Deltas {
                        turso: BTreeMap::from([(ID.into(), delta)]),
                    },
                })?)
            }
            Self::Copy { state, hashed } => {
                let mut live = Live::open(&state.image)?;
                let delta = live.commit(&markers)?;
                ensure!(
                    delta.physical.milestone == milestone.to_string(),
                    "Milestone mismatch"
                );
                let image = delta
                    .physical
                    .ingest(&state.image, &(milestone - 1).to_string())?;
                let bytes = if *hashed {
                    let (_, pages) = delta.physical.pages()?;
                    let physical = PhysicalFrames {
                        before: hash(&state.image),
                        after: hash(&image),
                        size: image.len() as u64,
                        pages: pages
                            .into_iter()
                            .map(|(number, data)| PageFrame {
                                number,
                                data: Blob(data),
                            })
                            .collect(),
                    };
                    crate::event::encode(crate::event::CommitFlow {
                        markers,
                        deltas: crate::event::Deltas {
                            turso: BTreeMap::from([(
                                ID.into(),
                                Delta {
                                    version: VERSION.into(),
                                    logical: delta.logical,
                                    physical,
                                },
                            )]),
                        },
                    })?
                } else {
                    encode_wal(markers, delta)?
                };
                *state = State {
                    native: live.state.native,
                    image,
                };
                Ok(bytes)
            }
            Self::Vector(live) => {
                let requests: Vec<_> = markers.into_iter().collect();
                let delta = live.commit_ordered(&requests)?;
                ensure!(
                    delta.physical.milestone == milestone.to_string(),
                    "Milestone mismatch"
                );
                encode_vector(requests, delta)
            }
            Self::Live(live) => {
                let delta = live.commit(&markers)?;
                ensure!(
                    delta.physical.milestone == milestone.to_string(),
                    "Milestone mismatch"
                );
                encode_wal(markers, delta)
            }
        }
    }
    fn image(&self) -> Result<Vec<u8>> {
        match self {
            Self::Image { state, .. } | Self::Copy { state, .. } => Ok(state.image.clone()),
            Self::Live(live) | Self::Vector(live) => live.image(),
        }
    }
}
fn input(index: usize, batch: usize, flows: usize, blob: &[u8]) -> BTreeMap<String, Marker> {
    (index..index + batch)
        .map(|n| {
            (
                format!("flow-{:06}", n % flows),
                Marker {
                    viewpoint: (n / flows + 1).to_string(),
                    sha384: hash(blob),
                    blob: blob.to_vec(),
                },
            )
        })
        .collect()
}
fn verify_final(
    image: Vec<u8>,
    count: usize,
    flows: usize,
    milestone: usize,
    hot: bool,
) -> Result<()> {
    let state = State::from_image(image)?;
    ensure!(
        state.milestone()? == milestone.to_string(),
        "final Milestone mismatch"
    );
    let all = state.flows()?;
    ensure!(all.len() == flows, "final Flow count mismatch");
    for n in 0..flows {
        let expected = if hot {
            if n == 0 { count } else { 0 }
        } else if n < count {
            (count - 1 - n) / flows + 1
        } else {
            0
        };
        ensure!(
            all[&format!("flow-{n:06}")].decimal() == expected.to_string(),
            "final Viewpoint mismatch"
        );
    }
    ensure!(
        state.native.conn.pragma_query("integrity_check")? == vec![vec![Value::build_text("ok")]],
        "integrity failure"
    );
    Ok(())
}

#[test]
#[ignore = "explicit performance experiment"]
fn measure() -> Result<()> {
    use std::{env, fs, time::Instant};
    let kind = env::var("EXP_ENGINE")?;
    let mode = env::var("EXP_MODE").unwrap_or_else(|_| "cpu".into());
    let count: usize = env::var("EXP_COUNT")?.parse()?;
    let warmup: usize = env::var("EXP_WARMUP")?.parse()?;
    let flows: usize = env::var("EXP_FLOWS")?.parse()?;
    let batch: usize = env::var("EXP_BATCH")
        .unwrap_or_else(|_| "1".into())
        .parse()?;
    ensure!(
        batch > 0 && batch <= flows && count.is_multiple_of(batch) && warmup.is_multiple_of(batch),
        "invalid batch size"
    );
    let initial = fs::read(env::var("BENCH_SEED_IMAGE")?)?;
    let initial_hash = hash(&initial);
    let blob: Vec<_> = (0..4096).map(|n| (n % 251) as u8).collect();
    let mut engine = Engine::open(&kind, &initial)?;
    let output = env::var("EXP_OUTPUT")?;
    if mode.starts_with("recover-") {
        let mut events = Vec::new();
        for n in 0..warmup + count {
            events.push(engine.prepare(
                (n + 2) as u64,
                input(n, 1, if kind == "wal-vector" { 1 } else { flows }, &blob),
            )?);
        }
        let mut basin = crate::timeline::Basin {
            milestone: 1u8.into(),
            database: Some(State::from_image(initial.clone())?),
            stopped: false,
        };
        let mut state = State::from_image(initial.clone())?;
        let mut samples = Vec::new();
        for (n, bytes) in events.iter().enumerate() {
            let start = Instant::now();
            if kind == "image-verify" {
                basin.apply((n + 2).into(), crate::event::decode(bytes)?)?;
            } else if kind == "wal-vector" {
                state = recover_vector(&state, bytes)?;
            } else if mode == "recover-sparse" {
                state = recover_wal_sparse(&state, bytes)?;
            } else {
                state = recover_wal(&state.image, &(n + 1).to_string(), bytes)?;
            }
            if n >= warmup {
                samples.push(serde_json::json!({"latency_us":start.elapsed().as_secs_f64()*1e6,"event_bytes":bytes.len()}));
            }
        }
        let image = if kind == "image-verify" {
            basin.database.unwrap().image
        } else {
            state.image
        };
        ensure!(
            image == engine.image()?,
            "reconstruction differs from source database"
        );
        verify_final(
            image,
            warmup + count,
            flows,
            warmup + count + 1,
            kind == "wal-vector",
        )?;
        fs::write(
            output,
            serde_json::to_vec(
                &serde_json::json!({"engine":kind,"mode":mode,"batch":batch,"count":count,"warmup":warmup,"flows":flows,"initial_sha384":initial_hash,"initial_bytes":initial.len(),"samples":samples}),
            )?,
        )?;
        return Ok(());
    }
    if mode == "cpu" {
        let mut samples = Vec::new();
        for n in 0..warmup + count {
            let markers = input(n, 1, if kind == "wal-vector" { 1 } else { flows }, &blob);
            let start = Instant::now();
            let bytes = engine.prepare((n + 2) as u64, markers)?;
            if n >= warmup {
                samples.push(serde_json::json!({"latency_us":start.elapsed().as_secs_f64()*1e6,"event_bytes":bytes.len()}));
            }
        }
        verify_final(
            engine.image()?,
            warmup + count,
            flows,
            warmup + count + 1,
            kind == "wal-vector",
        )?;
        fs::write(
            output,
            serde_json::to_vec(
                &serde_json::json!({"engine":kind,"mode":mode,"batch":batch,"count":count,"warmup":warmup,"flows":flows,"initial_sha384":initial_hash,"initial_bytes":initial.len(),"samples":samples}),
            )?,
        )?;
        return Ok(());
    }
    ensure!(mode == "serial" || mode == "pipeline", "unknown mode");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()?;
    let handle = runtime.handle().clone();
    let creds = s3::creds::Credentials::new(
        Some(&env::var("AWS_ACCESS_KEY_ID")?),
        Some(&env::var("AWS_SECRET_ACCESS_KEY")?),
        None,
        None,
        None,
    )?;
    s3::set_retries(0);
    let bucket = s3::Bucket::new(
        &env::var("S3_BUCKET")?,
        s3::Region::Custom {
            region: "us-east-1".into(),
            endpoint: env::var("S3_ENDPOINT")?,
        },
        creds,
    )?
    .with_path_style();
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let pipeline = mode == "pipeline";
    let producer = std::thread::spawn(move || -> Result<Vec<u8>> {
        let mut answers = Vec::new();
        for (group, index) in (0..warmup + count).step_by(batch).enumerate() {
            // Reserving before preparation bounds speculation to one batch ahead.
            let permit = handle.block_on(tx.clone().reserve_owned())?;
            let start = Instant::now();
            let bytes = if let Engine::Vector(live) = &mut engine {
                let requests: Vec<_> = (index..index + batch)
                    .map(|n| {
                        (
                            "flow-000000".into(),
                            Marker {
                                viewpoint: (n + 1).to_string(),
                                sha384: hash(&blob),
                                blob: blob.clone(),
                            },
                        )
                    })
                    .collect();
                let delta = live.commit_ordered(&requests)?;
                ensure!(
                    delta.physical.milestone == (group + 2).to_string(),
                    "Milestone mismatch"
                );
                encode_vector(requests, delta)?
            } else {
                let markers = input(index, batch, flows, &blob);
                ensure!(markers.len() == batch, "batch repeats a Flow");
                engine.prepare((group + 2) as u64, markers)?
            };
            let mut acknowledgements = Vec::new();
            let mut receivers = Vec::new();
            for _ in 0..batch {
                let (ack, answer) = tokio::sync::oneshot::channel();
                acknowledgements.push(ack);
                receivers.push(answer);
            }
            permit.send(Prepared {
                milestone: (group + 2) as u64,
                bytes,
                acknowledgements,
                start,
            });
            if pipeline {
                answers.extend(receivers);
            } else {
                for answer in receivers {
                    handle.block_on(answer)?.map_err(anyhow::Error::msg)?;
                }
            }
        }
        for answer in answers {
            handle.block_on(answer)?.map_err(anyhow::Error::msg)?;
        }
        engine.image()
    });
    let records = runtime.block_on(publish_ordered(rx, |milestone, bytes| {
        let bucket = &bucket;
        async move {
            let response = bucket
                .put_object_with_headers(
                    crate::diffuse16::key(&milestone.into())?,
                    &bytes,
                    Some(axum::http::HeaderMap::from_iter([(
                        axum::http::header::IF_NONE_MATCH,
                        axum::http::HeaderValue::from_static("*"),
                    )])),
                )
                .await?;
            ensure!(
                (200..300).contains(&response.status_code()),
                "conditional PUT failed: {}",
                response.status_code()
            );
            Ok(())
        }
    }))?;
    let final_image = producer
        .join()
        .map_err(|_| anyhow::anyhow!("producer panicked"))??;
    verify_final(
        final_image.clone(),
        warmup + count,
        flows,
        (warmup + count) / batch + 1,
        kind == "wal-vector",
    )?;
    // Untimed full recovery from the actual uploaded objects, followed by byte comparison.
    let mut recovered = initial.clone();
    for milestone in 2..(warmup + count) / batch + 2 {
        let response =
            runtime.block_on(bucket.get_object(crate::diffuse16::key(&milestone.into())?))?;
        ensure!(response.status_code() == 200, "missing acknowledged event");
        if kind == "image-verify" || kind == "image-no-replay" || kind == "wal-copy-hashed" {
            let command = crate::event::decode(response.as_slice())?;
            recovered = command.deltas.turso[ID].physical.ingest(&recovered)?;
        } else if kind == "wal-vector" {
            let (_, delta) = decode_vector(response.as_slice())?;
            ensure!(delta.version == VERSION, "version mismatch");
            delta.logical.validated_bytes()?;
            recovered = delta
                .physical
                .ingest(&recovered, &(milestone - 1).to_string())?;
        } else {
            let command = decode_wal(response.as_slice())?;
            let delta = &command.deltas.turso[ID];
            ensure!(delta.version == VERSION, "version mismatch");
            delta.logical.validated_bytes()?;
            recovered = delta
                .physical
                .ingest(&recovered, &(milestone - 1).to_string())?;
        }
    }
    ensure!(
        recovered == final_image,
        "S3 recovery differs from acknowledged state"
    );
    let skipped = warmup / batch;
    let measured_us = records.last().unwrap().completed_us
        - if skipped > 0 {
            records[skipped - 1].completed_us
        } else {
            0.0
        };
    let samples = &records[skipped..];
    ensure!(
        samples.iter().map(|r| r.requests).sum::<usize>() == count,
        "missing acknowledgements"
    );
    fs::write(
        output,
        serde_json::to_vec(
            &serde_json::json!({"engine":kind,"mode":mode,"batch":batch,"count":count,"warmup":warmup,"flows":flows,"initial_sha384":initial_hash,"initial_bytes":initial.len(),"requests_per_second":count as f64*1e6/measured_us,"samples":samples}),
        )?,
    )?;
    Ok(())
}

#[tokio::test]
async fn failed_leadership_stops_before_later_puts_and_abandoned_client_does_not_cancel_batch()
-> Result<()> {
    use tokio::sync::{mpsc, oneshot};
    for fail in [true, false] {
        let (tx, rx) = mpsc::channel(2);
        let mut answers = Vec::new();
        for milestone in 2..4 {
            let (ack, answer) = oneshot::channel();
            answers.push(answer);
            let (abandoned, closed) = oneshot::channel();
            drop(closed);
            tx.send(Prepared {
                milestone,
                bytes: vec![],
                acknowledgements: vec![abandoned, ack],
                start: std::time::Instant::now(),
            })
            .await?;
        }
        drop(tx);
        let stored = Arc::new(Mutex::new(Vec::new()));
        let result = publish_ordered(rx, {
            let stored = stored.clone();
            move |m, _| {
                let stored = stored.clone();
                async move {
                    if fail {
                        anyhow::bail!("conditional PUT lost leadership")
                    }
                    stored.lock().unwrap().push(m);
                    Ok(())
                }
            }
        })
        .await;
        for answer in answers {
            assert_eq!(answer.await?.is_ok(), !fail);
        }
        assert_eq!(result.is_ok(), !fail);
        assert_eq!(
            *stored.lock().unwrap(),
            if fail { vec![] } else { vec![2, 3] }
        );
    }
    Ok(())
}

#[tokio::test]
async fn actual_frames_recover_after_stored_batch_reply_is_lost() -> Result<()> {
    use tokio::sync::{mpsc, oneshot};
    let base = State::genesis()?;
    let seed_markers = BTreeMap::from([(
        "a".into(),
        Marker {
            viewpoint: "0".into(),
            sha384: hash(&[]),
            blob: vec![],
        },
    )]);
    let (seed, _) = base.stage("1", &seed_markers, true)?;
    let mut live = Live::open(&seed.image)?;
    let (tx, rx) = mpsc::channel(3);
    let mut answers = Vec::new();
    let mut expected = Vec::new();
    for milestone in 2..5 {
        let markers = BTreeMap::from([(
            "a".into(),
            Marker {
                viewpoint: (milestone - 1).to_string(),
                sha384: hash(&[]),
                blob: vec![],
            },
        )]);
        let delta = live.commit(&markers)?;
        if milestone == 3 {
            expected = live.image()?;
        }
        let (ack, answer) = oneshot::channel();
        answers.push(answer);
        tx.send(Prepared {
            milestone,
            bytes: encode_wal(markers, delta)?,
            acknowledgements: vec![ack],
            start: std::time::Instant::now(),
        })
        .await?;
    }
    drop(tx);
    let stored = Arc::new(Mutex::new(BTreeMap::new()));
    let result = publish_ordered(rx, {
        let stored = stored.clone();
        move |m, bytes| {
            let stored = stored.clone();
            async move {
                stored.lock().unwrap().insert(m, bytes);
                if m == 3 {
                    anyhow::bail!("reply lost after durable write")
                }
                Ok(())
            }
        }
    })
    .await;
    assert!(result.is_err());
    assert_eq!(answers.remove(0).await?.map_err(anyhow::Error::msg)?, 2);
    for answer in answers {
        assert!(answer.await?.is_err());
    }
    let mut image = seed.image;
    for (&m, bytes) in stored.lock().unwrap().iter() {
        image = recover_wal(&image, &(m - 1).to_string(), bytes)?.image;
    }
    assert_eq!(image, expected);
    assert_eq!(
        stored.lock().unwrap().keys().copied().collect::<Vec<_>>(),
        vec![2, 3]
    );
    Ok(())
}

#[tokio::test]
async fn reservation_bounds_speculation_before_first_put_completes() -> Result<()> {
    use tokio::sync::{Notify, mpsc, oneshot};
    let (tx, rx) = mpsc::channel(1);
    let (prepared, mut ready) = mpsc::unbounded_channel();
    let gate = Arc::new(Notify::new());
    let producer = tokio::spawn(async move {
        for milestone in 2..10 {
            let Ok(permit) = tx.clone().reserve_owned().await else {
                break;
            };
            prepared.send(milestone).unwrap();
            let (ack, _) = oneshot::channel();
            permit.send(Prepared {
                milestone,
                bytes: vec![],
                acknowledgements: vec![ack],
                start: std::time::Instant::now(),
            });
        }
    });
    let publisher = tokio::spawn({
        let gate = gate.clone();
        async move {
            publish_ordered(rx, move |_, _| {
                let gate = gate.clone();
                async move {
                    gate.notified().await;
                    anyhow::bail!("PUT failed")
                }
            })
            .await
        }
    });
    assert_eq!(ready.recv().await, Some(2));
    assert_eq!(ready.recv().await, Some(3));
    tokio::task::yield_now().await;
    assert!(matches!(
        ready.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    gate.notify_one();
    assert!(publisher.await?.is_err());
    producer.await?;
    assert!(ready.recv().await.is_none());
    Ok(())
}

const INGEST_TURSO: &str = "sts/0/databasin/ingestturso";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FlowOnly {
    markers: BTreeMap<String, Marker>,
}
#[derive(Serialize)]
#[serde(untagged)]
enum VectorBody {
    Flow(FlowOnly),
    Ingest(WalDeltas),
}
fn encode_vector(requests: Vec<(String, Marker)>, delta: WalDelta) -> Result<Vec<u8>> {
    let species = crate::flexbuffer::Extension::WellKnownSymbol("species".into()).payload()?;
    let mut commands = Vec::new();
    for (flow, marker) in requests {
        commands.push((
            species.clone(),
            crate::event::NAMESPACE,
            crate::event::COMMIT_FLOW,
            VectorBody::Flow(FlowOnly {
                markers: BTreeMap::from([(flow, marker)]),
            }),
        ));
    }
    commands.push((
        species,
        crate::event::NAMESPACE,
        INGEST_TURSO,
        VectorBody::Ingest(WalDeltas {
            turso: BTreeMap::from([(ID.into(), delta)]),
        }),
    ));
    Ok(flexbuffers::to_vec(commands)?)
}
fn decode_vector(bytes: &[u8]) -> Result<(Vec<BTreeMap<String, Marker>>, WalDelta)> {
    let root = flexbuffers::Reader::get_root(bytes)?.get_vector()?;
    ensure!(root.len() >= 2, "missing commands or ingestion");
    let mut commands = Vec::new();
    let mut delta = None;
    for n in 0..root.len() {
        let tuple = root.index(n)?.get_vector()?;
        ensure!(
            tuple.len() == 4
                && crate::flexbuffer::read(tuple.index(0)?)?
                    == crate::flexbuffer::Extension::WellKnownSymbol("species".into())
                && tuple.index(1)?.get_str()? == crate::event::NAMESPACE,
            "invalid tuple"
        );
        let op = tuple.index(2)?.get_str()?;
        if n + 1 == root.len() {
            ensure!(
                op == INGEST_TURSO,
                "last command must ingest the transaction's frames"
            );
            let mut deltas = WalDeltas::deserialize(tuple.index(3)?)?;
            ensure!(deltas.turso.len() == 1, "expected one database delta");
            delta = Some(deltas.turso.remove(ID).context("missing default.turso")?);
        } else {
            ensure!(
                op == crate::event::COMMIT_FLOW,
                "expected commitflow before ingestion"
            );
            let markers = FlowOnly::deserialize(tuple.index(3)?)?.markers;
            ensure!(!markers.is_empty(), "empty commitflow");
            commands.push(markers);
        }
    }
    Ok((commands, delta.unwrap()))
}
impl Live {
    fn commit_ordered(&mut self, requests: &[(String, Marker)]) -> Result<WalDelta> {
        ensure!(!requests.is_empty(), "empty batch");
        let mut final_markers: BTreeMap<String, Marker> = BTreeMap::new();
        for (flow, marker) in requests {
            crate::event::valid_flow(flow)?;
            let previous = match final_markers.get(flow) {
                Some(previous) => Some(previous.validate()?),
                None => self.state.latest(flow)?,
            };
            ensure!(
                marker.validate()? == previous.map_or_else(Viewpoint::zero, |v| v.next()),
                "Viewpoint gap inside batch"
            );
            final_markers.insert(flow.clone(), marker.clone());
        }
        let milestone = (self.cursor.parse::<num_bigint::BigUint>()? + 1u8).to_string();
        State::transact(&self.state.native, &milestone, &final_markers)?;
        self.capture(milestone)
    }
}
fn recover_vector(prior: &State, bytes: &[u8]) -> Result<State> {
    let (commands, delta) = decode_vector(bytes)?;
    ensure!(delta.version == VERSION, "version mismatch");
    delta.logical.validated_bytes()?;
    let mut expected: BTreeMap<String, Viewpoint> = BTreeMap::new();
    for markers in commands {
        for (flow, marker) in markers {
            let previous = if let Some(previous) = expected.get(&flow) {
                Some(previous.clone())
            } else {
                prior.latest(&flow)?
            };
            let vp = marker.validate()?;
            ensure!(
                vp == previous.map_or_else(Viewpoint::zero, |v| v.next()),
                "Viewpoint gap inside batch"
            );
            expected.insert(flow, vp);
        }
    }
    let next = State::from_image(delta.physical.ingest(&prior.image, &prior.milestone()?)?)?;
    ensure!(
        next.milestone()? == delta.physical.milestone,
        "Milestone mismatch"
    );
    for (flow, vp) in expected {
        ensure!(
            next.latest(&flow)? == Some(vp),
            "materialized Viewpoint mismatch"
        );
    }
    Ok(next)
}

#[test]
fn ordered_same_flow_commands_materialize_atomically_and_recover() -> Result<()> {
    let mut prior = State::genesis()?;
    let mut live = Live::open(&prior.image)?;
    for batch in 0..10 {
        let requests: Vec<_> = (0..32)
            .map(|offset| {
                (
                    "hot".into(),
                    Marker {
                        viewpoint: (batch * 32 + offset).to_string(),
                        sha384: hash(&[offset as u8]),
                        blob: vec![offset as u8],
                    },
                )
            })
            .collect();
        let delta = live.commit_ordered(&requests)?;
        let bytes = encode_vector(requests.clone(), delta.clone())?;
        if batch == 0 {
            let mut bad = delta.clone();
            bad.version = "incompatible".into();
            assert!(recover_vector(&prior, &encode_vector(requests.clone(), bad)?).is_err());
            let mut bad = delta.clone();
            bad.physical.segments[0].0[56] ^= 1;
            assert!(recover_vector(&prior, &encode_vector(requests.clone(), bad)?).is_err());
            assert!(
                recover_vector(
                    &prior,
                    &encode_vector(requests.into_iter().rev().collect(), delta.clone())?
                )
                .is_err()
            );
        }
        assert_eq!(
            flexbuffers::Reader::get_root(bytes.as_slice())?
                .get_vector()?
                .len(),
            33
        );
        let next = recover_vector(&prior, &bytes)?;
        assert_eq!(
            next.latest("hot")?.unwrap().decimal(),
            (batch * 32 + 31).to_string()
        );
        assert_eq!(next.image, live.image()?);
        assert_eq!(
            next.image,
            State::ingest_logical(&prior.image, &delta.logical)?.image
        );
        prior = next;
    }
    let before = live.image()?;
    let bad = vec![
        (
            "hot".into(),
            Marker {
                viewpoint: "320".into(),
                sha384: hash(&[]),
                blob: vec![],
            },
        ),
        (
            "hot".into(),
            Marker {
                viewpoint: "322".into(),
                sha384: hash(&[]),
                blob: vec![],
            },
        ),
    ];
    assert!(live.commit_ordered(&bad).is_err());
    assert_eq!(live.image()?, before);
    Ok(())
}
