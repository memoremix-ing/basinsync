//! Conditional object reads; only existence probes interpret absent objects.
use anyhow::{Result, bail};
use axum::http::{HeaderValue, header};
use s3::Bucket;

pub fn if_present(bucket: &Bucket) -> Result<Bucket> {
    let mut headers = bucket.extra_headers().clone();
    headers.insert(header::IF_MATCH, HeaderValue::from_static("*"));
    Ok(bucket.with_extra_headers(headers)?)
}

pub async fn exists(bucket: &Bucket, key: &str) -> Result<bool> {
    let mut probe = if_present(bucket)?;
    probe.add_header("if-none-match", "*");
    let (_, status) = probe.head_object(key).await?;
    match status {
        // A provider that ignores preconditions can still answer correctly.
        200 | 304 => Ok(true),
        // Some providers check If-Match before absence; others return 404 first.
        404 | 412 => Ok(false),
        _ => bail!("object existence HEAD returned HTTP {status}"),
    }
}
