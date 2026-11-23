//! Reservoir object namespaces and durable Basin recovery anchors.
use crate::{event, lexidecimal::Viewpoint, turso};
use anyhow::{Context, Result, ensure};
use axum::http::{HeaderMap, HeaderValue};
use num_bigint::BigUint;
use s3::Bucket;
use std::collections::HashMap;

pub const BASIN_PREFIX: &str = "kernelspace/basin/epilogue/";

pub fn flow_prefix(flow: &str, revision: &uuid::Uuid) -> String {
    format!("userspace/flows/{flow}/{revision}/epilogue/")
}
pub fn flow_key(flow: &str, revision: &uuid::Uuid, viewpoint: &Viewpoint) -> Result<String> {
    event::valid_flow(flow)?;
    let key = format!(
        "{}{}",
        flow_prefix(flow, revision),
        viewpoint.key()?.strip_prefix(BASIN_PREFIX).unwrap()
    );
    ensure!(
        key.len() <= 1024,
        "Flow CommitMarker key exceeds S3's key size limit"
    );
    Ok(key)
}
/// Validate an incoming Flow namespace before its revision has been allocated.
pub fn check_flow_key(flow: &str, viewpoint: &Viewpoint) -> Result<()> {
    flow_key(flow, &uuid::Uuid::nil(), viewpoint).map(|_| ())
}
pub fn promotion_key(prefix: &str, viewpoint: &Viewpoint) -> Result<String> {
    let key = format!("{prefix}{}", viewpoint.lexidecimal());
    ensure!(
        key.len() <= 1024,
        "PromotionSign key exceeds S3's key size limit"
    );
    Ok(key)
}
pub fn flow_promotion_key(
    flow: &str,
    revision: &uuid::Uuid,
    viewpoint: &Viewpoint,
) -> Result<String> {
    event::valid_flow(flow)?;
    promotion_key(&flow_prefix(flow, revision), viewpoint)
}
/// A sign is a bucket-proven standalone margin envelope; confirmation also resolves ambiguous PUT replies.
pub async fn confirm_promotion_sign(bucket: &Bucket, key: &str, upstream: &BigUint) -> Result<()> {
    ensure!(
        upstream > &BigUint::from(0u8),
        "PromotionSign upstream must be positive"
    );
    if promotion_sign_matches(bucket, key, upstream).await? {
        return Ok(());
    }
    let mut headers = conditional_headers();
    headers.insert("x-amz-meta-upstream", upstream.to_string().parse()?);
    let result = crate::sequence::put_margin(bucket, key, headers).await;
    ensure!(
        promotion_sign_matches(bucket, key, upstream).await?,
        "PromotionSign not confirmed: {result:?}"
    );
    Ok(())
}
async fn promotion_sign_matches(bucket: &Bucket, key: &str, upstream: &BigUint) -> Result<bool> {
    let (head, status) = crate::object_read::if_present(bucket)?
        .head_object(key)
        .await?;
    match status {
        200 if head.content_length.is_some_and(|length| length < 16) => Ok(false),
        200 => {
            if head.e_tag.as_deref().context("PromotionSign has no ETag")?
                == crate::sequence::reference(bucket)?
            {
                return Ok(false);
            }
            ensure!(
                head.content_length
                    .is_some_and(|length| length >= 16 && length % 8 == 0),
                "invalid PromotionSign envelope length"
            );
            ensure!(
                head.metadata.as_ref().and_then(|m| m.get("upstream"))
                    == Some(&upstream.to_string()),
                "PromotionSign upstream mismatch"
            );
            Ok(true)
        }
        404 | 412 => Ok(false),
        _ => anyhow::bail!("PromotionSign HEAD returned HTTP {status}"),
    }
}

pub fn conditional_headers() -> HeaderMap {
    HeaderMap::from_iter([(
        axum::http::header::IF_NONE_MATCH,
        HeaderValue::from_static("*"),
    )])
}

