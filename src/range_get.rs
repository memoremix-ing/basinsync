//! Presigned GETs binding If-Match and, for Timeline blobs, the exact Range.
use anyhow::{Context, Result, ensure};
use axum::http::{HeaderMap, HeaderName};
use hmac::Mac;
use s3::{Bucket, signing};
use std::collections::BTreeMap;
use time::{PrimitiveDateTime, macros::format_description};
use url::{Position, Url};

#[derive(serde::Serialize)]
pub struct Access {
    #[serde(serialize_with = "crate::json0::serialize_text")]
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

pub async fn presign(bucket: &Bucket, key: &str, offset: u64, length: u64) -> Result<Access> {
    ensure!(length > 0, "an empty blob has no HTTP byte range");
    let end = offset
        .checked_add(length - 1)
        .context("Range offset overflow")?;
    let range = format!("bytes={offset}-{end}");
    signed_get(
        bucket,
        key,
        BTreeMap::from([("If-Match".into(), "*".into()), ("Range".into(), range)]),
    )
    .await
}

pub async fn presign_whole(bucket: &Bucket, key: &str) -> Result<Access> {
    signed_get(
        bucket,
        key,
        BTreeMap::from([("If-Match".into(), "*".into())]),
    )
    .await
}

async fn signed_get(
    bucket: &Bucket,
    key: &str,
    access_headers: BTreeMap<String, String>,
) -> Result<Access> {
    signed_request(bucket, key, "GET", access_headers).await
}

pub async fn presign_write(bucket: &Bucket, key: &str, length: u64) -> Result<Access> {
    signed_request(
        bucket,
        key,
        "PUT",
        BTreeMap::from([
            ("If-None-Match".into(), "*".into()),
            ("Content-Length".into(), length.to_string()),
        ]),
    )
    .await
}

// Sort by header name, not by the concatenated `name:value`: prefix names such
// as x-amz-copy-source / x-amz-copy-source-if-match otherwise sort incorrectly.
fn canonical_request(
    method: &str,
    url: &Url,
    headers: &HeaderMap,
    payload: &str,
) -> Result<String> {
    let ordered: BTreeMap<_, _> = headers
        .iter()
        .map(|(k, v)| {
            Ok((
                k.as_str(),
                v.to_str()?.split_whitespace().collect::<Vec<_>>().join(" "),
            ))
        })
        .collect::<Result<_>>()?;
    let names = ordered.keys().copied().collect::<Vec<_>>().join(";");
    let block = ordered
        .iter()
        .map(|(k, v)| format!("{k}:{v}"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        "{method}\n{}\n{}\n{block}\n\n{names}\n{payload}",
        signing::canonical_uri_string(url),
        signing::canonical_query_string(url)
    ))
}

pub(crate) async fn signed_request(
    bucket: &Bucket,
    key: &str,
    method: &str,
    access_headers: BTreeMap<String, String>,
) -> Result<Access> {
    // Preserve the SDK's endpoint/path/query encoding and credential refresh. Its
    // GET helper signs only Host, so re-sign through its public SigV4 primitives.
    let url = if method == "PUT" {
        bucket.presign_put(key, 300, None, None).await?
    } else {
        bucket.presign_get(key, 300, None).await?
    };
    let mut url = Url::parse(&url)?;
    let credentials = bucket.credentials().await?;
    let query: BTreeMap<_, _> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let credential = query
        .get("X-Amz-Credential")
        .context("missing signing credential")?;
    ensure!(
        credential.split('/').next() == credentials.access_key.as_deref(),
        "credentials changed during presigning; retry request"
    );
    let timestamp = query.get("X-Amz-Date").context("missing signing date")?;
    let datetime = PrimitiveDateTime::parse(
        timestamp,
        format_description!("[year][month][day]T[hour][minute][second]Z"),
    )?
    .assume_utc();
    let mut headers = HeaderMap::new();
    headers.insert(
        "host",
        url[Position::BeforeHost..Position::AfterPort].parse()?,
    );
    for (name, value) in &access_headers {
        headers.insert(HeaderName::from_bytes(name.as_bytes())?, value.parse()?);
    }
    let mut signed_headers: Vec<_> = headers.keys().map(|name| name.as_str()).collect();
    signed_headers.sort_unstable();
    let signed_headers = signed_headers.join(";");
    url.query_pairs_mut()
        .clear()
        .extend_pairs(query.iter().filter(|(key, _)| {
            key.as_str() != "X-Amz-Signature" && key.as_str() != "X-Amz-SignedHeaders"
        }))
        .append_pair("X-Amz-SignedHeaders", &signed_headers);
    let canonical = canonical_request(method, &url, &headers, "UNSIGNED-PAYLOAD")?;
    let region = bucket.region();
    let signing_key = signing::signing_key(
        &datetime,
        credentials
            .secret_key
            .as_deref()
            .context("missing signing secret")?,
        &region,
        "s3",
    )?;
    let mut mac = signing::HmacSha256::new_from_slice(&signing_key)?;
    mac.update(signing::string_to_sign(&datetime, &region, &canonical)?.as_bytes());
    let signature: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    url.query_pairs_mut()
        .append_pair("X-Amz-Signature", &signature);
    Ok(Access {
        url: url.into(),
        headers: access_headers,
    })
}

#[cfg(test)]
mod canonical_tests {
    use super::*;
    #[test]
    fn prefix_header_names_follow_signed_header_order() {
        let headers = HeaderMap::from_iter([
            (
                HeaderName::from_static("x-amz-copy-source-if-match"),
                "\"etag\"".parse().unwrap(),
            ),
            (
                HeaderName::from_static("x-amz-copy-source"),
                "bucket/key".parse().unwrap(),
            ),
        ]);
        let c = canonical_request(
            "PUT",
            &Url::parse("https://example.com/key").unwrap(),
            &headers,
            "UNSIGNED-PAYLOAD",
        )
        .unwrap();
        assert!(c.contains("x-amz-copy-source:bucket/key\nx-amz-copy-source-if-match:\"etag\"\n\nx-amz-copy-source;x-amz-copy-source-if-match"));
    }
}
