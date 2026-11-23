use crate::{
    event,
    lexidecimal::{self, Viewpoint},
};
use anyhow::{Context, Result, ensure};
use num_bigint::{BigInt, BigUint};
use s3::Bucket;
use std::{collections::BTreeMap, future::Future};

pub const PREFIX: &str = "kernelspace/basin/timeline/";

pub fn key(milestone: &BigUint) -> Result<String> {
    ensure!(
        *milestone != BigUint::from(0u8),
        "Milestone zero has no Timeline object"
    );
    let key = format!(
        "{PREFIX}{}",
        lexidecimal::encode(&!BigInt::from(milestone.clone()))
    );
    ensure!(key.len() <= 1024, "Milestone exceeds S3 key limit");
    Ok(key)
}

pub fn from_key(key: &str) -> Result<BigUint> {
    let encoded = key
        .strip_prefix(PREFIX)
        .context("invalid Timeline prefix")?;
    let milestone = (!lexidecimal::decode(encoded)?)
        .to_biguint()
        .context("Timeline keys must encode complemented positive Milestones")?;
    ensure!(self::key(&milestone)? == key, "invalid Timeline key");
    Ok(milestone)
}

#[derive(Default)]
pub struct Basin {
    pub recovery: crate::recovery::Config,
    pub recovery_stats: crate::recovery::Stats,
    pub milestone: BigUint,
    pub coordinate: BigUint,
    pub crc32c: u32,
    pub database: Option<crate::turso::State>,
    pub kernel_database: Option<crate::turso::State>,
    pub kernel_writer: Option<crate::turso::wal::Writer>,
    pub stopped: bool,
    pub writer: Option<crate::turso::wal::Writer>,
    pub head: Option<String>,
}

impl Basin {
    pub fn flow_revision(&self, flow: &str) -> Result<Option<uuid::Uuid>> {
        if let Some(writer) = &self.writer {
            ensure!(
                writer.cursor() == &self.milestone,
                "unpublished database state"
            );
            writer.flow_revision(flow)
        } else {
            self.database
                .as_ref()
                .map_or(Ok(None), |db| db.flow_revision(flow))
        }
    }

    pub fn latest(&self, flow: &str) -> Result<Option<Viewpoint>> {
        if let Some(writer) = &self.writer {
            ensure!(
                writer.cursor() == &self.milestone,
                "unpublished database state"
            );
            writer.latest(flow)
        } else {
            self.database
                .as_ref()
                .map_or(Ok(None), |db| db.latest(flow))
        }
    }

    pub fn location(
        &self,
        flow: &str,
        viewpoint: &Viewpoint,
    ) -> Result<Option<crate::turso::Location>> {
        if let Some(writer) = &self.writer {
            ensure!(
                writer.cursor() == &self.milestone,
                "unpublished database state"
            );
            writer.location(flow, viewpoint)
        } else {
            self.database
                .as_ref()
                .map_or(Ok(None), |state| state.location(flow, viewpoint))
        }
    }

    pub fn expected(&self, flow: &str) -> Result<Viewpoint> {
        Ok(self
            .latest(flow)?
            .map_or_else(Viewpoint::zero, |v| v.next()))
    }

    fn validate(&self, markers: &BTreeMap<String, event::Marker>) -> Result<()> {
        ensure!(!markers.is_empty(), "empty marker batch");
        for (flow, marker) in markers {
            event::valid_flow(flow)?;
            ensure!(
                marker.validate()? == self.expected(flow)?,
                "Flow {flow:?} Viewpoint gap"
            );
        }
        Ok(())
    }

    pub fn prepare(
        &self,
        markers: BTreeMap<String, event::Marker>,
    ) -> Result<(crate::turso::State, event::CommitFlow)> {
        self.validate(&markers)?;
        let genesis;
        let base = if let Some(database) = &self.database {
            database
        } else {
            genesis = crate::turso::State::genesis()?;
            &genesis
        };
        let milestone = (&self.milestone + 1u8).to_string();
        let (candidate, delta) = base.stage(&milestone, &markers, self.database.is_none())?;
        let command = event::CommitFlow {
            markers,
            deltas: event::Deltas {
                turso: BTreeMap::from([(crate::turso::ID.into(), delta)]),
            },
        };
        Ok((candidate, command))
    }

    pub fn apply(&mut self, milestone: BigUint, command: event::CommitFlow) -> Result<()> {
        let candidate = self.legacy_candidate(&milestone, command)?;
        self.database = Some(candidate);
        self.milestone = milestone;
        Ok(())
    }
    fn legacy_candidate(
        &mut self,
        milestone: &BigUint,
        command: event::CommitFlow,
    ) -> Result<crate::turso::State> {
        self.freeze_writer()?;
        ensure!(
            *milestone == &self.milestone + 1u8,
            "Timeline Milestone gap"
        );
        self.validate(&command.markers)?;
        ensure!(
            command.deltas.turso.len() == 1,
            "expected one Turso database"
        );
        let delta = command
            .deltas
            .turso
            .get(crate::turso::ID)
            .context("missing default.turso delta")?;
        delta.validate_version()?;
        let base = match (&self.database, &delta.logical.base) {
            (None, Some(base)) => {
                let genesis = crate::turso::State::from_image(base.0.clone())?;
                ensure!(
                    genesis.milestone()? == "0" && genesis.flows()?.is_empty(),
                    "invalid initial database state"
                );
                &base.0
            }
            (Some(database), None) => &database.image,
            _ => anyhow::bail!("unexpected genesis image"),
        };
        delta.logical.validated_bytes()?;
        let image = delta.physical.ingest(base)?;
        let candidate = crate::turso::State::from_image(image)?;
        let mut flows = self
            .database
            .as_ref()
            .map(|db| db.flows())
            .transpose()?
            .unwrap_or_default();
        for (flow, marker) in &command.markers {
            flows.insert(flow.clone(), marker.validate()?);
        }
        ensure!(
            candidate.flows()? == flows && candidate.milestone()? == milestone.to_string(),
            "frame state disagrees with command"
        );
        Ok(candidate)
    }
}

