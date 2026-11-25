//! Immutable, indexed feeds of complete Timeline events.
use crate::{
    envbuf, event,
    flexbuffer::{self, Extension},
    lexidecimal, timeline,
};
use anyhow::{Context, Result, ensure};
use num_bigint::{BigInt, BigUint};
use s3::Bucket;
use serde::Serialize;
use std::{ops::Range, time::Duration};
use tokio::sync::{mpsc, watch};

pub const PREFIX: &str = "kernelspace/basin/analogue/";
pub const COMMAND: &str = "sts/0/databasin/bulkmanifest";
pub const RANGE_HEADER: &str = "x-amz-meta-bulkmanifest-range";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub lowest: BigUint,
    pub highest: BigUint,
}
impl Order {
    pub fn key(&self, start: usize, coordinate: &BigUint) -> Result<String> {
        ensure!(
            self.lowest > 0u8.into() && self.highest > self.lowest,
            "invalid BulkOrder interval"
        );
        ensure!(start >= 16 && start.is_multiple_of(8), "invalid event end");
        let key = format!(
            "{PREFIX}{}/{}/v0/{start}/{coordinate}",
            lexidecimal::encode(&!BigInt::from(self.lowest.clone())),
            lexidecimal::encode(&!BigInt::from(self.highest.clone()))
        );
        ensure!(key.len() <= 1024, "BulkOrder exceeds S3 key limit");
        Ok(key)
    }
    pub fn from_key(key: &str) -> Result<Self> {
        let parts = key
            .strip_prefix(PREFIX)
            .context("invalid Analogue prefix")?
            .split('/')
            .collect::<Vec<_>>();
        ensure!(
            parts.len() == 5 && parts[2] == "v0",
            "invalid BulkOrder key"
        );
        let (low, high) = (parts[0], parts[1]);
        let start = manifest_start(key)?;
        let order = Self {
            lowest: (!lexidecimal::decode(low)?)
                .to_biguint()
                .context("invalid lower bound")?,
            highest: (!lexidecimal::decode(high)?)
                .to_biguint()
                .context("invalid upper bound")?,
        };
        ensure!(
            order.key(start, &key_coordinate(key)?)? == key,
            "noncanonical BulkOrder key"
        );
        Ok(order)
    }
    pub fn covers(&self, milestone: &BigUint) -> bool {
        &self.lowest <= milestone && milestone < &self.highest
    }
}

/// v0 records only the exclusive end of the concatenated event bytes.
pub fn manifest_start(key: &str) -> Result<usize> {
    let (_, suffix) = key.rsplit_once("/v0/").context("missing v0 event end")?;
    let (suffix, _) = suffix.split_once('/').context("missing coordinate")?;
    let start = suffix.parse::<usize>()?;
    ensure!(
        start >= 16 && start.is_multiple_of(8) && start.to_string() == suffix,
        "invalid event end"
    );
    Ok(start)
}

pub fn key_coordinate(key: &str) -> Result<BigUint> {
    let text = key.rsplit('/').next().context("missing coordinate")?;
    let value: BigUint = text.parse()?;
    ensure!(value.to_string() == text, "noncanonical coordinate");
    Ok(value)
}

pub fn seek(milestone: &BigUint) -> String {
    format!(
        "{PREFIX}{}/",
        lexidecimal::encode(&!BigInt::from(milestone.clone()))
    )
}

