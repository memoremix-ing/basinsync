//! Reservoir object namespaces and durable Watershed recovery anchors.
use crate::{event, lexidecimal::Viewpoint, turso};
use anyhow::{Context, Result, ensure};
use axum::http::{HeaderMap, HeaderValue};
use num_bigint::BigUint;
use s3::Bucket;
use std::collections::HashMap;

pub const WATERSHED_PREFIX: &str = "epilogue/";

pub fn flow_prefix(flow: &str) -> String {
    // A reversible, path-safe encoding; no restrictions on leading zeroes or '/'.
    let id: String = flow.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
    format!("flows/0x{id}/epilogue/")
}
pub fn flow_key(flow: &str, viewpoint: &Viewpoint) -> Result<String> {
    let key = format!(
        "{}{}",
        flow_prefix(flow),
        viewpoint.key()?.strip_prefix(WATERSHED_PREFIX).unwrap()
    );
    ensure!(
        key.len() <= 1024,
        "Flow CommitMarker key exceeds S3's key size limit"
    );
    Ok(key)
}
pub fn promotion_key(prefix: &str, viewpoint: &Viewpoint) -> Result<String> {
    let key = format!("{prefix}{}", viewpoint.lexidecimal());
    ensure!(
        key.len() <= 1024,
        "PromotionSign key exceeds S3's key size limit"
    );
    Ok(key)
}
pub fn flow_promotion_key(flow: &str, viewpoint: &Viewpoint) -> Result<String> {
    promotion_key(&flow_prefix(flow), viewpoint)
}
/// A sign is an immutable, empty object; confirmation also resolves ambiguous PUT replies.
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
    let result = bucket
        .put_object_with_headers(key, &[], Some(headers))
        .await;
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
        200 => {
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
    let (page, status) = bucket
        .list_page(prefix.into(), None, None, None, Some(1))
        .await?;
    ensure!(status == 200, "Epilogue LIST returned HTTP {status}");
    let Some(object) = page.contents.first() else {
        return Ok(None);
    };
    let suffix = object
        .key
        .strip_prefix(prefix)
        .context("invalid Epilogue key")?;
    // All complemented markers sort before all uncomplemented signs. A sign
    // at the minimum therefore means this Epilogue currently has no markers.
    if suffix.starts_with("0z") {
        crate::lexidecimal::decode(suffix)?;
        return Ok(None);
    }
    let viewpoint = Viewpoint::from_key(&format!("{WATERSHED_PREFIX}{suffix}"))?;
    Ok(Some((object.key.clone(), viewpoint)))
}

#[derive(Clone, Debug)]
pub struct Checkpoint {
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
    pub fn headers(&self) -> Result<HeaderMap> {
        let mut headers = conditional_headers();
        for (name, value) in [
            ("x-amz-meta-milestone", self.milestone.to_string()),
            ("x-amz-meta-event-sha384", self.digest.clone()),
            ("x-amz-meta-sha384", self.sha384.clone()),
            ("x-amz-meta-turso-version", self.version.clone()),
        ] {
            headers.insert(axum::http::HeaderName::from_static(name), value.parse()?);
        }
        Ok(headers)
    }
    pub async fn load(&self, bucket: &Bucket) -> Result<crate::timeline::Watershed> {
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
            actual.milestone == self.milestone
                && actual.digest == self.digest
                && actual.sha384 == self.sha384,
            "backup metadata changed"
        );
        let image = response.as_slice().to_vec();
        ensure!(
            event::digest(&image) == self.sha384,
            "backup checksum mismatch"
        );
        let database =
            tokio::task::spawn_blocking(move || turso::State::from_image(image)).await??;
        ensure!(
            database.milestone()? == self.milestone.to_string(),
            "backup database Milestone mismatch"
        );
        Ok(crate::timeline::Watershed {
            milestone: self.milestone.clone(),
            head: Some(self.digest.clone()),
            database: Some(database),
            ..Default::default()
        })
    }
}

pub async fn latest_checkpoint(bucket: &Bucket) -> Result<Option<Checkpoint>> {
    let Some((key, viewpoint)) = latest_key(bucket, WATERSHED_PREFIX).await? else {
        return Ok(None);
    };
    let (head, status) = crate::object_read::if_present(bucket)?
        .head_object(key)
        .await?;
    ensure!(status == 200, "backup HEAD returned HTTP {status}");
    let headers = head
        .metadata
        .context("missing backup metadata")?
        .into_iter()
        .map(|(key, value)| (format!("x-amz-meta-{key}"), value))
        .collect();
    Ok(Some(Checkpoint::from_headers(viewpoint, &headers)?))
}

pub async fn replicate(bucket: &Bucket, flow: &str, marker: &event::Marker) -> Result<()> {
    let viewpoint = marker.validate()?;
    let key = flow_key(flow, &viewpoint)?;
    let mut headers = conditional_headers();
    headers.insert("x-amz-meta-sha384", marker.sha384.parse()?);
    let result = bucket
        .put_object_with_headers(&key, &marker.blob, Some(headers))
        .await;
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
                existing.as_slice() == marker.blob,
                "conflicting stored Flow CommitMarker"
            );
        }
    }
    Ok(())
}

pub async fn matches_marker(
    bucket: &Bucket,
    flow: &str,
    viewpoint: &Viewpoint,
    location: &turso::Location,
) -> Result<bool> {
    let (head, status) = crate::object_read::if_present(bucket)?
        .head_object(flow_key(flow, viewpoint)?)
        .await?;
    ensure!(
        matches!(status, 200 | 404 | 412),
        "Flow HEAD returned HTTP {status}"
    );
    Ok(status == 200
        && head.content_length.and_then(|n| u64::try_from(n).ok()) == Some(location.length)
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
        let vp = Viewpoint::zero();
        let ids = ["", "0", "0x1", "/", "../", "雪", "__proto__"];
        let mut keys = std::collections::BTreeSet::new();
        for flow in ids {
            let key = flow_key(flow, &vp)?;
            assert!(!key.starts_with(WATERSHED_PREFIX));
            assert!(keys.insert(key));
        }
        assert!(flow_key(&"x".repeat(600), &vp).is_err());
        Ok(())
    }
    #[test]
    fn promotion_signs_use_uncomplemented_keys_after_every_marker() -> Result<()> {
        let values = ["0", "1", "16", "340282366920938463463374607431768211456"];
        let mut markers = Vec::new();
        let mut signs = Vec::new();
        for value in values {
            let vp = Viewpoint::parse(value)?;
            let marker = flow_key("f/雪", &vp)?;
            let sign = flow_promotion_key("f/雪", &vp)?;
            assert!(sign.ends_with(&vp.lexidecimal()));
            assert!(marker < sign);
            assert!(Viewpoint::from_key(&promotion_key(WATERSHED_PREFIX, &vp)?).is_err());
            markers.push(marker);
            signs.push(sign);
        }
        assert!(markers.iter().all(|m| signs.iter().all(|s| m < s)));
        assert!(flow_promotion_key(&"x".repeat(600), &Viewpoint::zero()).is_err());
        Ok(())
    }
    #[test]
    fn backup_metadata_requires_a_complete_canonical_anchor() -> Result<()> {
        let cp = Checkpoint {
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
        for name in ["milestone", "event-sha384", "sha384", "turso-version"] {
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
