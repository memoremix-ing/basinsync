//! Reservoir object namespaces and durable Basin recovery anchors.
use crate::{event, lexidecimal::Viewpoint, turso};
use anyhow::{Context, Result, ensure};
use axum::http::{HeaderMap, HeaderValue};
use num_bigint::BigUint;
use s3::Bucket;
use std::collections::HashMap;

pub const BASIN_PREFIX: &str = "epilogue/";

pub fn flow_prefix(flow: &str) -> String {
    // A reversible, path-safe encoding; no restrictions on leading zeroes or '/'.
    let id: String = flow.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
    format!("flows/0x{id}/epilogue/")
}
pub fn flow_key(flow: &str, viewpoint: &Viewpoint) -> Result<String> {
    let key = format!(
        "{}{}",
        flow_prefix(flow),
        viewpoint.key()?.strip_prefix(BASIN_PREFIX).unwrap()
    );
    ensure!(
        key.len() <= 1024,
        "Flow CommitMarker key exceeds S3's key size limit"
    );
    Ok(key)
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
    page.contents
        .first()
        .map(|object| {
            let suffix = object
                .key
                .strip_prefix(prefix)
                .context("invalid Epilogue key")?;
            let viewpoint = Viewpoint::from_key(&format!("{BASIN_PREFIX}{suffix}"))?;
            Ok((object.key.clone(), viewpoint))
        })
        .transpose()
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
    pub async fn load(&self, bucket: &Bucket) -> Result<crate::timeline::Basin> {
        let response = bucket.get_object(self.viewpoint.key()?).await?;
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
        Ok(crate::timeline::Basin {
            milestone: self.milestone.clone(),
            head: Some(self.digest.clone()),
            database: Some(database),
            ..Default::default()
        })
    }
}

pub async fn latest_checkpoint(bucket: &Bucket) -> Result<Option<Checkpoint>> {
    let Some((key, viewpoint)) = latest_key(bucket, BASIN_PREFIX).await? else {
        return Ok(None);
    };
    let (head, status) = bucket.head_object(key).await?;
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
            let existing = bucket.get_object(&key).await?;
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
            assert!(!key.starts_with(BASIN_PREFIX));
            assert!(keys.insert(key));
        }
        assert!(flow_key(&"x".repeat(600), &vp).is_err());
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
