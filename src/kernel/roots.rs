//! Local indexes and disposable memory caching; root messages live in S3.
use super::*;
use std::{collections::VecDeque, sync::Arc};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Index {
    pub viewpoint: Viewpoint,
    pub upstream: BigUint,
    pub covered: BigUint,
    pub sha384: String,
}
impl Index {
    pub fn from_command(command: &Commit, upstream: &BigUint) -> Result<Self> {
        let result = Self {
            viewpoint: Viewpoint::parse(&command.viewpoint)?,
            upstream: upstream.clone(),
            covered: command.graph.milestone.parse()?,
            sha384: event::digest(&command.blob),
        };
        result.validate()?;
        Ok(result)
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            self.covered > 0u8.into() && self.covered < self.upstream,
            "invalid kernel root prefix"
        );
        ensure!(
            self.sha384.len() == 96
                && self
                    .sha384
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid kernel root checksum"
        );
        Ok(())
    }
    pub fn from_row(row: &turso_core::Row) -> Result<Self> {
        let integer = |n| -> Result<BigUint> {
            crate::lexidecimal::decode(&row.get::<String>(n)?)?
                .to_biguint()
                .context("negative kernel index")
        };
        let result = Self {
            viewpoint: Viewpoint::parse(&integer(0)?.to_string())?,
            upstream: integer(1)?,
            covered: integer(2)?,
            sha384: row.get::<String>(3)?,
        };
        result.validate()?;
        Ok(result)
    }
    pub fn get(conn: &Arc<Connection>, viewpoint: &Viewpoint) -> Result<Option<Self>> {
        let mut result = None;
        turso::rows(
            conn,
            &format!(
                "SELECT viewpoint,upstream,covered,sha384 FROM kernel_commits WHERE viewpoint={}",
                q(&viewpoint.lexidecimal())
            ),
            |row| {
                result = Some(Self::from_row(row)?);
                Ok(())
            },
        )?;
        Ok(result)
    }
    pub fn graph(&self, blob: &[u8]) -> Result<Graph> {
        self.validate()?;
        ensure!(
            event::digest(blob) == self.sha384,
            "kernel root checksum mismatch"
        );
        let graph = Graph::decode(blob)?;
        ensure!(
            graph.milestone == self.covered.to_string(),
            "kernel root covered prefix mismatch"
        );
        Ok(graph)
    }
    fn in_event(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        let event::Entry::Wal { kernels, .. } = event::decode_entry(bytes)? else {
            anyhow::bail!("kernel root requires commitkernel");
        };
        let mut found = kernels
            .into_iter()
            .filter(|c| c.viewpoint == self.viewpoint.decimal());
        let command = found.next().context("missing commitkernel")?;
        ensure!(found.next().is_none(), "duplicate commitkernel");
        ensure!(
            Self::from_command(&command, &self.upstream)? == *self,
            "commitkernel index mismatch"
        );
        Ok(command.blob)
    }
}

const CAPACITY: usize = 64;
const BYTE_LIMIT: usize = 1024 * 1024;
#[derive(Default)]
pub(crate) struct Cache {
    messages: BTreeMap<String, Vec<u8>>,
    order: VecDeque<String>,
    bytes: usize,
}
impl Cache {
    pub fn remember(&mut self, blob: Vec<u8>) {
        let digest = event::digest(&blob);
        if blob.len() > BYTE_LIMIT || self.messages.contains_key(&digest) {
            return;
        }
        while self.messages.len() >= CAPACITY || self.bytes + blob.len() > BYTE_LIMIT {
            let oldest = self.order.pop_front().expect("nonempty root cache");
            self.bytes -= self.messages.remove(&oldest).unwrap().len();
        }
        self.bytes += blob.len();
        self.order.push_back(digest.clone());
        self.messages.insert(digest, blob);
    }
    pub async fn load(&mut self, bucket: &s3::Bucket, index: &Index) -> Result<(Commit, Vec<u8>)> {
        let blob = match self.messages.get(&index.sha384) {
            Some(blob) => blob.clone(),
            None => {
                let reader = crate::object_read::if_present(bucket)?;
                // Prefer a stored marker: its source Timeline event may already be evicted.
                let marker = reader.get_object(index.viewpoint.key()?).await?;
                let blob = match marker.status_code() {
                    200 if marker.as_slice().len() >= 16 => {
                        let blob = crate::envbuf::message(marker.as_slice())?.to_vec();
                        let graph = index.graph(&blob)?;
                        graph
                            .checkpoint(index.viewpoint.clone(), &blob)?
                            .verify_headers(&marker.headers())?;
                        blob
                    }
                    200 | 404 | 412 => {
                        if marker.status_code() == 200 {
                            ensure!(
                                marker.as_slice().is_empty()
                                    || marker.as_slice() == crate::sequence::tombstone(bucket)?,
                                "invalid kernel marker tombstone"
                            );
                        }
                        let event = reader.get_object(timeline::key(&index.upstream)?).await?;
                        ensure!(
                            event.status_code() == 200,
                            "kernel root Timeline GET returned HTTP {}",
                            event.status_code()
                        );
                        index.in_event(event.as_slice())?
                    }
                    status => anyhow::bail!("kernel root Epilogue GET returned HTTP {status}"),
                };
                self.remember(blob.clone());
                blob
            }
        };
        index.graph(&blob)?;
        Ok((
            Commit::from_blob(index.viewpoint.decimal(), blob.clone())?,
            blob,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_disposable_messages_and_payload_free_schema() -> Result<()> {
        let mut cache = Cache::default();
        for i in 0..CAPACITY + 1 {
            cache.remember(i.to_le_bytes().to_vec());
        }
        assert!(
            !cache
                .messages
                .contains_key(&event::digest(&0usize.to_le_bytes()))
        );
        assert!(
            cache
                .messages
                .contains_key(&event::digest(&CAPACITY.to_le_bytes()))
        );
        cache.remember(vec![7; BYTE_LIMIT]);
        assert_eq!(cache.bytes, BYTE_LIMIT);
        assert_eq!(cache.messages.len(), 1);
        cache.remember(vec![8; BYTE_LIMIT + 1]);
        assert_eq!(cache.bytes, BYTE_LIMIT);
        let state = turso::State::genesis_schema(SCHEMA)?;
        let mut columns = vec![];
        turso::rows(
            state.connection(),
            "PRAGMA table_info(kernel_commits)",
            |row| {
                columns.push((row.get::<String>(1)?, row.get::<String>(2)?));
                Ok(())
            },
        )?;
        assert!(
            !columns
                .iter()
                .any(|(name, kind)| name == "blob" || kind.eq_ignore_ascii_case("BLOB")),
            "kernel roots must not be persisted as SQL payloads"
        );
        Ok(())
    }
}