#[derive(Clone, Debug)]
pub struct Index {
    pub coordinate: BigUint,
    pub lowest: BigUint,
    /// Exclusive event ends, shared by logical coordinates and physical offsets.
    pub ends: Vec<usize>,
}
impl Index {
    pub fn order(&self) -> Order {
        Order {
            lowest: self.lowest.clone(),
            highest: &self.lowest + self.ends.len(),
        }
    }
    pub fn boundary(&self, index: usize) -> usize {
        if index == 0 { 0 } else { self.ends[index - 1] }
    }
    pub fn coordinate_at(&self, milestone: &BigUint) -> Result<BigUint> {
        ensure!(
            milestone >= &self.lowest && milestone <= &self.order().highest,
            "coordinate outside BulkOrder"
        );
        Ok(&self.coordinate + self.boundary(usize::try_from(milestone - &self.lowest)?))
    }
    pub fn range(&self, lowest: &BigUint, highest: &BigUint) -> Result<Range<usize>> {
        ensure!(
            self.order().covers(lowest) && highest > lowest && highest <= &self.order().highest,
            "range outside BulkOrder"
        );
        Ok(self.boundary(usize::try_from(lowest - &self.lowest)?)
            ..self.boundary(usize::try_from(highest - &self.lowest)?))
    }
    pub fn decode(message: &[u8]) -> Result<Self> {
        let tuple = crate::flexbuffer::root(message)?.get_vector()?;
        ensure!(
            tuple.len() == 4
                && flexbuffer::read(tuple.index(0)?)?
                    == Extension::WellKnownSymbol("species".into())
                && tuple.index(1)?.get_str()? == event::NAMESPACE
                && tuple.index(2)?.get_str()? == COMMAND,
            "invalid BulkOrder tuple"
        );
        let query = tuple.index(3)?.get_map()?;
        ensure!(query.len() == 3, "invalid BulkOrder query");
        let Extension::BigInt(lowest) = flexbuffer::read(query.index("lowest")?)? else {
            anyhow::bail!("lowest must be a bigint")
        };
        let lowest = lowest.to_biguint().context("negative lower bound")?;
        ensure!(lowest > 0u8.into(), "Milestones begin at one");
        let Extension::BigInt(coordinate) = flexbuffer::read(query.index("coordinate")?)? else {
            anyhow::bail!("coordinate must be bigint")
        };
        let coordinate = coordinate.to_biguint().context("negative coordinate")?;
        let vector = query.index("ends")?;
        ensure!(
            vector.flexbuffer_type() != flexbuffers::FlexBufferType::VectorUInt,
            "ends must not use the reserved extension type"
        );
        let mut ends = vec![];
        let mut previous = 0;
        for value in vector.get_vector()?.iter() {
            let end = usize::try_from(value.get_i64()?)?;
            ensure!(
                end > previous && end.is_multiple_of(8),
                "invalid BulkOrder ends"
            );
            previous = end;
            ends.push(end);
        }
        ensure!(!ends.is_empty(), "empty BulkOrder ends");
        Ok(Self {
            lowest,
            coordinate,
            ends,
        })
    }
}

#[derive(Serialize)]
struct Query {
    coordinate: Vec<u8>,
    lowest: Vec<u8>,
    ends: Vec<i64>,
}

pub struct Builder {
    index: Index,
    bytes: Vec<u8>,
}
impl Builder {
    pub fn new(lowest: BigUint) -> Result<Self> {
        ensure!(lowest > 0u8.into(), "Milestones begin at one");
        Ok(Self {
            index: Index {
                lowest,
                coordinate: BigUint::default(),
                ends: vec![],
            },
            bytes: vec![],
        })
    }
    pub fn len(&self) -> usize {
        self.bytes.len()
    }
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
    pub fn append(&mut self, milestone: &BigUint, bytes: &[u8]) -> Result<()> {
        ensure!(
            milestone == &self.index.order().highest,
            "noncontiguous BulkOrder append"
        );
        event::envelope(bytes)?;
        event::entry_digest(bytes)?;
        if self.bytes.is_empty() {
            self.index.coordinate = event::coordinate(bytes)?.unwrap_or_default();
        }
        if let Some(coordinate) = event::coordinate(bytes)? {
            ensure!(
                coordinate == &self.index.coordinate + self.index.ends.last().copied().unwrap_or(0),
                "BulkOrder coordinate gap"
            );
        }
        ensure!(
            self.bytes.len().is_multiple_of(1usize << (bytes[3] & 31)),
            "event alignment incompatible with BulkOrder boundary"
        );
        let trimmed = event::trim_retry_margins(bytes)?;
        self.bytes.extend_from_slice(&trimmed);
        self.index.ends.push(self.bytes.len());
        Ok(())
    }
    pub fn finish(mut self) -> Result<(Order, Vec<u8>, Range<usize>)> {
        ensure!(!self.is_empty(), "empty BulkOrder");
        let order = self.index.order();
        let query = Query {
            lowest: flexbuffer::bigint_payload(&self.index.lowest)?,
            coordinate: flexbuffer::bigint_payload(&self.index.coordinate)?,
            ends: self
                .index
                .ends
                .into_iter()
                .map(|end| Ok(i64::try_from(end)?))
                .collect::<Result<_>>()?,
        };
        let message = flexbuffer::command(
            COMMAND,
            &query,
            &[
                ("lowest", &self.index.lowest),
                ("coordinate", &self.index.coordinate),
            ],
        )?;
        let start = self.bytes.len();
        let end = envbuf::append(&mut self.bytes, &message, envbuf::FLEXBUFFERS)?;
        envbuf::append_counter_margin(&mut self.bytes, 0)?;
        Ok((order, self.bytes, start..end))
    }
}