pub async fn latest_key(bucket: &Bucket, prefix: &str) -> Result<Option<(String, Viewpoint)>> {
    let mut after = None;
    loop {
        let (page, status) = bucket
            .list_page(prefix.into(), None, None, after.clone(), Some(1))
            .await?;
        ensure!(status == 200, "Epilogue LIST returned HTTP {status}");
        let Some(object) = page.contents.first() else {
            return Ok(None);
        };
        ensure!(
            after.as_ref().is_none_or(|key: &String| object.key > *key),
            "Epilogue LIST did not advance"
        );
        let suffix = object
            .key
            .strip_prefix(prefix)
            .context("invalid Epilogue key")?;
        // All complemented markers precede uncomplemented signs.
        if suffix.starts_with("0z") {
            crate::lexidecimal::decode(suffix)?;
            return Ok(None);
        }
        let viewpoint = Viewpoint::from_key(&format!("{BASIN_PREFIX}{suffix}"))?;
        if object.size >= 16 {
            return Ok(Some((object.key.clone(), viewpoint)));
        }
        if object.size > 0 {
            let existing = crate::object_read::if_present(bucket)?
                .get_object(&object.key)
                .await?;
            ensure!(
                existing.status_code() == 200
                    && existing.as_slice() == crate::sequence::tombstone(bucket)?,
                "invalid Epilogue tombstone"
            );
        }
        // Sentinels and immutable tombstones are not recovery anchors.
        after = Some(object.key.clone());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    pub crc32c: u32,
    pub coordinate: BigUint,
    pub viewpoint: Viewpoint,
    pub milestone: BigUint,
    pub digest: String,
    pub sha384: String,
    pub version: String,
}
impl Checkpoint {
    fn from_headers(viewpoint: Viewpoint, headers: &HashMap<String, String>) -> Result<Self> {
        let field = |name: &str| -> Result<String> {
            headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(&format!("x-amz-meta-{name}")))
                .map(|(_, v)| v.clone())
                .with_context(|| format!("missing backup {name}"))
        };
        let decimal = field("milestone")?;
        let milestone = decimal.parse::<BigUint>()?;
        ensure!(
            milestone > 0u8.into() && milestone.to_string() == decimal,
            "invalid backup Milestone"
        );
        let result = Self {
            viewpoint,
            milestone,
            coordinate: {
                let text = field("coordinate")?;
                let value: BigUint = text.parse()?;
                ensure!(value.to_string() == text, "invalid backup coordinate");
                value
            },
            crc32c: crate::checksum::parse(&field("crc32c")?)?,
            digest: field("event-sha384")?,
            sha384: field("sha384")?,
            version: field("turso-version")?,
        };
        ensure!(
            result.version == turso::VERSION,
            "unsupported backup Turso version"
        );
        for digest in [&result.digest, &result.sha384] {
            ensure!(
                digest.len() == 96
                    && digest
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "invalid backup digest"
            );
        }
        Ok(result)
    }
    pub(crate) fn verify_headers(&self, headers: &HashMap<String, String>) -> Result<()> {
        ensure!(
            Self::from_headers(self.viewpoint.clone(), headers)? == *self,
            "backup metadata changed"
        );
        Ok(())
    }
    pub fn headers(&self) -> Result<HeaderMap> {
        let mut headers = conditional_headers();
        for (name, value) in [
            ("x-amz-meta-milestone", self.milestone.to_string()),
            ("x-amz-meta-coordinate", self.coordinate.to_string()),
            ("x-amz-meta-crc32c", crate::checksum::format(self.crc32c)),
            ("x-amz-meta-event-sha384", self.digest.clone()),
            ("x-amz-meta-sha384", self.sha384.clone()),
            ("x-amz-meta-turso-version", self.version.clone()),
        ] {
            headers.insert(axum::http::HeaderName::from_static(name), value.parse()?);
        }
        Ok(headers)
    }
    pub async fn load(&self, bucket: &Bucket) -> Result<crate::timeline::Basin> {
        let response = crate::object_read::if_present(bucket)?
            .get_object(self.viewpoint.key()?)
            .await?;
        ensure!(
            response.status_code() == 200,
            "backup GET returned HTTP {}",
            response.status_code()
        );
        let actual = Self::from_headers(self.viewpoint.clone(), &response.headers())?;
        ensure!(
            actual.crc32c == self.crc32c
                && actual.coordinate == self.coordinate
                && actual.milestone == self.milestone
                && actual.digest == self.digest
                && actual.sha384 == self.sha384,
            "backup metadata changed"
        );
        let image = crate::envbuf::message(response.as_slice())?.to_vec();
        ensure!(
            event::digest(&image) == self.sha384,
            "backup checksum mismatch"
        );
        let (database, kernel_database) = if image.starts_with(b"SQLite format 3\0") {
            (
                tokio::task::spawn_blocking(move || turso::State::from_image(image)).await??,
                None,
            )
        } else {
            let graph = crate::kernel::Graph::decode(&image)?;
            ensure!(
                graph.milestone == self.milestone.to_string()
                    && graph.coordinate == self.coordinate.to_string()
                    && graph.crc32c == crate::checksum::format(self.crc32c)
                    && graph.parent == self.digest,
                "backup graph prefix mismatch"
            );
            let (primary, kernel) = tokio::try_join!(
                crate::kernel::image(bucket, &graph.databases[turso::ID]),
                crate::kernel::image(bucket, &graph.databases[crate::kernel::ID])
            )?;
            let pair = tokio::task::spawn_blocking(move || {
                Ok::<_, anyhow::Error>((
                    turso::State::from_image(primary)?,
                    turso::State::from_image(kernel)?,
                ))
            })
            .await??;
            ensure!(
                pair.1.milestone()? == self.milestone.to_string(),
                "kernel backup Milestone mismatch"
            );
            (pair.0, Some(pair.1))
        };
        ensure!(
            database.milestone()? == self.milestone.to_string(),
            "backup database Milestone mismatch"
        );
        Ok(crate::timeline::Basin {
            milestone: self.milestone.clone(),
            coordinate: self.coordinate.clone(),
            crc32c: self.crc32c,
            head: Some(self.digest.clone()),
            database: Some(database),
            kernel_database,
            ..Default::default()
        })
    }
}

