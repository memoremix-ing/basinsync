//! Presigned GETs whose authentication binds the exact Range header.
use anyhow::{Context, Result, ensure};
use axum::http::HeaderMap;
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
    // Preserve the SDK's endpoint/path/query encoding and credential refresh. Its
    // GET helper signs only Host, so re-sign through its public SigV4 primitives.
    let mut url = Url::parse(&bucket.presign_get(key, 300, None).await?)?;
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
    url.query_pairs_mut()
        .clear()
        .extend_pairs(query.iter().filter(|(key, _)| {
            key.as_str() != "X-Amz-Signature" && key.as_str() != "X-Amz-SignedHeaders"
        }))
        .append_pair("X-Amz-SignedHeaders", "host;range");
    let mut headers = HeaderMap::new();
    headers.insert(
        "host",
        url[Position::BeforeHost..Position::AfterPort].parse()?,
    );
    headers.insert("range", range.parse()?);
    let canonical = signing::canonical_request("GET", &url, &headers, "UNSIGNED-PAYLOAD")?;
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
        headers: BTreeMap::from([("Range".into(), range)]),
    })
}