pub struct Prepared {
    crc32c_base: u32,
    crc32c: u32,
    bytes: Vec<u8>,
    milestone: BigUint,
    parent: Option<String>,
    digest: String,
    view: Option<std::sync::Arc<crate::turso::cow::View>>,
    kernel_view: Option<std::sync::Arc<crate::turso::cow::View>>,
    activity: BigUint,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prefix {
    milestone: BigUint,
    coordinate: BigUint,
    crc32c: u32,
    digest: Option<String>,
}
impl Prefix {
    pub fn milestone(&self) -> &BigUint {
        &self.milestone
    }
    pub fn coordinate(&self) -> &BigUint {
        &self.coordinate
    }
    pub fn crc32c(&self) -> u32 {
        self.crc32c
    }
    pub fn digest(&self) -> Option<&str> {
        self.digest.as_deref()
    }
}

#[derive(Clone)]
pub struct Snapshot {
    pub(crate) prefix: Prefix,
    pub(crate) view: std::sync::Arc<crate::turso::cow::View>,
    pub(crate) kernel_view: Option<std::sync::Arc<crate::turso::cow::View>>,
    pub(crate) activity: BigUint,
}

pub struct Stager {
    state: Basin,
}
impl Stager {
    pub fn prefix(&self) -> Prefix {
        self.state.prefix()
    }
    pub fn expected(&self, flow: &str) -> Result<Viewpoint> {
        self.state.expected(flow)
    }
    pub fn prepare(&mut self, commands: Vec<event::FlowCommand>) -> Result<Prepared> {
        let prepared = self.state.prepare_wal(commands)?;
        self.state.coordinate += event::coordinate_length(&prepared.bytes)?;
        self.state.milestone = prepared.milestone.clone();
        self.state.crc32c = prepared.crc32c;
        self.state.head = Some(prepared.digest.clone());
        Ok(prepared)
    }
    pub fn poisoned(&self) -> bool {
        self.state.stopped
    }
    fn transaction<T>(&mut self, operation: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        ensure!(!self.state.stopped, "database group is poisoned");
        self.state.enable_vfs()?;
        let prefix = self.state.prefix();
        let primary = self.state.writer.as_ref().unwrap().savepoint()?;
        let kernel = self.state.kernel_writer.as_ref().unwrap().savepoint()?;
        match operation(self) {
            Ok(value) => Ok(value),
            Err(error) => {
                self.state.stopped = true;
                // Reopen all participants before swapping either writer. Fresh sidecars discard
                // local SQL commits, partially checkpointed WALs, and engine caches together.
                let primary = crate::turso::wal::Writer::restore(primary)?;
                let kernel = crate::turso::wal::Writer::restore(kernel)?;
                self.state.writer = Some(primary);
                self.state.kernel_writer = Some(kernel);
                self.state.milestone = prefix.milestone;
                self.state.coordinate = prefix.coordinate;
                self.state.crc32c = prefix.crc32c;
                self.state.head = prefix.digest;
                self.state.stopped = false;
                Err(error)
            }
        }
    }
    pub fn prepare_kernel(
        &mut self,
        operation: crate::kernel::Operation,
    ) -> Result<(Prepared, Viewpoint)> {
        self.transaction(|this| {
            let state = &mut this.state;
            let viewpoint =
                crate::kernel::next(state.kernel_writer.as_ref().unwrap().connection())?;
            let mut kernels = vec![];
            let upstream = &state.milestone + 1u8;
            let companion = state.kernel_writer.as_mut().unwrap().transaction(
                &state.milestone,
                state.head.as_deref(),
                |conn| match &operation {
                    crate::kernel::Operation::Promote(change) => {
                        crate::kernel::promotion::apply(conn, change)
                    }
                    crate::kernel::Operation::Reserve(graph) => {
                        ensure!(
                            graph.milestone.parse::<BigUint>()? <= state.milestone,
                            "backup prefix is not durable"
                        );
                        crate::kernel::reserve(conn, graph, &viewpoint)
                    }
                    crate::kernel::Operation::Commit { command, etags } => {
                        ensure!(
                            command.graph.milestone.parse::<BigUint>()? < upstream,
                            "invalid backup prefix"
                        );
                        crate::kernel::commit(conn, command, etags, &upstream)
                    }
                },
            )?;
            if let crate::kernel::Operation::Commit { command, .. } = operation {
                kernels.push(command);
            }
            let primary = state.writer.as_mut().unwrap().transaction(
                &state.milestone,
                state.head.as_deref(),
                |_| Ok(()),
            )?;
            let bytes = event::FlowChunks::new(&[])?.finish_group(
                BTreeMap::from([
                    (crate::turso::ID.into(), primary),
                    (crate::kernel::ID.into(), companion),
                ]),
                &kernels,
                &state.coordinate,
            )?;
            let prepared = Prepared {
                crc32c_base: state.crc32c,
                crc32c: crate::checksum::event(state.crc32c, &bytes)?,
                digest: event::entry_digest(&bytes)?,
                bytes,
                milestone: upstream,
                parent: state.head.clone(),
                view: state.writer.as_ref().unwrap().snapshot()?,
                kernel_view: state.kernel_writer.as_ref().unwrap().snapshot()?,
                activity: crate::kernel::activity(
                    state.kernel_writer.as_ref().unwrap().connection(),
                )?,
            };
            state.coordinate += event::coordinate_length(prepared.bytes())?;
            state.milestone = prepared.milestone.clone();
            state.crc32c = prepared.crc32c;
            state.head = Some(prepared.digest.clone());
            Ok((prepared, viewpoint))
        })
    }
    pub fn inspect_heap(&mut self, request: &mut crate::heap::Request) -> Result<()> {
        self.state.enable_vfs()?;
        self.state.writer.as_ref().unwrap().inspect_heap(request)
    }
    pub fn inspect_children(
        &mut self,
        edges: &std::collections::BTreeSet<String>,
        proofs: &mut crate::heap::Proofs,
    ) -> Result<()> {
        self.state.enable_vfs()?;
        self.state
            .writer
            .as_ref()
            .unwrap()
            .inspect_children(edges, proofs)
    }
    pub fn check_children(
        &mut self,
        edges: &std::collections::BTreeSet<String>,
        proofs: &crate::heap::Proofs,
    ) -> Result<Option<crate::heap::NodeError>> {
        self.state.enable_vfs()?;
        self.state
            .writer
            .as_ref()
            .unwrap()
            .check_children(edges, proofs)
    }
    pub fn prepare_promotion(
        &mut self,
        command: crate::promotion::Command,
    ) -> Result<Option<Prepared>> {
        self.transaction(|this| this.prepare_promotion_inner(command))
    }
    fn prepare_promotion_inner(
        &mut self,
        command: crate::promotion::Command,
    ) -> Result<Option<Prepared>> {
        self.state.enable_vfs()?;
        let Some(delta) = self.state.writer.as_mut().unwrap().prepare_promotion(
            &self.state.milestone,
            self.state.head.as_deref(),
            &command,
        )?
        else {
            return Ok(None);
        };
        let bytes = self
            .state
            .finish_group(event::FlowChunks::new(&[])?, delta, &[])?;
        let prepared = Prepared {
            crc32c_base: self.state.crc32c,
            crc32c: crate::checksum::event(self.state.crc32c, &bytes)?,
            digest: event::entry_digest(&bytes)?,
            bytes,
            milestone: &self.state.milestone + 1u8,
            parent: self.state.head.clone(),
            view: self.state.writer.as_ref().unwrap().snapshot()?,
            kernel_view: self.state.kernel_writer.as_ref().unwrap().snapshot()?,
            activity: crate::kernel::activity(
                self.state.kernel_writer.as_ref().unwrap().connection(),
            )?,
        };
        self.state.coordinate += event::coordinate_length(&prepared.bytes)?;
        self.state.milestone = prepared.milestone.clone();
        self.state.crc32c = prepared.crc32c;
        self.state.head = Some(prepared.digest.clone());
        Ok(Some(prepared))
    }
    pub fn prepare_heap(
        &mut self,
        request: &crate::heap::Request,
    ) -> Result<(Option<Prepared>, crate::heap::Outcome)> {
        self.transaction(|this| this.prepare_heap_inner(request))
    }
    fn prepare_heap_inner(
        &mut self,
        request: &crate::heap::Request,
    ) -> Result<(Option<Prepared>, crate::heap::Outcome)> {
        self.state.enable_vfs()?;
        let (captured, outcome) = self.state.writer.as_mut().unwrap().prepare_heap(
            &self.state.milestone,
            self.state.head.as_deref(),
            request,
        )?;
        let prepared = if let Some((_command, delta)) = captured {
            let bytes = self
                .state
                .finish_group(event::FlowChunks::new(&[])?, delta, &[])?;
            let prepared = Prepared {
                crc32c_base: self.state.crc32c,
                crc32c: crate::checksum::event(self.state.crc32c, &bytes)?,
                digest: event::entry_digest(&bytes)?,
                bytes,
                milestone: &self.state.milestone + 1u8,
                parent: self.state.head.clone(),
                view: self.state.writer.as_ref().unwrap().snapshot()?,
                kernel_view: self.state.kernel_writer.as_ref().unwrap().snapshot()?,
                activity: crate::kernel::activity(
                    self.state.kernel_writer.as_ref().unwrap().connection(),
                )?,
            };
            self.state.coordinate += event::coordinate_length(&prepared.bytes)?;
            self.state.milestone = prepared.milestone.clone();
            self.state.crc32c = prepared.crc32c;
            self.state.head = Some(prepared.digest.clone());
            Some(prepared)
        } else {
            None
        };
        Ok((prepared, outcome))
    }
    pub fn prepare_cleanup(
        &mut self,
        command: crate::cleanup::Command,
    ) -> Result<Option<Prepared>> {
        self.transaction(|this| this.prepare_cleanup_inner(command))
    }
    fn prepare_cleanup_inner(
        &mut self,
        command: crate::cleanup::Command,
    ) -> Result<Option<Prepared>> {
        self.state.enable_vfs()?;
        let captured = self.state.writer.as_mut().unwrap().prepare_cleanup(
            &self.state.milestone,
            self.state.head.as_deref(),
            command,
        )?;
        let Some((_command, delta)) = captured else {
            return Ok(None);
        };
        let bytes = self
            .state
            .finish_group(event::FlowChunks::new(&[])?, delta, &[])?;
        let prepared = Prepared {
            crc32c_base: self.state.crc32c,
            crc32c: crate::checksum::event(self.state.crc32c, &bytes)?,
            digest: event::entry_digest(&bytes)?,
            bytes,
            milestone: &self.state.milestone + 1u8,
            parent: self.state.head.clone(),
            view: self.state.writer.as_ref().unwrap().snapshot()?,
            kernel_view: self.state.kernel_writer.as_ref().unwrap().snapshot()?,
            activity: crate::kernel::activity(
                self.state.kernel_writer.as_ref().unwrap().connection(),
            )?,
        };
        self.state.coordinate += event::coordinate_length(&prepared.bytes)?;
        self.state.milestone = prepared.milestone.clone();
        self.state.crc32c = prepared.crc32c;
        self.state.head = Some(prepared.digest.clone());
        Ok(Some(prepared))
    }
    pub fn into_settled(self, published: &Prefix) -> Result<Basin> {
        ensure!(
            self.prefix() == *published,
            "unpublished preparation remains"
        );
        Ok(self.state)
    }
}

/// Conditional creation plus an HTTP Range for a framed entry's manifest.
pub fn entry_headers(bytes: &[u8], crc32c_base: u32) -> Result<axum::http::HeaderMap> {
    let mut headers = crate::epilogue::conditional_headers();
    crate::checksum::Run {
        before: crc32c_base,
        after: crate::checksum::event(crc32c_base, bytes)?,
    }
    .headers(&mut headers)?;
    if let Some(coordinate) = event::coordinate(bytes)? {
        headers.insert("x-amz-meta-coordinate", coordinate.to_string().parse()?);
    }
    if let Some(range) = event::manifest_range(bytes)? {
        headers.insert(
            "x-amz-meta-manifest-range",
            format!("bytes={}-{}", range.start, range.end - 1).parse()?,
        );
    }
    Ok(headers)
}

impl Prepared {
    pub fn snapshot(&self) -> Option<Snapshot> {
        self.view.as_ref().map(|view| Snapshot {
            prefix: Prefix {
                milestone: self.milestone.clone(),
                coordinate: event::coordinate(&self.bytes)
                    .expect("prepared coordinate")
                    .expect("coordinate")
                    + event::coordinate_length(&self.bytes).expect("prepared length"),
                crc32c: self.crc32c,
                digest: Some(self.digest.clone()),
            },
            view: view.clone(),
            kernel_view: self.kernel_view.clone(),
            activity: self.activity.clone(),
        })
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn milestone(&self) -> &BigUint {
        &self.milestone
    }
    pub async fn publish(self, bucket: &Bucket, prefix: &Prefix) -> Result<Prefix> {
        Ok(self.publish_with_bytes(bucket, prefix).await?.0)
    }
    pub async fn publish_with_bytes(
        self,
        bucket: &Bucket,
        prefix: &Prefix,
    ) -> Result<(Prefix, Vec<u8>)> {
        check_write_base(bucket, prefix).await?;
        ensure!(
            self.milestone == &prefix.milestone + 1u8
                && self.crc32c_base == prefix.crc32c
                && self.parent == prefix.digest
                && event::coordinate(&self.bytes)? == Some(prefix.coordinate.clone()),
            "publication prefix mismatch"
        );
        let (response, accepted) = crate::sequence::put_feed_returning(
            bucket,
            &key(&self.milestone)?,
            &self.bytes,
            entry_headers(&self.bytes, self.crc32c_base)?,
        )
        .await?;
        ensure!(
            (200..300).contains(&response.status_code()),
            "conditional PUT returned HTTP {}",
            response.status_code()
        );
        let bytes = match accepted {
            std::borrow::Cow::Borrowed(_) => self.bytes,
            std::borrow::Cow::Owned(bytes) => bytes,
        };
        Ok((
            Prefix {
                milestone: self.milestone,
                coordinate: event::coordinate(&bytes)?.context("missing prepared coordinate")?
                    + event::coordinate_length(&bytes)?,
                crc32c: self.crc32c,
                digest: Some(self.digest),
            },
            bytes,
        ))
    }
}
impl Basin {
    pub fn prefix(&self) -> Prefix {
        Prefix {
            milestone: self.milestone.clone(),
            coordinate: self.coordinate.clone(),
            crc32c: self.crc32c,
            digest: self.head.clone(),
        }
    }
    pub fn enable_vfs(&mut self) -> Result<()> {
        if self.writer.is_none() {
            let genesis;
            let image = if let Some(state) = &self.database {
                &state.image
            } else {
                genesis = crate::turso::State::genesis()?;
                &genesis.image
            };
            self.writer = Some(crate::turso::wal::Writer::open_disk(image)?);
            self.database = None;
        }
        if self.kernel_writer.is_none() {
            let bootstrap = self.kernel_database.is_none();
            let state = match self.kernel_database.take() {
                Some(state) => state,
                None => crate::turso::State::kernel_genesis(&self.milestone)?,
            };
            let mut writer =
                crate::turso::wal::Writer::open_disk_named(&state.image, crate::kernel::ID)?;
            if bootstrap {
                writer.bootstrap(&state.image);
            }
            self.kernel_writer = Some(writer);
        }
        Ok(())
    }
    pub fn snapshot(&mut self) -> Result<Option<Snapshot>> {
        if self.milestone == 0u8.into() {
            return Ok(None);
        }
        self.enable_vfs()?;
        ensure!(
            self.writer.as_ref().unwrap().cursor() == &self.milestone,
            "cannot snapshot unpublished database state"
        );
        let kernel_view = self.kernel_writer.as_ref().unwrap().snapshot()?;
        let activity = crate::kernel::activity(self.kernel_writer.as_ref().unwrap().connection())?;
        Ok(self
            .writer
            .as_ref()
            .unwrap()
            .snapshot()?
            .map(|view| Snapshot {
                prefix: self.prefix(),
                view,
                kernel_view,
                activity,
            }))
    }
    pub fn into_stager(self) -> Stager {
        Stager { state: self }
    }
    fn freeze_writer(&mut self) -> Result<()> {
        if let Some(writer) = &self.writer {
            ensure!(
                writer.cursor() == &self.milestone,
                "unpublished database state"
            );
            self.database = if self.milestone == 0u8.into() {
                None
            } else {
                Some(crate::turso::State::from_image(writer.image()?)?)
            };
            self.writer = None;
        }
        if let Some(writer) = &self.kernel_writer {
            ensure!(
                writer.cursor() == &self.milestone,
                "unpublished kernel state"
            );
            self.kernel_database = if writer.bootstrap_pending() {
                None
            } else {
                Some(crate::turso::State::from_image(writer.image()?)?)
            };
            self.kernel_writer = None;
        }
        Ok(())
    }
    pub fn prepare_wal(&mut self, commands: Vec<event::FlowCommand>) -> Result<Prepared> {
        let state = std::mem::take(self);
        let mut stager = Stager { state };
        let result = stager.transaction(|this| this.state.prepare_wal_inner(commands));
        *self = stager.state;
        result
    }
    fn finish_group(
        &mut self,
        chunks: event::FlowChunks,
        delta: crate::turso::wal::Delta,
        kernels: &[crate::kernel::Commit],
    ) -> Result<Vec<u8>> {
        let activity = (&self.milestone + 1u8).to_string();
        let companion = self.kernel_writer.as_mut().unwrap().transaction(
            &self.milestone,
            self.head.as_deref(),
            |conn| {
                conn.execute(format!(
                    "UPDATE kernel_state SET activity='{activity}' WHERE id=1"
                ))?;
                Ok(())
            },
        )?;
        chunks.finish_group(
            BTreeMap::from([
                (crate::turso::ID.into(), delta),
                (crate::kernel::ID.into(), companion),
            ]),
            kernels,
            &self.coordinate,
        )
    }
    fn prepare_wal_inner(&mut self, commands: Vec<event::FlowCommand>) -> Result<Prepared> {
        let milestone = &self.milestone + 1u8;
        key(&milestone)?;
        ensure!(
            self.milestone == 0u8.into() || self.head.is_some(),
            "missing predecessor event digest"
        );
        self.enable_vfs()?;
        let chunks = event::FlowChunks::new(&commands)?;
        let delta = self.writer.as_mut().unwrap().prepare_with_ranges(
            &self.milestone,
            self.head.as_deref(),
            &commands,
            chunks.ranges(),
        )?;
        let bytes = self.finish_group(chunks, delta, &[])?;
        let digest = event::entry_digest(&bytes)?;
        Ok(Prepared {
            crc32c_base: self.crc32c,
            crc32c: crate::checksum::event(self.crc32c, &bytes)?,
            bytes,
            milestone,
            parent: self.head.clone(),
            digest,
            view: self.writer.as_ref().unwrap().snapshot()?,
            kernel_view: self.kernel_writer.as_ref().unwrap().snapshot()?,
            activity: crate::kernel::activity(self.kernel_writer.as_ref().unwrap().connection())?,
        })
    }
    pub async fn publish(&mut self, bucket: &Bucket, prepared: Prepared) -> Result<()> {
        let published = prepared.publish(bucket, &self.prefix()).await?;
        self.crc32c = published.crc32c;
        self.coordinate = published.coordinate;
        self.milestone = published.milestone;
        self.head = published.digest;
        Ok(())
    }
    pub fn apply_entry(&mut self, milestone: BigUint, bytes: &[u8]) -> Result<()> {
        ensure!(milestone == &self.milestone + 1u8, "Timeline Milestone gap");
        if let Some(coordinate) = event::coordinate(bytes)? {
            ensure!(
                coordinate == self.coordinate,
                "Timeline byte coordinate gap"
            );
        }
        let crc32c = crate::checksum::event(self.crc32c, bytes)?;
        let enveloped = bytes.starts_with(b"enV");
        let ranges = event::blob_ranges(bytes)?;
        match event::decode_entry(bytes)? {
            event::Entry::Legacy(command) => {
                let next = self.legacy_candidate(&milestone, command)?;
                validate_locations(&next, &milestone, &ranges, false)?;
                self.database = Some(next);
                self.milestone = milestone;
            }
            event::Entry::Wal {
                commands,
                delta,
                kernel,
                kernels,
            } => {
                delta.validate_version()?;
                delta
                    .physical
                    .validate_binding(&self.milestone, self.head.as_deref())?;
                delta.logical.validated_bytes()?;
                self.freeze_writer()?;
                let base = match (&self.database, &delta.logical.base) {
                    (None, Some(base)) if self.milestone == 0u8.into() => &base.0,
                    (Some(state), None) => &state.image,
                    _ => anyhow::bail!("unexpected initial database image"),
                };
                let image = delta
                    .physical
                    .ingest(base, &self.milestone, self.head.as_deref())?;
                if self.database.is_none() {
                    let genesis = crate::turso::State::from_image(base.clone())?;
                    ensure!(
                        genesis.milestone()? == "0" && genesis.flows()?.is_empty(),
                        "invalid initial database state"
                    );
                }
                let mut expected: BTreeMap<String, Viewpoint> = BTreeMap::new();
                for command in commands {
                    for (flow, marker) in command.markers {
                        let previous = match expected.get(&flow) {
                            Some(v) => Some(v.clone()),
                            None => self.latest(&flow)?,
                        };
                        let viewpoint = marker.validate()?;
                        ensure!(
                            viewpoint == previous.map_or_else(Viewpoint::zero, |v| v.next()),
                            "Flow {flow:?} Viewpoint gap"
                        );
                        expected.insert(flow, viewpoint);
                    }
                }
                let next = crate::turso::State::from_image(image)?;
                ensure!(
                    next.milestone()? == milestone.to_string(),
                    "recovered Milestone mismatch"
                );
                for (flow, vp) in expected {
                    ensure!(
                        next.latest(&flow)? == Some(vp),
                        "recovered Viewpoint mismatch"
                    );
                }
                validate_locations(&next, &milestone, &ranges, enveloped)?;
                let kernel_next = if let Some(delta) = kernel {
                    delta.validate_version()?;
                    delta.logical.validated_bytes()?;
                    let base = match (&self.kernel_database, &delta.logical.base) {
                        (Some(state), None) => &state.image,
                        (Some(state), Some(base)) if state.image == base.0 => &state.image,
                        (None, Some(base)) => &base.0,
                        _ => anyhow::bail!("unexpected kernel bootstrap"),
                    };
                    let image =
                        delta
                            .physical
                            .ingest(base, &self.milestone, self.head.as_deref())?;
                    let candidate = crate::turso::State::from_image(image)?;
                    ensure!(
                        candidate.milestone()? == milestone.to_string(),
                        "kernel Milestone mismatch"
                    );
                    for command in &kernels {
                        let vp = Viewpoint::parse(&command.viewpoint)?;
                        let index = crate::kernel::roots::Index::get(candidate.connection(), &vp)?;
                        ensure!(
                            index
                                == Some(crate::kernel::roots::Index::from_command(
                                    command, &milestone
                                )?),
                            "recovered commitkernel mismatch"
                        );
                    }
                    Some(candidate)
                } else {
                    ensure!(
                        self.kernel_database.is_none() && kernels.is_empty(),
                        "missing companion database delta"
                    );
                    None
                };
                self.database = Some(next);
                self.kernel_database = kernel_next;
                self.writer = None;
                self.milestone = milestone;
            }
        }
        self.crc32c = crc32c;
        self.coordinate += event::coordinate_length(bytes)?;
        self.head = Some(event::entry_digest(bytes)?);
        Ok(())
    }
}

fn validate_locations(
    state: &crate::turso::State,
    milestone: &BigUint,
    ranges: &[event::BlobRange],
    required: bool,
) -> Result<()> {
    for range in ranges {
        let stored = state.location(&range.flow, &range.viewpoint)?;
        if required || stored.is_some() {
            ensure!(
                stored
                    == Some(crate::turso::Location {
                        upstream: milestone.clone(),
                        offset: range.offset,
                        length: range.length,
                        sha384: range.sha384.clone()
                    }),
                "recovered marker location disagrees with encoded blob"
            );
        }
    }
    Ok(())
}

// The seed exists. Exponential probes bracket the tail, then binary search
// resolves the last present Milestone without listing the Timeline.
pub async fn last_existing<F, Fut>(seed: BigUint, mut exists: F) -> Result<BigUint>
where
    F: FnMut(BigUint) -> Fut,
    Fut: Future<Output = Result<bool>>,
{
    let mut low = seed.clone();
    let mut step = BigUint::from(1u8);
    let mut high = &seed + &step;
    while exists(high.clone()).await? {
        low = high;
        step <<= 1usize;
        high = &seed + &step;
    }
    while &low + 1u8 < high {
        let mid = (&low + &high) >> 1usize;
        if exists(mid.clone()).await? {
            low = mid;
        } else {
            high = mid;
        }
    }
    Ok(low)
}

pub async fn exists(bucket: &Bucket, milestone: &BigUint) -> Result<bool> {
    crate::object_read::exists(bucket, &key(milestone)?).await
}

async fn replay(bucket: &Bucket, state: &mut Basin, tail: BigUint) -> Result<()> {
    let config = state.recovery.clone();
    let stats = crate::recovery::replay(bucket, state, tail, &config).await?;
    tracing::debug!(?stats, "Timeline recovery downloads complete");
    state.recovery_stats = stats;
    Ok(())
}

/// Before a conditional publication, read the latest recovery anchor and ensure
/// the locally ingested prefix covers it and has no unseen successor.
pub async fn check_write_base(bucket: &Bucket, prefix: &Prefix) -> Result<()> {
    if let Some(checkpoint) = crate::epilogue::latest_checkpoint(bucket).await? {
        ensure!(
            checkpoint.milestone <= prefix.milestone,
            "Basin backup advanced beyond writer"
        );
        if checkpoint.milestone == prefix.milestone {
            ensure!(
                Some(checkpoint.digest.as_str()) == prefix.digest()
                    && checkpoint.coordinate == prefix.coordinate
                    && checkpoint.crc32c == prefix.crc32c,
                "backup prefix mismatch"
            );
        }
    }
    ensure!(
        !exists(bucket, &(&prefix.milestone + 1u8)).await?,
        "Timeline advanced beyond writer"
    );
    Ok(())
}

pub async fn recover(bucket: &Bucket) -> Result<Basin> {
    recover_with(bucket, crate::recovery::Config::default()).await
}

pub async fn recover_with(bucket: &Bucket, config: crate::recovery::Config) -> Result<Basin> {
    crate::sequence::initialize(bucket).await?;
    let mut state = Basin {
        recovery: config,
        ..Default::default()
    };
    refresh(bucket, &mut state).await?;
    Ok(state)
}

/// Avoid snapshot discovery when a read's settled prefix is still current.
pub async fn refresh_if_advanced(bucket: &Bucket, state: &mut Basin) -> Result<()> {
    let next = &state.milestone + 1u8;
    if exists(bucket, &next).await? {
        refresh(bucket, state).await?;
    }
    Ok(())
}

pub async fn refresh(bucket: &Bucket, state: &mut Basin) -> Result<()> {
    if let Some(checkpoint) = crate::epilogue::latest_checkpoint(bucket).await? {
        if checkpoint.milestone > state.milestone {
            let config = state.recovery.clone();
            *state = checkpoint.load(bucket).await?;
            state.recovery = config;
        } else if checkpoint.milestone == state.milestone {
            ensure!(
                Some(checkpoint.digest.as_str()) == state.head.as_deref()
                    && checkpoint.coordinate == state.coordinate
                    && checkpoint.crc32c == state.crc32c,
                "backup prefix mismatch"
            );
        }
    }

    let tail = if state.milestone == 0u8.into() {
        // Descending keys list the newest Milestone first. Skip replaceable sentinels.
        let mut after = None;
        loop {
            let (page, status) = bucket
                .list_page(PREFIX.into(), None, None, after.clone(), Some(1))
                .await?;
            ensure!(status == 200, "Timeline LIST returned HTTP {status}");
            let Some(object) = page.contents.first() else {
                return Ok(());
            };
            ensure!(
                after.as_ref().is_none_or(|key: &String| object.key > *key),
                "Timeline LIST did not advance"
            );
            let milestone = from_key(&object.key)?;
            if object.size > 0 {
                break milestone;
            }
            after = Some(object.key.clone());
        }
    } else {
        // A Basin Epilogue supplies the seed; no Timeline listing is needed.
        last_existing(state.milestone.clone(), |m| async move {
            exists(bucket, &m).await
        })
        .await?
    };
    replay(bucket, state, tail).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        keys: Vec<(String, String)>,
        invalid_keys: Vec<String>,
    }