pub async fn latest_checkpoint(bucket: &Bucket) -> Result<Option<Checkpoint>> {
    loop {
        let Some((key, viewpoint)) = latest_key(bucket, BASIN_PREFIX).await? else {
            return Ok(None);
        };
        let (head, status) = crate::object_read::if_present(bucket)?
            .head_object(key)
            .await?;
        ensure!(status == 200, "backup HEAD returned HTTP {status}");
        if head.content_length.is_some_and(|length| length < 16) {
            continue;
        }
        let headers = head
            .metadata
            .context("missing backup metadata")?
            .into_iter()
            .map(|(key, value)| (format!("x-amz-meta-{key}"), value))
            .collect();
        return Ok(Some(Checkpoint::from_headers(viewpoint, &headers)?));
    }
}

pub async fn replicate(
    bucket: &Bucket,
    flow: &str,
    revision: &uuid::Uuid,
    marker: &event::Marker,
) -> Result<()> {
    let viewpoint = marker.validate()?;
    let key = flow_key(flow, revision, &viewpoint)?;
    let mut headers = conditional_headers();
    headers.insert("x-amz-meta-sha384", marker.sha384.parse()?);
    headers.extend(crate::details::context_headers(&marker.context)?);
    let bytes = crate::envbuf::wrap(&marker.blob)?;
    let result = crate::sequence::put_feed(bucket, &key, &bytes, headers).await;
    match result {
        Ok(response) if (200..300).contains(&response.status_code()) => return Ok(()),
        // Resolve conflicts and ambiguous replies by verifying the immutable object.
        result => {
            let existing = crate::object_read::if_present(bucket)?
                .get_object(&key)
                .await?;
            ensure!(
                existing.status_code() == 200,
                "Flow replication failed: {result:?}"
            );
            ensure!(
                crate::envbuf::message(existing.as_slice())? == marker.blob,
                "conflicting stored Flow CommitMarker"
            );
            let actual: std::collections::BTreeMap<_, _> = existing
                .headers()
                .into_iter()
                .filter_map(|(key, value)| {
                    key.to_ascii_lowercase()
                        .strip_prefix("x-amz-meta-ctx-")
                        .map(|suffix| (suffix.to_owned(), value.trim().to_owned()))
                })
                .collect();
            let expected: std::collections::BTreeMap<_, _> =
                crate::details::context_headers(&marker.context)?
                    .iter()
                    .map(|(key, value)| {
                        (
                            key.as_str()
                                .strip_prefix("x-amz-meta-ctx-")
                                .unwrap()
                                .to_owned(),
                            value.to_str().unwrap().trim().to_owned(),
                        )
                    })
                    .collect();
            ensure!(actual == expected, "conflicting stored Flow context");
        }
    }
    Ok(())
}

