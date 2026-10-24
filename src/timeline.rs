use crate::{diffuse16, event, lexidecimal::Viewpoint};
use anyhow::{Context, Result, ensure};
use num_bigint::BigUint;
use s3::Bucket;
use std::{collections::BTreeMap, future::Future};

#[derive(Default)]
pub struct Basin {
    pub milestone: BigUint,
    pub database: Option<crate::turso::State>,
    pub stopped: bool,
    pub writer: Option<crate::turso::wal::Writer>,
    pub head: Option<String>,
}

impl Basin {
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
        self.freeze_writer()?;
        ensure!(milestone == &self.milestone + 1u8, "Timeline Milestone gap");
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
        self.database = Some(candidate);
        self.milestone = milestone;
        Ok(())
    }
}

pub struct Prepared {
    bytes: Vec<u8>,
    milestone: BigUint,
    parent: Option<String>,
    digest: String,
}
impl Prepared {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn milestone(&self) -> &BigUint {
        &self.milestone
    }
}
impl Basin {
    fn freeze_writer(&mut self) -> Result<()> {
        if let Some(writer) = &self.writer {
            ensure!(
                writer.cursor() == &self.milestone,
                "unpublished database state"
            );
            let state = crate::turso::State::from_image(writer.image()?)?;
            self.database = Some(state);
            self.writer = None;
        }
        Ok(())
    }
    pub fn prepare_wal(&mut self, commands: Vec<event::FlowCommand>) -> Result<Prepared> {
        let milestone = &self.milestone + 1u8;
        diffuse16::key(&milestone)?;
        ensure!(
            self.milestone == 0u8.into() || self.head.is_some(),
            "missing predecessor event digest"
        );
        if self.writer.is_none() {
            let genesis;
            let image = if let Some(state) = &self.database {
                &state.image
            } else {
                genesis = crate::turso::State::genesis()?;
                &genesis.image
            };
            let writer = crate::turso::wal::Writer::open(image)?;
            self.writer = Some(writer);
            self.database = None;
        }
        let delta = self.writer.as_mut().unwrap().prepare(
            &self.milestone,
            self.head.as_deref(),
            &commands,
        )?;
        let bytes = event::encode_wal(commands, delta)?;
        let digest = event::digest(&bytes);
        Ok(Prepared {
            bytes,
            milestone,
            parent: self.head.clone(),
            digest,
        })
    }
    pub async fn publish(&mut self, bucket: &Bucket, prepared: Prepared) -> Result<()> {
        ensure!(
            prepared.milestone == &self.milestone + 1u8 && prepared.parent == self.head,
            "publication prefix mismatch"
        );
        let response = bucket
            .put_object_with_headers(
                diffuse16::key(&prepared.milestone)?,
                &prepared.bytes,
                Some(axum::http::HeaderMap::from_iter([(
                    axum::http::header::IF_NONE_MATCH,
                    axum::http::HeaderValue::from_static("*"),
                )])),
            )
            .await?;
        ensure!(
            (200..300).contains(&response.status_code()),
            "conditional PUT returned HTTP {}",
            response.status_code()
        );
        self.milestone = prepared.milestone;
        self.head = Some(prepared.digest);
        Ok(())
    }
    pub fn apply_entry(&mut self, milestone: BigUint, bytes: &[u8]) -> Result<()> {
        ensure!(milestone == &self.milestone + 1u8, "Timeline Milestone gap");
        match event::decode_entry(bytes)? {
            event::Entry::Legacy(command) => self.apply(milestone, command)?,
            event::Entry::Wal { commands, delta } => {
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
                self.database = Some(next);
                self.writer = None;
                self.milestone = milestone;
            }
        }
        self.head = Some(event::digest(bytes));
        Ok(())
    }
}

// The seed exists. Exponential probes bracket the tail, then binary search
// resolves the last present Milestone. Key order is intentionally irrelevant.
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
    let (_, status) = bucket.head_object(diffuse16::key(milestone)?).await?;
    match status {
        200 => Ok(true),
        404 => Ok(false),
        _ => anyhow::bail!("Timeline HEAD returned HTTP {status}"),
    }
}

async fn replay(bucket: &Bucket, state: &mut Basin, tail: BigUint) -> Result<()> {
    while state.milestone < tail {
        let milestone = &state.milestone + 1u8;
        let response = bucket.get_object(diffuse16::key(&milestone)?).await?;
        ensure!(
            response.status_code() == 200,
            "Timeline GET at {milestone} returned HTTP {}",
            response.status_code()
        );
        state
            .apply_entry(milestone.clone(), response.as_slice())
            .with_context(|| format!("invalid DifferentialEvent at Milestone {milestone}"))?;
    }
    Ok(())
}

pub async fn recover(bucket: &Bucket) -> Result<Basin> {
    let (page, status) = bucket
        .list_page(diffuse16::PREFIX.into(), None, None, None, Some(1))
        .await?;
    ensure!(status == 200, "Timeline LIST returned HTTP {status}");
    let mut state = Basin::default();
    if let Some(object) = page.contents.first() {
        let seed = diffuse16::from_key(&object.key)?;
        ensure!(exists(bucket, &seed).await?, "listed seed is missing");
        let tail = last_existing(seed, |m| async move { exists(bucket, &m).await }).await?;
        replay(bucket, &mut state, tail).await?;
    }
    Ok(state)
}

pub async fn refresh(bucket: &Bucket, state: &mut Basin) -> Result<()> {
    let first = &state.milestone + 1u8;
    if exists(bucket, &first).await? {
        let tail = last_existing(first, |m| async move { exists(bucket, &m).await }).await?;
        replay(bucket, state, tail).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn marker(viewpoint: &str) -> event::Marker {
        use sha2::{Digest, Sha384};
        event::Marker {
            viewpoint: viewpoint.into(),
            sha384: format!("{:x}", Sha384::digest([])),
            blob: vec![],
        }
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