    /// Key vectors shared with the TypeScript client.
    #[test]
    fn shared_key_vectors() -> Result<()> {
        let vectors: Vectors =
            serde_json::from_str(include_str!("../tests/vectors/timeline.json"))?;
        for (milestone, expected) in &vectors.keys {
            let milestone: BigUint = milestone.parse()?;
            assert_eq!(&key(&milestone)?, expected);
            assert_eq!(from_key(expected)?, milestone);
        }
        for bad in &vectors.invalid_keys {
            assert!(from_key(bad).is_err(), "{bad}");
        }
        assert!(key(&0u8.into()).is_err());
        assert!(key(&(BigUint::from(1u8) << 4096usize)).is_err());
        Ok(())
    }

    proptest! {
        #[test]
        fn arbitrary_precision_keys_roundtrip_and_reverse_order(
            a in prop::collection::vec(any::<u8>(), 0..256),
            b in prop::collection::vec(any::<u8>(), 0..256)
        ) {
            let a = BigUint::from_bytes_be(&a) + 1u8;
            let b = BigUint::from_bytes_be(&b) + 1u8;
            prop_assert_eq!(from_key(&key(&a).unwrap()).unwrap(), a.clone());
            prop_assert_eq!(key(&a).unwrap().cmp(&key(&b).unwrap()), b.cmp(&a));
        }
    }
    fn marker(viewpoint: &str) -> event::Marker {
        use sha2::{Digest, Sha384};
        event::Marker {
            context: Default::default(),
            edges: Default::default(),
            verified: Default::default(),
            viewpoint: viewpoint.into(),
            sha384: format!("{:x}", Sha384::digest([])),
            blob: vec![],
        }
    }