pub fn footer(bytes: &[u8]) -> Result<(Index, Range<usize>)> {
    let mut end = bytes.len();
    while end > 0 {
        let frame = envbuf::before(bytes, end)?;
        if frame.format != envbuf::MARGIN {
            ensure!(
                frame.format == envbuf::FLEXBUFFERS,
                "invalid BulkOrder footer format"
            );
            let index = Index::decode(frame.content)?;
            ensure!(
                index.ends.last() == Some(&frame.start),
                "BulkOrder index does not meet its footer"
            );
            return Ok((index, frame.start..frame.end));
        }
        end = frame.start;
    }
    anyhow::bail!("missing BulkOrder footer")
}

pub fn decode(bytes: &[u8], order: &Order) -> Result<Index> {
    let (index, _) = footer(bytes)?;
    ensure!(index.order() == *order, "BulkOrder key/index mismatch");
    let mut previous = 0;
    for end in &index.ends {
        let event = &bytes[previous..*end];
        envbuf::nested_message(event)?;
        ensure!(
            event::coordinate_length(event)? == event.len(),
            "BulkOrder event has retry margins"
        );
        if let Some(coordinate) = event::coordinate(event)? {
            ensure!(
                coordinate == &index.coordinate + previous,
                "BulkOrder event coordinate mismatch"
            );
        }
        previous = *end;
    }
    Ok(index)
}

pub async fn publish(
    bucket: &Bucket,
    order: &Order,
    bytes: &[u8],
    range: Range<usize>,
    crc32c_base: u32,
) -> Result<()> {
    let coordinate = footer(bytes)?.0.coordinate;
    let checksums = crate::checksum::Run {
        before: crc32c_base,
        after: crate::checksum::append(crc32c_base, &bytes[..range.start]),
    };
    let key = order.key(range.start, &coordinate)?;
    let mut headers = crate::epilogue::conditional_headers();
    headers.insert(
        RANGE_HEADER,
        format!("bytes={}-{}", range.start, range.end - 1).parse()?,
    );
    headers.insert("x-amz-meta-coordinate", coordinate.to_string().parse()?);
    checksums.headers(&mut headers)?;
    let response = crate::sequence::put_feed(bucket, &key, bytes, headers).await?;
    if response.status_code() == 412 {
        let existing = crate::object_read::if_present(bucket)?
            .get_object(&key)
            .await?;
        ensure!(
            existing.status_code() == 200,
            "existing BulkOrder GET failed"
        );
        let validator = existing
            .headers()
            .into_iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("etag"))
            .map(|(_, value)| value)
            .context("existing BulkOrder has no ETag")?;
        ensure!(
            validator != crate::sequence::reference(bucket)?,
            "existing BulkOrder shares the empty validator"
        );
        ensure!(
            footer(existing.as_slice())?.1.start == range.start,
            "BulkManifest range/key mismatch"
        );
        verify_same_events(existing.as_slice(), bytes, order)?;
        if let Some(actual) = crate::checksum::Run::from_headers(&existing.headers())? {
            ensure!(actual == checksums, "conflicting BulkOrder CRC32C");
        }
    } else {
        ensure!(
            response.status_code() == 200,
            "BulkOrder PUT returned HTTP {}",
            response.status_code()
        );
    }
    Ok(())
}

