use crate::{diffuse16, event, lexidecimal::Viewpoint};
use anyhow::{Context, Result, ensure};
use num_bigint::BigUint;
use s3::Bucket;
use std::{collections::BTreeMap, future::Future};

#[derive(Default)]
pub struct Basin {
    pub milestone: BigUint,
    pub flows: BTreeMap<String, Viewpoint>,
    pub stopped: bool,
}

impl Basin {
    pub fn expected(&self, flow: &str) -> Viewpoint {
        self.flows
            .get(flow)
            .map_or_else(Viewpoint::zero, Viewpoint::next)
    }

    pub fn apply(&mut self, milestone: BigUint, command: event::CommitFlow) -> Result<()> {
        ensure!(milestone == &self.milestone + 1u8, "Timeline Milestone gap");
        let mut updates = Vec::new();
        for (flow, marker) in command.markers {
            let viewpoint = marker.validate()?;
            ensure!(
                viewpoint == self.expected(&flow),
                "Flow {flow:?} Viewpoint gap"
            );
            updates.push((flow, viewpoint));
        }
        for (flow, viewpoint) in updates {
            self.flows.insert(flow, viewpoint);
        }
        self.milestone = milestone;
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
        let command = event::decode(response.as_slice())
            .with_context(|| format!("invalid DifferentialEvent at Milestone {milestone}"))?;
        state.apply(milestone, command)?;
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
    fn replay_applies_commands_atomically_and_preserves_big_counters() {
        let mut state = Basin::default();
        let bad = event::CommitFlow {
            markers: BTreeMap::from([("a".into(), marker("0")), ("b".into(), marker("1"))]),
        };
        assert!(state.apply(1u8.into(), bad).is_err());
        assert!(state.flows.is_empty());
        assert_eq!(state.milestone, 0u8.into());
        let huge = (BigUint::from(1u8) << 128usize) + 1u8;
        state.milestone = huge.clone();
        state
            .flows
            .insert("a".into(), Viewpoint::parse(&huge.to_string()).unwrap());
        let next = (&huge + 1u8).to_string();
        let command = event::CommitFlow {
            markers: BTreeMap::from([("a".into(), marker(&next))]),
        };
        state.apply(&huge + 1u8, command).unwrap();
        assert_eq!(state.flows["a"].decimal(), next);
        assert_eq!(state.milestone, &huge + 1u8);
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