    #[test]
    fn snapshots_reject_unpublished_preparation() -> Result<()> {
        let mut basin = Basin::default();
        let first = basin.prepare_wal(vec![event::FlowCommand {
            markers: BTreeMap::from([("flow".into(), marker("0"))]),
        }])?;
        basin.milestone = first.milestone.clone();
        basin.head = Some(first.digest.clone());
        assert!(basin.snapshot()?.is_some());
        let _unpublished = basin.prepare_wal(vec![event::FlowCommand {
            markers: BTreeMap::from([("flow".into(), marker("1"))]),
        }])?;
        assert!(basin.snapshot().is_err());
        Ok(())
    }

    #[test]
    fn pinned_backup_prefixes_recover_the_same_physical_state_as_genesis_replay() -> Result<()> {
        let mut producer = Basin::default().into_stager();
        let mut full = Basin::default();
        let mut entries = Vec::new();
        let mut checkpoints = Vec::new();
        for n in 0..48u32 {
            let commands = (0..24)
                .map(|i| event::FlowCommand {
                    markers: BTreeMap::from([(
                        format!("flow-{i}-{}", "x".repeat(140)),
                        marker(&n.to_string()),
                    )]),
                })
                .collect();
            let prepared = producer.prepare(commands)?;
            full.apply_entry((n + 1).into(), prepared.bytes())?;
            let snapshot = prepared.snapshot().unwrap();
            if [0, 4, 16, 32, 47].contains(&n) {
                checkpoints.push(snapshot.clone());
            }
            assert_eq!(
                snapshot.view.image()?,
                full.database.as_ref().unwrap().image
            );
            entries.push(prepared.bytes().to_vec());
        }
        // Pins outlive many more checkpoints, with page growth and repeated updates.
        for snapshot in checkpoints {
            let image = snapshot.view.image()?;
            let (file, digest) = snapshot.view.export()?;
            assert_eq!(std::fs::read(file.path())?, image);
            assert_eq!(digest, event::digest(&image));
            let mut recovered = Basin {
                milestone: snapshot.prefix.milestone.clone(),
                coordinate: snapshot.prefix.coordinate.clone(),
                crc32c: snapshot.prefix.crc32c,
                head: snapshot.prefix.digest.clone(),
                database: Some(crate::turso::State::from_image(image)?),
                kernel_database: Some(crate::turso::State::from_image(
                    snapshot.kernel_view.as_ref().unwrap().image()?,
                )?),
                ..Default::default()
            };
            let start: usize = recovered.milestone.to_string().parse()?;
            for (i, bytes) in entries.iter().enumerate().skip(start) {
                recovered.apply_entry((i + 1).into(), bytes)?;
            }
            assert_eq!(recovered.prefix(), full.prefix());
            assert_eq!(
                recovered.database.as_ref().unwrap().image,
                full.database.as_ref().unwrap().image
            );
        }
        Ok(())
    }