pub fn verify_same_events(actual: &[u8], expected: &[u8], order: &Order) -> Result<()> {
    let a = decode(actual, order)?;
    let b = decode(expected, order)?;
    ensure!(
        a.coordinate == b.coordinate && a.ends == b.ends,
        "conflicting BulkOrder coordinates"
    );
    for i in 0..a.ends.len() {
        ensure!(
            event::entry_digest(&actual[a.boundary(i)..a.ends[i]])?
                == event::entry_digest(&expected[b.boundary(i)..b.ends[i]])?,
            "conflicting BulkOrder event identity"
        );
    }
    Ok(())
}

#[derive(Clone)]
pub struct Config {
    pub target_bytes: usize,
    pub max_age: Duration,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            target_bytes: 5 * 1024 * 1024,
            max_age: Duration::from_secs(30),
        }
    }
}

pub struct DurableEvent {
    pub milestone: BigUint,
    pub bytes: Vec<u8>,
}

async fn resume(bucket: &Bucket, target: &BigUint) -> Result<(BigUint, u32)> {
    let mut crc32c = 0;
    let mut next = BigUint::from(1u8);
    while &next <= target {
        let mut after = Some(seek(&next));
        let mut candidates = vec![];
        loop {
            let (page, status) = bucket
                .list_page(PREFIX.into(), None, None, after.clone(), Some(128))
                .await?;
            ensure!(status == 200, "Analogue resume LIST failed");
            for object in &page.contents {
                ensure!(
                    after.as_ref().is_none_or(|key| object.key > *key),
                    "Analogue LIST did not advance"
                );
                after = Some(object.key.clone());
                if object.size >= 16
                    && let Ok(order) = Order::from_key(&object.key)
                    && order.covers(&next)
                {
                    candidates.push((order, object.key.clone()));
                }
            }
            if !page.is_truncated {
                break;
            }
            ensure!(!page.contents.is_empty(), "truncated empty Analogue LIST");
        }
        candidates.sort_by(|(a, _), (b, _)| b.highest.cmp(&a.highest));
        let mut found = None;
        for (order, key) in candidates {
            let result = async {
                let response = crate::object_read::if_present(bucket)?
                    .get_object(&key)
                    .await?;
                ensure!(response.status_code() == 200, "BulkOrder resume GET failed");
                let index = decode(response.as_slice(), &order)?;
                ensure!(
                    index.coordinate == key_coordinate(&key)?,
                    "BulkOrder coordinate/key mismatch"
                );
                ensure!(
                    footer(response.as_slice())?.1.start == manifest_start(&key)?,
                    "BulkManifest range/key mismatch"
                );
                let high = order.highest.clone().min(target + 1u8);
                let start = index.boundary(usize::try_from(&next - &order.lowest)?);
                if let Some(record) = crate::checksum::Run::from_headers(&response.headers())? {
                    record.verify(&response.as_slice()[..manifest_start(&key)?])?;
                    ensure!(
                        crate::checksum::append(record.before, &response.as_slice()[..start])
                            == crc32c,
                        "BulkOrder CRC32C prefix mismatch"
                    );
                }
                let end = index.boundary(usize::try_from(&high - &order.lowest)?);
                Ok::<_, anyhow::Error>(crate::checksum::append(
                    crc32c,
                    &response.as_slice()[start..end],
                ))
            }
            .await;
            if let Ok(crc) = result {
                found = Some((order.highest, crc));
                break;
            }
        }
        let Some((highest, crc)) = found else {
            break;
        };
        next = highest.min(target + 1u8);
        crc32c = crc;
    }
    Ok((next, crc32c))
}

