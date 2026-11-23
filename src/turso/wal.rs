use super::*;
use num_bigint::BigUint;
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
    inner: Arc<dyn IO>,
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
                io: self.inner.clone(),
                recorder: self.recorder.clone(),
            }))
        } else {
            Ok(inner)
        }
    }
    fn remove_file(&self, path: &str) -> turso_core::Result<()> {
        self.inner.remove_file(path)
    }
    fn supports_shared_wal_coordination(&self) -> bool {
        self.inner.supports_shared_wal_coordination()
    }
    fn step(&self) -> turso_core::Result<()> {
        self.inner.step()
    }
    fn file_id(&self, path: &str) -> turso_core::Result<FileId> {
        self.inner.file_id(path)
    }
}
struct WalFile {
    inner: Arc<dyn File>,
    io: Arc<dyn IO>,
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
        self.io.wait_for_completion(completed.clone())?;
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
        self.io.wait_for_completion(completed.clone())?;
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
#[serde(deny_unknown_fields)]
pub struct Frames {
    pub format: String,
    pub base: String,
    pub milestone: String,
    pub parent: Option<String>,
    pub base_sha384: Option<String>,
    pub segments: Vec<Blob>,
}
impl Frames {
    pub(crate) fn pages(&self) -> Result<(usize, BTreeMap<u64, Vec<u8>>)> {
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
            for frame in bytes[32..].as_chunks::<{ PAGE_SIZE + 24 }>().0 {
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
    pub fn ingest(
        &self,
        before: &[u8],
        base: &num_bigint::BigUint,
        parent: Option<&str>,
    ) -> Result<Vec<u8>> {
        self.validate_binding(base, parent)?;
        if let Some(checksum) = &self.base_sha384 {
            ensure!(
                checksum == &hash(before),
                "initial database checksum mismatch"
            );
        } else {
            ensure!(
                base != &num_bigint::BigUint::from(0u8),
                "missing initial database checksum"
            );
        }
        let (size, pages) = self.pages()?;
        ensure!(
            size <= before
                .len()
                .saturating_add(pages.len().saturating_mul(PAGE_SIZE)),
            "uncovered WAL growth"
        );
        let mut image = before.to_vec();
        image.resize(size, 0);
        for (number, data) in pages {
            let start = (number as usize - 1) * PAGE_SIZE;
            ensure!(start + PAGE_SIZE <= size, "page beyond database");
            image[start..start + PAGE_SIZE].copy_from_slice(&data);
        }
        Ok(image)
    }
    pub fn validate_binding(&self, base: &num_bigint::BigUint, parent: Option<&str>) -> Result<()> {
        ensure!(
            self.format == "sqlite-wal/1",
            "unsupported physical frame format"
        );
        ensure!(
            self.base == base.to_string() && self.milestone == (base + 1u8).to_string(),
            "WAL Milestone gap"
        );
        ensure!(
            self.parent.as_deref() == parent,
            "WAL predecessor digest mismatch"
        );
        Ok(())
    }
}

fn checksum(bytes: &[u8], mut s: (u32, u32), little: bool) -> (u32, u32) {
    for words in bytes.as_chunks::<8>().0 {
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
#[serde(deny_unknown_fields)]
pub struct Delta {
    pub version: String,
    pub logical: LogicalFrames,
    pub physical: Frames,
}
impl Delta {
    pub fn validate_version(&self) -> Result<()> {
        ensure!(
            self.version == VERSION,
            "unsupported Turso delta version {:?}; expected {VERSION}",
            self.version
        );
        Ok(())
    }
}

pub(crate) struct Savepoint {
    view: Arc<super::cow::View>,
    bootstrap: Option<Vec<u8>>,
}
pub struct Writer {
    state: State,
    recorder: Arc<Mutex<Recorder>>,
    cursor: BigUint,
    bootstrap: Option<Vec<u8>>,
    store: Option<Arc<super::cow::Store>>,
}
impl Writer {
    pub fn open(image: &[u8]) -> Result<Self> {
        let recorder = Arc::new(Mutex::new(Recorder::default()));
        let io = Arc::new(WalIO {
            inner: Arc::new(MemoryIO::new()),
            recorder: recorder.clone(),
        });
        let native = Native::open_on(io, image, None, true)?;
        let state = State {
            native,
            image: vec![],
        };
        let cursor: BigUint = state.milestone()?.parse()?;
        let bootstrap = if cursor == 0u8.into() {
            Some(image.to_vec())
        } else {
            None
        };
        *recorder.lock().unwrap() = Recorder::default();
        Ok(Self {
            state,
            recorder,
            cursor,
            bootstrap,
            store: None,
        })
    }
    pub fn open_disk(image: &[u8]) -> Result<Self> {
        Self::open_disk_named(image, crate::turso::ID)
    }
    pub(crate) fn open_disk_named(image: &[u8], name: &str) -> Result<Self> {
        let store = super::cow::Store::temporary_named(image, name)?;
        let recorder = Arc::new(Mutex::new(Recorder::default()));
        let io = Arc::new(WalIO {
            inner: store.io(),
            recorder: recorder.clone(),
        });
        let native = Native::open_at(io, store.path().into(), image, None, true)?;
        native.conn.pragma_update("cache_size", -2048)?;
        native.conn.pragma_update("synchronous", "FULL")?;
        let state = State {
            native,
            image: vec![],
        };
        let cursor: BigUint = state.milestone()?.parse()?;
        let bootstrap = (cursor == 0u8.into()).then(|| image.to_vec());
        *recorder.lock().unwrap() = Recorder::default();
        Ok(Self {
            state,
            recorder,
            cursor,
            bootstrap,
            store: Some(store),
        })
    }
    pub(crate) fn bootstrap_pending(&self) -> bool {
        self.bootstrap.is_some()
    }
    pub(crate) fn bootstrap(&mut self, image: &[u8]) {
        self.bootstrap = Some(image.to_vec());
    }
    #[cfg(test)]
    pub(crate) fn fail_checkpoint_after(&self, writes: usize) {
        self.store.as_ref().unwrap().fail_after(writes);
    }
    pub(crate) fn savepoint(&self) -> Result<Savepoint> {
        Ok(Savepoint {
            view: self
                .store
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("savepoint needs disk VFS"))?
                .pin()?,
            bootstrap: self.bootstrap.clone(),
        })
    }
    pub(crate) fn restore(savepoint: Savepoint) -> Result<Self> {
        let mut writer = Self::fork(savepoint.view)?;
        writer.bootstrap = savepoint.bootstrap;
        Ok(writer)
    }
    pub(crate) fn fork(view: Arc<super::cow::View>) -> Result<Self> {
        let store = super::cow::Store::fork(view)?;
        let recorder = Arc::new(Mutex::new(Recorder::default()));
        let io = Arc::new(WalIO {
            inner: store.io(),
            recorder: recorder.clone(),
        });
        let native = Native::connect_at(io, store.path().into(), None, true)?;
        native.conn.pragma_update("cache_size", -2048)?;
        native.conn.pragma_update("synchronous", "FULL")?;
        let state = State {
            native,
            image: vec![],
        };
        let cursor = state.milestone()?.parse()?;
        let bootstrap = if cursor == BigUint::from(0u8) {
            Some(store.pin()?.image()?)
        } else {
            None
        };
        Ok(Self {
            state,
            recorder,
            cursor,
            bootstrap,
            store: Some(store),
        })
    }
    pub(crate) fn transaction(
        &mut self,
        base: &BigUint,
        parent: Option<&str>,
        change: impl FnOnce(&Arc<Connection>) -> Result<()>,
    ) -> Result<Delta> {
        ensure!(&self.cursor == base, "unpublished database transaction");
        let conn = &self.state.native.conn;
        conn.set_portable_logical_changes_enabled(true);
        conn.execute("BEGIN CONCURRENT")?;
        let milestone = base + 1u8;
        let result = (|| {
            change(conn)?;
            conn.execute(format!(
                "UPDATE basin SET milestone='{milestone}' WHERE id=1"
            ))?;
            conn.execute("COMMIT")?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = conn.execute("ROLLBACK");
            return Err(error);
        }
        self.capture(base, parent, milestone)
    }
    pub(crate) fn connection(&self) -> &Arc<Connection> {
        &self.state.native.conn
    }
    pub fn snapshot(&self) -> Result<Option<Arc<super::cow::View>>> {
        self.store.as_ref().map(|s| s.pin()).transpose()
    }
    pub(crate) fn inspect_heap(&self, request: &mut crate::heap::Request) -> Result<()> {
        self.state.inspect_heap(request)
    }
    pub(crate) fn inspect_children(
        &self,
        edges: &std::collections::BTreeSet<String>,
        proofs: &mut crate::heap::Proofs,
    ) -> Result<()> {
        self.state.inspect_children(edges, proofs)
    }
    pub(crate) fn check_children(
        &self,
        edges: &std::collections::BTreeSet<String>,
        proofs: &crate::heap::Proofs,
    ) -> Result<Option<crate::heap::NodeError>> {
        self.state.check_children(edges, proofs)
    }
    pub(crate) fn prepare_promotion(
        &mut self,
        base: &BigUint,
        parent: Option<&str>,
        command: &crate::promotion::Command,
    ) -> Result<Option<Delta>> {
        ensure!(&self.cursor == base, "unpublished database transaction");
        if !self.state.promotion_pending(command)? {
            return Ok(None);
        }
        let milestone = base + 1u8;
        self.state
            .transact_promotion(&milestone.to_string(), command)?;
        Ok(Some(self.capture(base, parent, milestone)?))
    }
    pub fn latest(&self, flow: &str) -> Result<Option<Viewpoint>> {
        self.state.latest(flow)
    }
    pub fn flow_revision(&self, flow: &str) -> Result<Option<uuid::Uuid>> {
        self.state.flow_revision(flow)
    }
    pub fn location(&self, flow: &str, viewpoint: &Viewpoint) -> Result<Option<super::Location>> {
        self.state.location(flow, viewpoint)
    }
    pub fn image(&self) -> Result<Vec<u8>> {
        self.state.native.image()
    }
    pub fn cursor(&self) -> &BigUint {
        &self.cursor
    }
    pub(crate) fn prepare_heap(
        &mut self,
        base: &BigUint,
        parent: Option<&str>,
        request: &crate::heap::Request,
    ) -> Result<(Option<(crate::heap::Command, Delta)>, crate::heap::Outcome)> {
        ensure!(&self.cursor == base, "unpublished database transaction");
        let expected = self
            .latest(&request.flow)?
            .map_or_else(Viewpoint::zero, |v| v.next());
        ensure!(
            request.viewpoint == expected,
            "heap reservation Viewpoint mismatch"
        );
        let (command, outcome) = self.state.plan_heap(request)?;
        let captured = if let Some(command) = command {
            let milestone = base + 1u8;
            self.state.transact_heap(&milestone.to_string(), &command)?;
            Some((command, self.capture(base, parent, milestone)?))
        } else {
            None
        };
        Ok((captured, outcome))
    }
    pub(crate) fn prepare_cleanup(
        &mut self,
        base: &BigUint,
        parent: Option<&str>,
        command: crate::cleanup::Command,
    ) -> Result<Option<(crate::cleanup::Command, Delta)>> {
        ensure!(&self.cursor == base, "unpublished database transaction");
        let Some(command) = self.state.plan_cleanup(command)? else {
            return Ok(None);
        };
        let milestone = base + 1u8;
        self.state
            .transact_cleanup(&milestone.to_string(), &command)?;
        Ok(Some((command, self.capture(base, parent, milestone)?)))
    }
    pub fn prepare(
        &mut self,
        base: &BigUint,
        parent: Option<&str>,
        commands: &[crate::event::FlowCommand],
    ) -> Result<Delta> {
        let chunks = crate::event::FlowChunks::new(commands)?;
        self.prepare_with_ranges(base, parent, commands, chunks.ranges())
    }
    pub(crate) fn prepare_with_ranges(
        &mut self,
        base: &BigUint,
        parent: Option<&str>,
        commands: &[crate::event::FlowCommand],
        ranges: &[crate::event::BlobRange],
    ) -> Result<Delta> {
        ensure!(&self.cursor == base, "unpublished database transaction");
        let mut positions: BTreeMap<&str, Viewpoint> = BTreeMap::new();
        let mut values: BTreeMap<&str, &str> = BTreeMap::new();
        ensure!(!commands.is_empty(), "empty command batch");
        for command in commands {
            ensure!(!command.markers.is_empty(), "empty marker batch");
            for (flow, marker) in &command.markers {
                crate::event::valid_flow(flow)?;
                let previous = match positions.get(flow.as_str()) {
                    Some(v) => Some(v.clone()),
                    None => self.latest(flow)?,
                };
                let viewpoint = marker.validate()?;
                ensure!(
                    viewpoint == previous.map_or_else(Viewpoint::zero, |v| v.next()),
                    "Flow {flow:?} Viewpoint gap"
                );
                positions.insert(flow, viewpoint);
                values.insert(flow, &marker.viewpoint);
            }
        }
        let milestone = base + 1u8;
        State::transact_ranges(
            &self.state.native,
            &milestone.to_string(),
            values,
            ranges,
            commands,
        )?;
        self.capture(base, parent, milestone)
    }
    fn capture(
        &mut self,
        base: &BigUint,
        parent: Option<&str>,
        milestone: BigUint,
    ) -> Result<Delta> {
        ensure!(
            &self.cursor == base && milestone == base + 1u8,
            "capture prefix mismatch"
        );
        let native = &self.state.native;
        let bytes = read_file(&*native.io, &*native.storage.get_logical_log_file())?;
        let frames = std::mem::take(&mut *native.storage.frames.lock().unwrap());
        ensure!(
            frames.len() == 1 && bytes.len() > LOG_HDR_SIZE && frames[0].0 == bytes[LOG_HDR_SIZE..],
            "captured logical transaction mismatch: {} frames, {} payload bytes, {} log bytes",
            frames.len(),
            frames.iter().map(|f| f.0.len()).sum::<usize>(),
            bytes.len()
        );
        let bootstrap = self.bootstrap.take();
        let base_sha384 = bootstrap.as_deref().map(hash);
        let logical = LogicalFrames {
            base: bootstrap.map(Blob),
            header: Blob(bytes[..LOG_HDR_SIZE].to_vec()),
            frames,
        };
        logical.validated_bytes()?;
        native.checkpoint()?;
        if let Some(store) = &self.store {
            store.seal();
        }
        let mut recorder = self.recorder.lock().unwrap();
        if !recorder.current.is_empty() {
            let current = std::mem::take(&mut recorder.current);
            recorder.segments.push(Blob(current));
        }
        let physical = Frames {
            format: "sqlite-wal/1".into(),
            base: base.to_string(),
            milestone: milestone.to_string(),
            parent: parent.map(str::to_owned),
            base_sha384,
            segments: std::mem::take(&mut recorder.segments),
        };
        physical.validate_binding(base, parent)?;
        physical.pages()?;
        self.cursor = milestone;
        Ok(Delta {
            version: VERSION.into(),
            logical,
            physical,
        })
    }
}