    #[test]
    fn staged_batches_link_before_publication_and_settle_only_at_the_same_prefix() -> Result<()> {
        let committed = Basin::default().prefix();
        let mut stager = Basin::default().into_stager();
        let first = stager.prepare(vec![event::FlowCommand {
            markers: BTreeMap::from([("flow".into(), marker("0"))]),
        }])?;
        assert_eq!(stager.expected("flow")?, Viewpoint::parse("1")?);
        let second = stager.prepare(vec![event::FlowCommand {
            markers: BTreeMap::from([("flow".into(), marker("1"))]),
        }])?;
        assert_eq!(second.parent, Some(event::entry_digest(first.bytes())?));
        assert_eq!(second.milestone(), &BigUint::from(2u8));
        let mut recovered = Basin::default();
        recovered.apply_entry(1u8.into(), first.bytes())?;
        assert_ne!(stager.prefix(), recovered.prefix());
        recovered.apply_entry(2u8.into(), second.bytes())?;
        let settled = stager.into_settled(&recovered.prefix())?;
        assert_eq!(settled.latest("flow")?, Some(Viewpoint::parse("1")?));
        assert!(settled.into_stager().into_settled(&committed).is_err());
        Ok(())
    }

    #[test]
    fn replay_applies_frames_atomically_and_preserves_big_counters() -> Result<()> {
        let mut state = Basin::default();
        assert!(
            state
                .prepare(BTreeMap::from([
                    ("a".into(), marker("0")),
                    ("b".into(), marker("1"))
                ]))
                .is_err()
        );
        assert!(state.database.is_none());
        let (_, command) = state.prepare(BTreeMap::from([("a".into(), marker("0"))]))?;
        let mut incompatible = command.clone();
        incompatible
            .deltas
            .turso
            .get_mut(crate::turso::ID)
            .unwrap()
            .version = "incompatible".into();
        assert!(
            state
                .apply(1u8.into(), incompatible)
                .unwrap_err()
                .to_string()
                .contains("unsupported Turso delta version")
        );
        assert!(state.database.is_none());
        assert_eq!(state.milestone, 0u8.into());
        let mut bad = command.clone();
        bad.deltas
            .turso
            .get_mut(crate::turso::ID)
            .unwrap()
            .physical
            .pages[0]
            .data
            .0[0] ^= 1;
        assert!(state.apply(1u8.into(), bad).is_err());
        assert!(state.database.is_none());
        state.apply(1u8.into(), command)?;
        assert_eq!(state.latest("a")?.unwrap().decimal(), "0");
        assert_eq!(state.milestone, 1u8.into());
        Ok(())
    }