/// Coalesced durable targets never hold up the publisher. Timeline bytes are the queue.
pub async fn run(
    bucket: Box<Bucket>,
    mut targets: watch::Receiver<timeline::Prefix>,
    config: Config,
    mut events: mpsc::Receiver<DurableEvent>,
) {
    let target = targets.borrow().milestone().clone();
    let (mut next, mut crc32c) = match resume(&bucket, &target).await {
        Ok(next) => next,
        Err(error) => {
            tracing::warn!(%error, "Analogue resume failed; reconstructing from Timeline");
            (1u8.into(), 0)
        }
    };
    let mut cached = std::collections::BTreeMap::new();
    let mut builder: Option<Builder> = None;
    let mut builder_crc32c = 0;
    let mut started = tokio::time::Instant::now();
    let mut pending: Option<(Order, Vec<u8>, Range<usize>, u32)> = None;
    let mut closing = false;
    loop {
        let target = targets.borrow_and_update().milestone().clone();
        while let Ok(event) = events.try_recv() {
            if event.milestone >= next && cached.len() < 2 {
                cached.insert(event.milestone, event.bytes);
            }
        }
        if pending.is_none() && next <= target {
            let result = async {
                let bytes = if let Some(bytes) = cached.remove(&next) {
                    bytes
                } else {
                    let response = crate::object_read::if_present(&bucket)?
                        .get_object(timeline::key(&next)?)
                        .await?;
                    ensure!(
                        response.status_code() == 200,
                        "BulkOrder source GET returned HTTP {}",
                        response.status_code()
                    );
                    response.to_vec()
                };
                if builder.is_none() {
                    builder_crc32c = crc32c;
                    builder = Some(Builder::new(next.clone())?);
                    started = tokio::time::Instant::now();
                }
                builder.as_mut().unwrap().append(&next, &bytes)?;
                crc32c = crate::checksum::event(crc32c, &bytes)?;
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if let Err(error) = result {
                tracing::warn!(%error, milestone=%next, "BulkOrder source will retry");
                if closing || targets.has_changed().is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            next += 1u8;
        }
        metrics::gauge!("basinsync_analogue_buffer_bytes").set(
            builder.as_ref().map_or(0, |b| b.len()) as f64
                + pending.as_ref().map_or(0, |(_, bytes, _, _)| bytes.len()) as f64,
        );
        let due = builder.as_ref().is_some_and(|b| {
            b.len() >= config.target_bytes
                || started.elapsed() >= config.max_age
                || closing && next > target
        });
        if due {
            match builder.take().unwrap().finish() {
                Ok((order, bytes, range)) => pending = Some((order, bytes, range, builder_crc32c)),
                Err(error) => {
                    tracing::error!(%error, "BulkOrder encoding stopped");
                    return;
                }
            }
        }
        if let Some((order, bytes, range, base_crc)) = &pending {
            match crate::observability::measured(
                "publish",
                "analogue",
                publish(&bucket, order, bytes, range.clone(), *base_crc),
            )
            .await
            {
                Ok(()) => {
                    tracing::info!(lowest=%order.lowest, highest=%order.highest, bytes=bytes.len(), "BulkOrder published");
                    metrics::gauge!("basinsync_last_success_timestamp_seconds", "operation"=>"analogue").set(time::OffsetDateTime::now_utc().unix_timestamp() as f64);
                    pending = None;
                }
                Err(error) => {
                    tracing::warn!(%error, "BulkOrder upload will retry");
                    if closing || targets.has_changed().is_err() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            }
        }
        if next <= target {
            continue;
        }
        if closing {
            return;
        }
        if builder.is_some() {
            tokio::select! {
                changed = targets.changed() => closing = changed.is_err(),
                _ = tokio::time::sleep_until(started + config.max_age) => {},
            }
        } else {
            closing = targets.changed().await.is_err();
        }
    }
}
