use crate::{event::Marker, lexidecimal::Viewpoint};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha384};
use std::{
    collections::BTreeMap,
    num::NonZeroUsize,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use turso_core::{
    Buffer, CheckpointMode, Completion, ConnectOpts, Connection, Database, File, IO, IOExt,
    MemoryIO, OpenFlags, OpenOptions, SqliteDialect, StepResult, Value,
    mvcc::persistent_storage::{
        DurableStorage, Storage,
        logical_log::{LOG_HDR_SIZE, LogTxFrameInfo, StreamingLogicalLogReader},
    },
};

pub mod cow;

pub const ID: &str = "default.turso";
pub const VERSION: &str = "0.9.0-pre.1+032f5bb2c7e74107f7ef9b66d576312379000a88";
pub const PAGE_SIZE: usize = 16384;
pub const SCHEMA: &str = "CREATE TABLE basin (id INTEGER PRIMARY KEY CHECK (id = 1), milestone TEXT NOT NULL); CREATE TABLE flows (flow TEXT PRIMARY KEY NOT NULL, viewpoint TEXT NOT NULL); INSERT INTO basin VALUES (1, '0');";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Blob(#[serde(with = "serde_bytes")] pub Vec<u8>);
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogicalFrames {
    pub base: Option<Blob>,
    pub header: Blob,
    pub frames: Vec<Blob>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageFrame {
    pub number: u64,
    pub data: Blob,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhysicalFrames {
    pub before: String,
    pub after: String,
    pub size: u64,
    pub pages: Vec<PageFrame>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delta {
    pub version: String,
    pub logical: LogicalFrames,
    pub physical: PhysicalFrames,
}

#[derive(Debug)]
struct CapturedStorage {
    inner: Arc<dyn DurableStorage>,
    frames: Mutex<Vec<Blob>>,
    #[cfg(test)]
    capture_versions: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    versions: Mutex<Vec<turso_core::mvcc::database::RowVersion>>,
}
impl turso_core::mvcc::persistent_storage::DurableStorage for CapturedStorage {
    fn serialize_row_version(
        &self,
        log_record: &mut turso_core::mvcc::database::LogRecord,
        row_version: &turso_core::mvcc::database::RowVersion,
        portable_extension: Option<&[u8]>,
    ) -> turso_core::Result<()> {
        self.inner
            .serialize_row_version(log_record, row_version, portable_extension)?;
        #[cfg(test)]
        if self.capture_versions.load(Ordering::Relaxed) && row_version.row.id.row_id.is_int_key() {
            self.versions.lock().unwrap().push(row_version.clone());
        }
        Ok(())
    }

    fn serialize_database_header(
        &self,
        log_record: &mut turso_core::mvcc::database::LogRecord,
        header: &turso_core::storage::sqlite3_ondisk::DatabaseHeader,
    ) -> turso_core::Result<()> {
        self.inner.serialize_database_header(log_record, header)
    }

    fn log_tx(
        &self,
        m: turso_core::mvcc::database::LogRecord,
        on_serialization_complete: Option<
            &dyn Fn(turso_core::SharedBufferData, LogTxFrameInfo) -> turso_core::Result<()>,
        >,
    ) -> turso_core::Result<(turso_core::Completion, u64)> {
        let capture = |bytes: turso_core::SharedBufferData, info: LogTxFrameInfo| {
            if let Some(observer) = on_serialization_complete {
                observer(bytes.clone(), info)?;
            }
            let start = if info.logical_start_offset == 0 {
                LOG_HDR_SIZE
            } else {
                0
            };
            self.frames
                .lock()
                .unwrap()
                .push(Blob(bytes.as_slice()[start..].to_vec()));
            Ok(())
        };
        self.inner.log_tx(m, Some(&capture))
    }

    fn sync(
        &self,
        sync_type: turso_core::io::FileSyncType,
    ) -> turso_core::Result<turso_core::Completion> {
        self.inner.sync(sync_type)
    }

    fn update_header(&self) -> turso_core::Result<turso_core::Completion> {
        self.inner.update_header()
    }

    fn truncate(
        &self,
        checkpointed_through_ts: u64,
    ) -> turso_core::Result<(
        turso_core::Completion,
        turso_core::mvcc::persistent_storage::LogicalLogTruncateOutcome,
    )> {
        self.inner.truncate(checkpointed_through_ts)
    }

    fn reset_to_fresh_header(&self) -> turso_core::Result<turso_core::Completion> {
        self.inner.reset_to_fresh_header()
    }

    fn get_logical_log_file(&self) -> Arc<dyn turso_core::File> {
        self.inner.get_logical_log_file()
    }

    fn logical_log_offset(&self) -> u64 {
        self.inner.logical_log_offset()
    }

    fn should_checkpoint(&self) -> bool {
        self.inner.should_checkpoint()
    }

    fn set_checkpoint_threshold(&self, threshold: i64) {
        self.inner.set_checkpoint_threshold(threshold)
    }

    fn checkpoint_threshold(&self) -> i64 {
        self.inner.checkpoint_threshold()
    }

    fn upgrade_header_for_log_tx(
        &self,
        m: &turso_core::mvcc::database::LogRecord,
    ) -> turso_core::Result<Option<turso_core::Completion>> {
        self.inner.upgrade_header_for_log_tx(m)
    }

    fn advance_logical_log_offset_after_success(&self, bytes: u64) -> turso_core::Result<()> {
        self.inner.advance_logical_log_offset_after_success(bytes)
    }

    fn discard_pending_log_write(&self) -> turso_core::Result<()> {
        self.inner.discard_pending_log_write()
    }

    fn restore_logical_log_state_after_recovery(&self, offset: u64, running_crc: u32) {
        self.inner
            .restore_logical_log_state_after_recovery(offset, running_crc)
    }

    fn set_header(&self, header: turso_core::mvcc::persistent_storage::logical_log::LogHeader) {
        self.inner.set_header(header)
    }
}

pub struct State {
    native: Native,
    pub image: Vec<u8>,
}

impl State {
    pub fn genesis() -> Result<Self> {
        let native = Native::open(&[], None)?;
        native.conn.pragma_update("page_size", PAGE_SIZE)?;
        native.conn.pragma_update("journal_mode", "'mvcc'")?;
        native.conn.set_portable_logical_changes_enabled(true);
        native.conn.execute(SCHEMA)?;
        native.checkpoint()?;
        let image = native.image()?;
        ensure!(
            image.len().is_multiple_of(PAGE_SIZE),
            "invalid genesis page size"
        );
        Ok(Self { native, image })
    }

    pub fn from_image(image: Vec<u8>) -> Result<Self> {
        ensure!(
            image.len() >= PAGE_SIZE && image.len().is_multiple_of(PAGE_SIZE),
            "invalid database length"
        );
        ensure!(
            image[16..18] == (PAGE_SIZE as u16).to_be_bytes(),
            "expected 16 KiB pages"
        );
        let native = Native::open(&image, None)?;
        ensure!(
            native.conn.pragma_query("journal_mode")? == vec![vec![Value::build_text("mvcc")]],
            "expected MVCC"
        );
        Ok(Self { native, image })
    }

    pub fn flows(&self) -> Result<BTreeMap<String, Viewpoint>> {
        let mut query = self
            .native
            .conn
            .query("SELECT flow, viewpoint FROM flows ORDER BY flow")?
            .unwrap();
        let mut result = BTreeMap::new();
        loop {
            match query.step()? {
                StepResult::Row => {
                    let row = query.row().unwrap();
                    result.insert(
                        row.get::<String>(0)?,
                        Viewpoint::parse(&row.get::<String>(1)?)?,
                    );
                }
                StepResult::Done => break,
                StepResult::IO => self.native.io.step()?,
                other => anyhow::bail!("unexpected query result: {other:?}"),
            }
        }
        Ok(result)
    }

    pub fn latest(&self, flow: &str) -> Result<Option<Viewpoint>> {
        let mut query = self
            .native
            .conn
            .prepare("SELECT viewpoint FROM flows WHERE flow = ?1")?;
        query.bind_at(
            NonZeroUsize::new(1).unwrap(),
            Value::build_text(flow.to_owned()),
        )?;
        match query.step()? {
            StepResult::Row => {
                let viewpoint = Viewpoint::parse(&query.row().unwrap().get::<String>(0)?)?;
                ensure!(matches!(query.step()?, StepResult::Done), "duplicate Flow");
                Ok(Some(viewpoint))
            }
            StepResult::Done => Ok(None),
            other => anyhow::bail!("unexpected in-memory query result: {other:?}"),
        }
    }

    pub fn milestone(&self) -> Result<String> {
        let mut query = self
            .native
            .conn
            .query("SELECT milestone FROM basin WHERE id = 1")?
            .unwrap();
        ensure!(
            matches!(query.step()?, StepResult::Row),
            "missing Basin cursor"
        );
        let value = query.row().unwrap().get::<String>(0)?;
        ensure!(
            matches!(query.step()?, StepResult::Done),
            "duplicate Basin cursor"
        );
        Ok(value)
    }

    pub fn stage(
        &self,
        milestone: &str,
        markers: &BTreeMap<String, Marker>,
        first: bool,
    ) -> Result<(Self, Delta)> {
        self.stage_observed(milestone, markers, first, &mut |_| {})
    }

    fn stage_observed(
        &self,
        milestone: &str,
        markers: &BTreeMap<String, Marker>,
        first: bool,
        observed: &mut impl FnMut(&str),
    ) -> Result<(Self, Delta)> {
        let native = Native::open(&self.image, None)?;
        observed("open_copy");
        Self::transact(&native, milestone, markers)?;
        observed("transaction");
        self.capture_observed(native, first, observed)
    }

    fn transact(
        native: &Native,
        milestone: &str,
        markers: &BTreeMap<String, Marker>,
    ) -> Result<()> {
        Self::transact_values(
            native,
            milestone,
            markers
                .iter()
                .map(|(flow, marker)| (flow.as_str(), marker.viewpoint.as_str())),
        )
    }

    fn transact_values<'a>(
        native: &Native,
        milestone: &str,
        values: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<()> {
        let conn = &native.conn;
        conn.set_portable_logical_changes_enabled(true);
        conn.execute("BEGIN CONCURRENT")?;
        for (flow, viewpoint) in values {
            let mut stmt = conn.prepare("INSERT INTO flows (flow, viewpoint) VALUES (?1, ?2) ON CONFLICT (flow) DO UPDATE SET viewpoint = excluded.viewpoint")?;
            stmt.bind_at(
                NonZeroUsize::new(1).unwrap(),
                Value::build_text(flow.to_owned()),
            )?;
            stmt.bind_at(
                NonZeroUsize::new(2).unwrap(),
                Value::build_text(viewpoint.to_owned()),
            )?;
            stmt.run_ignore_rows()?;
        }
        let mut stmt = conn.prepare("UPDATE basin SET milestone = ?1 WHERE id = 1")?;
        stmt.bind_at(
            NonZeroUsize::new(1).unwrap(),
            Value::build_text(milestone.to_owned()),
        )?;
        stmt.run_ignore_rows()?;
        drop(stmt);
        conn.execute("COMMIT")?;
        Ok(())
    }

    #[cfg(test)]
    fn capture(&self, native: Native, first: bool) -> Result<(Self, Delta)> {
        self.capture_observed(native, first, &mut |_| {})
    }

    fn capture_observed(
        &self,
        native: Native,
        first: bool,
        observed: &mut impl FnMut(&str),
    ) -> Result<(Self, Delta)> {
        self.capture_policy(native, first, true, observed)
    }

    fn capture_policy(
        &self,
        native: Native,
        first: bool,
        verify: bool,
        observed: &mut impl FnMut(&str),
    ) -> Result<(Self, Delta)> {
        let log = read_file(&*native.io, &*native.storage.get_logical_log_file())?;
        let frames = std::mem::take(&mut *native.storage.frames.lock().unwrap());
        ensure!(
            frames.len() == 1 && log.len() > LOG_HDR_SIZE,
            "expected one captured transaction"
        );
        ensure!(
            log[LOG_HDR_SIZE..] == frames[0].0,
            "captured logical frame differs from log"
        );
        let logical = LogicalFrames {
            base: first.then(|| Blob(self.image.clone())),
            header: Blob(log[..LOG_HDR_SIZE].to_vec()),
            frames,
        };
        validate_log(&native.io, native.storage.get_logical_log_file(), log.len())?;
        observed("logical_capture");
        native.checkpoint()?;
        observed("checkpoint");
        let image = native.image()?;
        observed("image_read");
        let physical = PhysicalFrames::between(&self.image, &image);
        observed("page_diff_hash");
        let delta = Delta {
            version: VERSION.into(),
            logical,
            physical,
        };
        if verify {
            let replayed = delta.ingest_logical(&self.image)?;
            ensure!(
                replayed.image == image,
                "logical replay differs from captured physical state"
            );
        }
        observed("logical_replay_verify");
        Ok((Self { native, image }, delta))
    }

    pub fn ingest_logical(base: &[u8], logical: &LogicalFrames) -> Result<Self> {
        let log = logical.validated_bytes()?;
        let native = Native::open(base, Some(&log))?;
        native.checkpoint()?;
        let image = native.image()?;
        Ok(Self { native, image })
    }
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

    pub fn ingest_logical(&self, before: &[u8]) -> Result<State> {
        self.validate_version()?;
        ensure!(
            hash(before) == self.physical.before,
            "logical delta base mismatch"
        );
        let state = State::ingest_logical(before, &self.logical)?;
        ensure!(
            state.image.len() as u64 == self.physical.size
                && hash(&state.image) == self.physical.after,
            "logical delta result mismatch"
        );
        Ok(state)
    }
}

impl LogicalFrames {
    pub fn validated_bytes(&self) -> Result<Vec<u8>> {
        ensure!(
            self.header.0.len() == LOG_HDR_SIZE && self.frames.len() == 1,
            "invalid logical frame envelope"
        );
        let mut log = self.header.0.clone();
        for frame in &self.frames {
            log.extend_from_slice(&frame.0);
        }
        let io: Arc<dyn IO> = Arc::new(MemoryIO::new());
        let file = io.open_file("validate-log", OpenFlags::default(), false)?;
        write_file(&*io, &*file, &log)?;
        validate_log(&io, file, log.len())?;
        Ok(log)
    }
}

impl PhysicalFrames {
    fn between(before: &[u8], after: &[u8]) -> Self {
        Self {
            before: hash(before),
            after: hash(after),
            size: after.len() as u64,
            pages: after
                .chunks(PAGE_SIZE)
                .enumerate()
                .filter(|&(index, data)| {
                    before.get(index * PAGE_SIZE..(index + 1) * PAGE_SIZE) != Some(data)
                })
                .map(|(index, data)| PageFrame {
                    number: index as u64 + 1,
                    data: Blob(data.to_vec()),
                })
                .collect(),
        }
    }

    pub fn ingest(&self, before: &[u8]) -> Result<Vec<u8>> {
        ensure!(hash(before) == self.before, "physical delta base mismatch");
        let size = usize::try_from(self.size)?;
        ensure!(
            size >= PAGE_SIZE && size.is_multiple_of(PAGE_SIZE),
            "invalid database size"
        );
        ensure!(
            size <= before
                .len()
                .saturating_add(self.pages.len().saturating_mul(PAGE_SIZE)),
            "uncovered database growth"
        );
        let mut after = before.to_vec();
        after.resize(size, 0);
        let mut previous = 0;
        for page in &self.pages {
            ensure!(
                page.number > previous
                    && page.number <= self.size / PAGE_SIZE as u64
                    && page.data.0.len() == PAGE_SIZE,
                "invalid page frame"
            );
            let start = (page.number as usize - 1) * PAGE_SIZE;
            after[start..start + PAGE_SIZE].copy_from_slice(&page.data.0);
            previous = page.number;
        }
        ensure!(hash(&after) == self.after, "physical delta result mismatch");
        Ok(after)
    }
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha384::digest(bytes))
}

struct Native {
    conn: Arc<Connection>,
    io: Arc<dyn IO>,
    storage: Arc<CapturedStorage>,
    path: String,
}
impl Native {
    fn open(image: &[u8], log: Option<&[u8]>) -> Result<Self> {
        Self::open_with_capture(image, log, true)
    }

    fn open_with_capture(image: &[u8], log: Option<&[u8]>, capture: bool) -> Result<Self> {
        Self::open_on(Arc::new(MemoryIO::new()), image, log, capture)
    }

    fn open_on(io: Arc<dyn IO>, image: &[u8], log: Option<&[u8]>, capture: bool) -> Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = format!("basinsync-{}.turso", NEXT.fetch_add(1, Ordering::Relaxed));
        Self::open_at(io, path, image, log, capture)
    }

    fn open_at(
        io: Arc<dyn IO>,
        path: String,
        image: &[u8],
        log: Option<&[u8]>,
        capture: bool,
    ) -> Result<Self> {
        let file = io.open_file(&path, OpenFlags::default(), false)?;
        write_file(&*io, &*file, image)?;
        drop(file);
        let log_file = io.open_file(&format!("{path}-log"), OpenFlags::default(), false)?;
        if let Some(log) = log {
            write_file(&*io, &*log_file, log)?;
        }
        let storage = Arc::new(CapturedStorage {
            inner: Arc::new(Storage::new(log_file, io.clone(), None)),
            frames: Mutex::default(),
            #[cfg(test)]
            capture_versions: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            versions: Mutex::default(),
        });
        storage.set_checkpoint_threshold(-1);
        let db = Database::open(
            io.clone(),
            &path,
            OpenOptions::new(Arc::new(SqliteDialect)).durable_storage(if capture {
                storage.clone() as Arc<dyn DurableStorage>
            } else {
                storage.inner.clone()
            }),
        )?;
        let conn = db.connect(ConnectOpts::new())?;
        Ok(Self {
            conn,
            io,
            storage,
            path,
        })
    }
    fn checkpoint(&self) -> Result<()> {
        self.conn.checkpoint(CheckpointMode::Truncate {
            upper_bound_inclusive: None,
        })?;
        Ok(())
    }
    fn image(&self) -> Result<Vec<u8>> {
        read_file(
            &*self.io,
            &*self.io.open_file(&self.path, OpenFlags::default(), false)?,
        )
    }
}
fn read_file(io: &dyn IO, file: &dyn File) -> Result<Vec<u8>> {
    let size = usize::try_from(file.size()?)?;
    if size == 0 {
        return Ok(vec![]);
    }
    let buffer = Arc::new(Buffer::new_temporary(size));
    let complete = Completion::new_read(buffer.clone(), |_| None);
    io.wait_for_completion(file.pread(0, complete)?)?;
    Ok(buffer.as_slice().to_vec())
}
fn write_file(io: &dyn IO, file: &dyn File, data: &[u8]) -> Result<()> {
    if !data.is_empty() {
        let buffer = Arc::new(Buffer::new_temporary(data.len()));
        buffer.as_mut_slice().copy_from_slice(data);
        io.wait_for_completion(file.pwrite(0, buffer, Completion::new_write(|_| {}))?)?;
    }
    Ok(())
}
fn validate_log(io: &Arc<dyn IO>, file: Arc<dyn File>, size: usize) -> Result<()> {
    let mut reader = StreamingLogicalLogReader::new(file, None);
    reader.read_header(io)?;
    let mut count = 0;
    while let Some(frame) = io.block(|| reader.next_portable_change_frame())? {
        ensure!(
            !frame.payload.is_empty(),
            "portable logical changes missing"
        );
        count += 1;
    }
    ensure!(
        count == 1 && reader.last_valid_offset() == size,
        "incomplete or invalid logical frame"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logical_recovery_reproduces_physical_database() -> Result<()> {
        let state = State::genesis()?;
        let marker = Marker {
            viewpoint: "0".into(),
            sha384: hash(&[]),
            blob: vec![],
        };
        let (next, delta) = state.stage("1", &BTreeMap::from([("a".into(), marker)]), true)?;
        let physical = delta.physical.ingest(&state.image)?;
        assert_eq!(next.image, physical);
        let logical = delta.ingest_logical(&state.image)?;
        assert_eq!(hash(&logical.image), hash(&physical));
        assert_eq!(logical.image, physical);
        assert_eq!(logical.flows()?["a"].decimal(), "0");
        Ok(())
    }
    fn assert_reconstruction(base: &State, next: &State, delta: &Delta) -> Result<()> {
        let bytes = flexbuffers::to_vec(delta)?;
        let decoded = Delta::deserialize(flexbuffers::Reader::get_root(bytes.as_slice())?)?;
        let delta = &decoded;
        assert_eq!(delta.version, VERSION);
        let image = delta.physical.ingest(&base.image)?;
        let logical = delta.ingest_logical(&base.image)?;
        assert_eq!(logical.image, image, "logical and physical images differ");
        assert_eq!(image, next.image);
        let reopened = State::from_image(image)?;
        assert_eq!(reopened.flows()?, next.flows()?);
        assert_eq!(reopened.milestone()?, next.milestone()?);
        let result = reopened.native.conn.pragma_query("integrity_check")?;
        assert_eq!(result, vec![vec![Value::build_text("ok")]]);
        Ok(())
    }

    #[test]
    fn page_splits_overflow_utf8_and_large_counters_reconstruct() -> Result<()> {
        let mut state = State::genesis()?;
        let huge_number = num_bigint::BigUint::from(1u8) << 1024usize;
        let huge = huge_number.to_string();
        for round in 0..4 {
            let markers = (0..300)
                .map(|n| {
                    (
                        format!(
                            "{n:04}/雪/'/{}",
                            "x".repeat(if n == 1 { 20000 } else { 150 })
                        ),
                        Marker {
                            viewpoint: huge.clone(),
                            sha384: hash(&[]),
                            blob: vec![],
                        },
                    )
                })
                .collect();
            let (next, delta) = state.stage(
                &(&huge_number + round as u32).to_string(),
                &markers,
                round == 0,
            )?;
            assert_reconstruction(&state, &next, &delta)?;
            state = next;
        }
        assert!(state.image.len() > PAGE_SIZE * 10);
        Ok(())
    }

    #[test]
    fn deletes_rollback_and_freelist_reuse_reconstruct() -> Result<()> {
        let initial = State::genesis()?;
        let markers = (0..600)
            .map(|n| {
                (
                    format!("{n:04}/{}", "x".repeat(200)),
                    Marker {
                        viewpoint: "0".into(),
                        sha384: hash(&[]),
                        blob: vec![],
                    },
                )
            })
            .collect();
        let (mut state, _) = initial.stage("1", &markers, true)?;
        for sql in [
            "DELETE FROM flows WHERE rowid % 2 = 0; UPDATE basin SET milestone = '2'",
            "UPDATE flows SET viewpoint = '340282366920938463463374607431768211456'; UPDATE basin SET milestone = '3'",
            "DELETE FROM flows; UPDATE basin SET milestone = '4'",
            "INSERT INTO flows VALUES ('reused', '0'); UPDATE basin SET milestone = '5'",
        ] {
            let native = Native::open(&state.image, None)?;
            native.conn.set_portable_logical_changes_enabled(true);
            native.conn.execute(
                "BEGIN CONCURRENT; INSERT INTO flows VALUES ('abandoned', '999'); ROLLBACK",
            )?;
            native.conn.execute("BEGIN CONCURRENT")?;
            native.conn.execute(sql)?;
            native.conn.execute("COMMIT")?;
            let (next, delta) = state.capture(native, false)?;
            assert_reconstruction(&state, &next, &delta)?;
            assert!(next.latest("abandoned")?.is_none());
            state = next;
        }
        assert_eq!(state.flows()?.len(), 1);
        Ok(())
    }

    proptest::proptest! {
        #![proptest_config(proptest::test_runner::Config::with_cases(32))]
        #[test]
        fn randomized_histories_reconstruct_at_every_prefix(ops in proptest::collection::vec(proptest::collection::vec(0u16..80, 1..16), 2..40)) {
            let mut state = State::genesis().unwrap();
            let mut expected: BTreeMap<String, Viewpoint> = BTreeMap::new();
            for (n, batch) in ops.into_iter().enumerate() {
                let mut markers = BTreeMap::new();
                for id in batch {
                    let flow = format!("{id}/\"/雪/{}", "z".repeat(id as usize));
                    let viewpoint = expected.get(&flow).map_or_else(Viewpoint::zero, Viewpoint::next);
                    markers.insert(flow.clone(), Marker { viewpoint: viewpoint.decimal(), sha384: hash(&[]), blob: vec![] });
                }
                for (flow, marker) in &markers { expected.insert(flow.clone(), marker.validate().unwrap()); }
                let (next, delta) = state.stage(&(n+1).to_string(), &markers, n == 0).unwrap();
                assert_reconstruction(&state, &next, &delta).unwrap();
                proptest::prop_assert_eq!(next.flows().unwrap(), expected.clone());
                state = next;
            }
        }
    }

    #[test]
    fn rejects_truncated_corrupt_reordered_and_wrong_base_frames() -> Result<()> {
        let state = State::genesis()?;
        let markers = BTreeMap::from([(
            "flow".into(),
            Marker {
                viewpoint: "0".into(),
                sha384: hash(&[]),
                blob: vec![],
            },
        )]);
        let (_, delta) = state.stage("1", &markers, true)?;
        for length in 0..delta.logical.frames[0].0.len() {
            let mut bad = delta.logical.clone();
            bad.frames[0].0.truncate(length);
            assert!(
                State::ingest_logical(&state.image, &bad).is_err(),
                "accepted logical prefix {length}"
            );
        }
        for position in [0, 10, delta.logical.frames[0].0.len() - 1] {
            let mut bad = delta.logical.clone();
            bad.frames[0].0[position] ^= 1;
            assert!(State::ingest_logical(&state.image, &bad).is_err());
        }
        for position in 0..delta.logical.header.0.len() {
            let mut bad = delta.logical.clone();
            bad.header.0[position] ^= 1;
            assert!(
                bad.validated_bytes().is_err(),
                "accepted corrupt log header byte {position}"
            );
        }
        let mut bad = delta.logical.clone();
        bad.frames.push(bad.frames[0].clone());
        assert!(State::ingest_logical(&state.image, &bad).is_err());
        let mut bad = delta.physical.clone();
        bad.pages.reverse();
        assert!(bad.ingest(&state.image).is_err());
        let mut bad = delta.physical.clone();
        bad.pages[0].data.0[0] ^= 1;
        assert!(bad.ingest(&state.image).is_err());
        assert!(delta.physical.ingest(&[]).is_err());
        assert!(delta.ingest_logical(&[]).is_err());
        let mut bad = delta.clone();
        bad.version = "incompatible".into();
        assert!(
            bad.ingest_logical(&state.image)
                .err()
                .unwrap()
                .to_string()
                .contains("unsupported Turso delta version")
        );
        let mut bad = delta.clone();
        bad.physical.after = "00".repeat(48);
        assert!(bad.ingest_logical(&state.image).is_err());
        let mut bad = delta.physical.clone();
        bad.pages.clear();
        assert!(bad.ingest(&state.image).is_err());
        Ok(())
    }
}

#[cfg(test)]
mod benchmark;

#[cfg(test)]
mod experiments;

pub mod wal;