pub async fn matches_marker(
    bucket: &Bucket,
    flow: &str,
    revision: &uuid::Uuid,
    viewpoint: &Viewpoint,
    location: &turso::Location,
) -> Result<bool> {
    let (head, status) = crate::object_read::if_present(bucket)?
        .head_object(flow_key(flow, revision, viewpoint)?)
        .await?;
    ensure!(
        matches!(status, 200 | 404 | 412),
        "Flow HEAD returned HTTP {status}"
    );
    Ok(status == 200
        && head
            .content_length
            .and_then(|n| u64::try_from(n).ok())
            .is_some_and(|length| {
                crate::envbuf::encoded_length(location.length)
                    .is_ok_and(|minimum| length >= minimum && length % 8 == 0)
            })
        && head
            .metadata
            .as_ref()
            .and_then(|m| m.get("sha384"))
            .map(String::as_str)
            == Some(location.sha384.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reservoir_keys_are_disjoint_and_flow_ids_are_unambiguous() -> Result<()> {
        let revision = uuid::Uuid::new_v4();
        let vp = Viewpoint::zero();
        let ids = ["a", "0", "0x1", "dot.id", "a-b", "a_b", "__proto__"];
        let mut keys = std::collections::BTreeSet::new();
        for flow in ids {
            let key = flow_key(flow, &revision, &vp)?;
            assert!(!key.starts_with(BASIN_PREFIX));
            assert!(keys.insert(key));
        }
        assert!(flow_key(&"x".repeat(600), &revision, &vp).is_err());
        Ok(())
    }
    /// The TypeScript tests build keys from the same table.
    #[test]
    fn layouts_match_the_shared_object_key_table() -> Result<()> {
        let table: HashMap<String, String> =
            serde_json::from_str(include_str!("../tests/vectors/object-keys.json"))?;
        assert_eq!(table["timeline"], crate::timeline::PREFIX);
        assert_eq!(table["basinEpilogue"], BASIN_PREFIX);
        assert_eq!(table["analogue"], crate::analogue::PREFIX);
        assert_eq!(
            format!("{}young/", table["kernelHeap"]),
            crate::kernel::YOUNG
        );
        assert_eq!(format!("{}old/", table["kernelHeap"]), crate::kernel::OLD);
        assert_eq!(format!("{}young/", table["userHeap"]), crate::heap::YOUNG);
        assert_eq!(format!("{}old/", table["userHeap"]), crate::heap::OLD);
        assert_eq!(table["emptySentinel"], crate::sequence::REFERENCE_KEY);
        let revision = uuid::Uuid::nil();
        assert_eq!(
            flow_prefix("f", &revision),
            format!("{}f/{revision}/epilogue/", table["userFlows"])
        );
        Ok(())
    }
    #[test]
    fn promotion_signs_use_uncomplemented_keys_after_every_marker() -> Result<()> {
        let revision = uuid::Uuid::new_v4();
        let values = ["0", "1", "16", "340282366920938463463374607431768211456"];
        let mut markers = Vec::new();
        let mut signs = Vec::new();
        for value in values {
            let vp = Viewpoint::parse(value)?;
            let marker = flow_key("f-snow", &revision, &vp)?;
            let sign = flow_promotion_key("f-snow", &revision, &vp)?;
            assert!(sign.ends_with(&vp.lexidecimal()));
            assert!(marker < sign);
            assert!(Viewpoint::from_key(&promotion_key(BASIN_PREFIX, &vp)?).is_err());
            markers.push(marker);
            signs.push(sign);
        }
        assert!(markers.iter().all(|m| signs.iter().all(|s| m < s)));
        assert!(flow_promotion_key(&"x".repeat(600), &revision, &Viewpoint::zero()).is_err());
        Ok(())
    }
    #[test]
    fn backup_metadata_requires_a_complete_canonical_anchor() -> Result<()> {
        let cp = Checkpoint {
            crc32c: 0x12345678,
            coordinate: 4096u32.into(),
            viewpoint: Viewpoint::zero(),
            milestone: 42u8.into(),
            digest: "a".repeat(96),
            sha384: "b".repeat(96),
            version: turso::VERSION.into(),
        };
        let headers: HashMap<_, _> = cp
            .headers()?
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_owned()))
            .collect();
        assert_eq!(
            Checkpoint::from_headers(cp.viewpoint.clone(), &headers)?.milestone,
            cp.milestone
        );
        for name in [
            "milestone",
            "coordinate",
            "crc32c",
            "event-sha384",
            "sha384",
            "turso-version",
        ] {
            let mut bad = headers.clone();
            bad.remove(&format!("x-amz-meta-{name}"));
            assert!(Checkpoint::from_headers(cp.viewpoint.clone(), &bad).is_err());
        }
        for (name, value) in [
            ("milestone", "01"),
            ("milestone", "0"),
            ("turso-version", "old"),
            ("sha384", "ff"),
        ] {
            let mut bad = headers.clone();
            bad.insert(format!("x-amz-meta-{name}"), value.into());
            assert!(Checkpoint::from_headers(cp.viewpoint.clone(), &bad).is_err());
        }
        Ok(())
    }
}