    #[tokio::test]
    async fn searches_from_every_seed_and_beyond_machine_precision() {
        for tail in [1u32, 2, 15, 16, 17, 255, 256, 1025] {
            for seed in [1, tail / 2 + 1, tail] {
                let result = last_existing(seed.into(), |m| async move { Ok(m <= tail.into()) })
                    .await
                    .unwrap();
                assert_eq!(result, tail.into());
            }
        }
        let tail = (BigUint::from(1u8) << 1024usize) + 123u8;
        let result = last_existing(&tail - 99u8, |m| {
            let tail = tail.clone();
            async move { Ok(m <= tail) }
        })
        .await
        .unwrap();
        assert_eq!(result, tail);
        assert!(
            last_existing(1u8.into(), |_| async {
                anyhow::bail!("storage unavailable")
            })
            .await
            .is_err()
        );
    }
}

#[cfg(test)]
mod group_tests {
    use super::*;
    fn command(viewpoint: &str) -> event::FlowCommand {
        event::FlowCommand {
            markers: BTreeMap::from([(
                "group".into(),
                event::Marker {
                    context: Default::default(),
                    edges: Default::default(),
                    verified: Default::default(),
                    viewpoint: viewpoint.into(),
                    blob: vec![42],
                    sha384: event::digest(&[42]),
                },
            )]),
        }
    }
    #[test]
    fn partial_local_commits_restore_every_database_without_object_storage() -> Result<()> {
        for (phase, reverse) in (0..4).flat_map(|phase| [(phase, false), (phase, true)]) {
            let mut stager = Basin::default().into_stager();
            let first = stager.prepare(vec![command("0")])?;
            let prefix = stager.prefix();
            let primary = stager.state.writer.as_ref().unwrap().snapshot()?.unwrap();
            let kernel = stager
                .state
                .kernel_writer
                .as_ref()
                .unwrap()
                .snapshot()?
                .unwrap();
            let a = primary.image()?;
            let b = kernel.image()?;
            let failure: Result<()> = stager.transaction(|this| {
                let s = &mut this.state;
                let (first, second) = if reverse {
                    (
                        s.kernel_writer.as_mut().unwrap(),
                        s.writer.as_mut().unwrap(),
                    )
                } else {
                    (
                        s.writer.as_mut().unwrap(),
                        s.kernel_writer.as_mut().unwrap(),
                    )
                };
                if phase == 0 {
                    first.transaction(&s.milestone, s.head.as_deref(), |conn| {
                        conn.execute("UPDATE basin SET milestone='2'; COMMIT")?;
                        anyhow::bail!("after primary COMMIT, before checkpoint")
                    })?;
                } else {
                    first.transaction(&s.milestone, s.head.as_deref(), |_| Ok(()))?;
                    second.transaction(&s.milestone, s.head.as_deref(), |conn| {
                        if phase == 1 {
                            anyhow::bail!("second transaction rolls back");
                        }
                        if phase == 2 {
                            conn.execute("UPDATE basin SET milestone='2'; COMMIT")?;
                            anyhow::bail!("after second COMMIT, before checkpoint");
                        }
                        Ok(())
                    })?;
                }
                anyhow::bail!("after both checkpoints")
            });
            assert!(failure.is_err());
            assert!(!stager.poisoned());
            assert_eq!(stager.prefix(), prefix);
            assert_eq!(stager.state.writer.as_ref().unwrap().image()?, a);
            assert_eq!(stager.state.kernel_writer.as_ref().unwrap().image()?, b);
            assert_eq!(primary.image()?, a);
            assert_eq!(kernel.image()?, b);
            // The earlier prepared group is preserved; the rejected group consumes no position.
            let second = stager.prepare(vec![command("1")])?;
            let mut recovered = Basin::default();
            recovered.apply_entry(1u8.into(), first.bytes())?;
            recovered.apply_entry(2u8.into(), second.bytes())?;
            assert_eq!(recovered.latest("group")?.unwrap().decimal(), "1");
            assert_eq!(
                recovered.kernel_database.as_ref().unwrap().image,
                stager.state.kernel_writer.as_ref().unwrap().image()?
            );
        }
        Ok(())
    }
    #[test]
    fn checkpoint_io_failure_restores_the_pair_and_reopens_clean_sidecars() -> Result<()> {
        let mut stager = Basin::default().into_stager();
        stager.prepare(vec![command("0")])?;
        let prefix = stager.prefix();
        let before = stager.state.writer.as_ref().unwrap().image()?;
        let companion = stager.state.kernel_writer.as_ref().unwrap().image()?;
        let failure:Result<()>=stager.transaction(|this| {
            let state=&mut this.state;
            state.writer.as_ref().unwrap().fail_checkpoint_after(1);
            state.writer.as_mut().unwrap().transaction(&state.milestone,state.head.as_deref(),|conn|{
                for n in 0..500 {conn.execute(format!("INSERT INTO flows VALUES ('growth-{n}-{}','1','00000000-0000-4000-8000-000000000000')","x".repeat(128)))?;}
                Ok(())
            })?;
            Ok(())
        });
        assert!(failure.is_err());
        assert_eq!(stager.prefix(), prefix);
        assert!(!stager.poisoned());
        assert_eq!(stager.state.writer.as_ref().unwrap().image()?, before);
        assert_eq!(
            stager.state.kernel_writer.as_ref().unwrap().image()?,
            companion
        );
        stager.prepare(vec![command("1")])?;
        Ok(())
    }
    #[test]
    fn an_empty_live_observer_can_adopt_the_first_database_group() -> Result<()> {
        let mut observer = Basin::default();
        observer.enable_vfs()?;
        let first = Basin::default().into_stager().prepare(vec![command("0")])?;
        observer.apply_entry(1u8.into(), first.bytes())?;
        assert_eq!(observer.latest("group")?.unwrap().decimal(), "0");
        assert_eq!(observer.kernel_database.as_ref().unwrap().milestone()?, "1");
        Ok(())
    }
    #[test]
    fn replay_validates_the_group_before_publishing_either_candidate() -> Result<()> {
        let mut stager = Basin::default().into_stager();
        let first = stager.prepare(vec![command("0")])?;
        let second = stager.prepare(vec![command("1")])?;
        let mut state = Basin::default();
        state.apply_entry(1u8.into(), first.bytes())?;
        let prefix = state.prefix();
        let image = state.database.as_ref().unwrap().image.clone();
        let event::Entry::Wal {
            commands,
            delta,
            kernel: Some(mut kernel),
            ..
        } = event::decode_entry(second.bytes())?
        else {
            panic!()
        };
        kernel.version = "invalid".into();
        let bad = event::FlowChunks::new(&commands)?.finish_group(
            BTreeMap::from([
                (crate::turso::ID.into(), *delta),
                (crate::kernel::ID.into(), *kernel),
            ]),
            &[],
            &prefix.coordinate,
        )?;
        assert!(state.apply_entry(2u8.into(), &bad).is_err());
        assert_eq!(state.prefix(), prefix);
        assert_eq!(state.database.as_ref().unwrap().image, image);
        state.apply_entry(2u8.into(), second.bytes())?;
        Ok(())
    }
    #[test]
    fn kernel_reservations_commits_and_both_change_feeds_recover() -> Result<()> {
        let mut stager = Basin::default().into_stager();
        let first = stager.prepare(vec![command("0")])?;
        let snapshot = first.snapshot().unwrap();
        let graph = crate::kernel::Graph::new(
            &snapshot.prefix,
            BTreeMap::from([
                (
                    crate::turso::ID.into(),
                    crate::kernel::Node::new(
                        snapshot.view.image()?.len() as u64,
                        event::digest(&snapshot.view.image()?),
                    ),
                ),
                (
                    crate::kernel::ID.into(),
                    crate::kernel::Node::new(
                        snapshot.kernel_view.as_ref().unwrap().image()?.len() as u64,
                        event::digest(&snapshot.kernel_view.as_ref().unwrap().image()?),
                    ),
                ),
            ]),
        )?;
        let (reserved, vp) =
            stager.prepare_kernel(crate::kernel::Operation::Reserve(graph.clone()))?;
        let command = crate::kernel::Commit {
            viewpoint: vp.decimal(),
            graph: graph.clone(),
        };
        let before = stager.prefix();
        assert!(
            stager
                .prepare_kernel(crate::kernel::Operation::Commit {
                    command: command.clone(),
                    etags: Default::default()
                })
                .is_err()
        );
        assert_eq!(stager.prefix(), before);
        let etags = graph
            .databases
            .values()
            .map(|n| (n.id.clone(), "verified".into()))
            .collect();
        let (committed, _) =
            stager.prepare_kernel(crate::kernel::Operation::Commit { command, etags })?;
        assert_eq!(
            committed.snapshot().unwrap().activity,
            snapshot.activity,
            "backup bookkeeping must not trigger itself"
        );
        let mut recovered = Basin::default();
        for (i, event) in [&first, &reserved, &committed].into_iter().enumerate() {
            let event::Entry::Wal {
                delta,
                kernel: Some(kernel),
                ..
            } = event::decode_entry(event.bytes())?
            else {
                panic!()
            };
            for (id, delta) in [(crate::turso::ID, delta), (crate::kernel::ID, kernel)] {
                let base = if i == 0 {
                    delta.logical.base.as_ref().unwrap().0.clone()
                } else if id == crate::turso::ID {
                    recovered.database.as_ref().unwrap().image.clone()
                } else {
                    recovered.kernel_database.as_ref().unwrap().image.clone()
                };
                let logical = crate::turso::State::ingest_logical(&base, &delta.logical)?;
                let physical = delta.physical.ingest(
                    &base,
                    &recovered.milestone,
                    recovered.head.as_deref(),
                )?;
                assert_eq!(
                    logical.image, physical,
                    "{id}: logical and physical replay diverged"
                );
            }
            recovered.apply_entry((i as u8 + 1).into(), event.bytes())?;
        }
        assert_eq!(
            recovered.kernel_database.as_ref().unwrap().image,
            stager.state.kernel_writer.as_ref().unwrap().image()?
        );
        let commits =
            crate::kernel::committed(&committed.snapshot().unwrap().kernel_view.unwrap())?;
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].viewpoint.decimal(), "0");
        let prefix = stager.prefix();
        assert!(
            stager
                .prepare_kernel(crate::kernel::Operation::Reserve(graph))
                .is_err(),
            "a delayed worker must not publish a non-advancing backup at a newer Viewpoint"
        );
        assert_eq!(stager.prefix(), prefix);
        Ok(())
    }
}
