//! Typed JSON0 details for multipart commits. Query parameters are ordinary strings.
use crate::lexidecimal::Viewpoint;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitDetails {
    #[serde(default, deserialize_with = "crate::json0::deserialize_text_map")]
    pub context: std::collections::BTreeMap<String, String>,
    pub edges: Vec<crate::heap::WireEdge>,
    #[serde(deserialize_with = "crate::json0::deserialize_text")]
    pub flow: String,
    #[serde(deserialize_with = "crate::json0::deserialize_viewpoint")]
    pub viewpoint: Viewpoint,
    #[serde(deserialize_with = "crate::json0::deserialize_bytes")]
    pub sha384: Vec<u8>,
}

/// Validate before journal publication: S3 metadata names are case-insensitive,
/// and its 2 KiB user-metadata budget includes our SHA-384 field.
pub fn context_headers(
    context: &std::collections::BTreeMap<String, String>,
) -> anyhow::Result<axum::http::HeaderMap> {
    use anyhow::ensure;
    use axum::http::{HeaderMap, HeaderName, HeaderValue};
    let mut headers = HeaderMap::new();
    let mut size = "sha384".len() + 96;
    for (key, value) in context {
        ensure!(
            !key.is_empty() && !key.contains('\0'),
            "invalid context key"
        );
        let name = HeaderName::from_bytes(format!("x-amz-meta-ctx-{key}").as_bytes())?;
        ensure!(
            !headers.contains_key(&name),
            "duplicate context metadata name"
        );
        ensure!(
            value.bytes().all(|b| (32..=126).contains(&b)),
            "context values must be printable ASCII"
        );
        size += "ctx-".len() + key.len() + value.len();
        ensure!(
            size <= 2048,
            "context exceeds S3's user-metadata size limit"
        );
        headers.insert(name, HeaderValue::from_str(value)?);
    }
    Ok(headers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use num_bigint::BigUint;
    use proptest::prelude::*;

    #[test]
    fn context_is_json0_text_and_valid_s3_metadata() {
        let details: CommitDetails = serde_json::from_value(serde_json::json!({
            "flow":"f", "viewpoint":"0x0", "edges":[], "sha384":"0*",
            "context":{"Kind":"00x-literal", "empty":"", "0-key":"00"}
        }))
        .unwrap();
        let headers = context_headers(&details.context).unwrap();
        assert_eq!(headers["x-amz-meta-ctx-kind"], "0x-literal");
        assert_eq!(headers["x-amz-meta-ctx-empty"], "");
        assert_eq!(headers["x-amz-meta-ctx-0-key"], "0");
        for context in [
            serde_json::json!({"bad": "0x1"}),
            serde_json::json!({"bad":1}),
            serde_json::json!(null),
            serde_json::json!([]),
        ] {
            assert!(
                serde_json::from_value::<CommitDetails>(serde_json::json!({
                    "flow":"f", "viewpoint":"0x0", "edges":[], "sha384":"0*", "context":context
                }))
                .is_err()
            );
        }
        for context in [
            vec![("", "x")],
            vec![("a b", "x")],
            vec![("a\0b", "x")],
            vec![("a", "x\r\nx")],
            vec![("a", "雪")],
            vec![("A", "one"), ("a", "two")],
        ] {
            assert!(
                context_headers(
                    &context
                        .into_iter()
                        .map(|(k, v)| (k.to_owned(), v.to_owned()))
                        .collect()
                )
                .is_err()
            );
        }
        assert!(
            context_headers(&std::collections::BTreeMap::from([(
                "a".into(),
                "x".repeat(2048)
            )]))
            .is_err()
        );
    }

    #[test]
    fn json0_types_escaping_and_duplicate_rejection() {
        let details: CommitDetails = serde_json::from_str(
            r#"{"flow":"00x1","viewpoint":"0x100000000000000000000000000000000","edges":[],"sha384":"0*AP8"}"#,
        )
        .unwrap();
        assert_eq!(details.flow, "0x1");
        assert_eq!(
            details.viewpoint.decimal(),
            (BigUint::from(1u8) << 128usize).to_string()
        );
        assert_eq!(details.sha384, [0, 255]);
        for wire in ["0*AP8", "0*AP8=", "0%AP8=", "0%AP8"] {
            let details: CommitDetails = serde_json::from_value(serde_json::json!({
                "flow": "00", "viewpoint": "0x0", "edges":[],"sha384": wire,
            }))
            .unwrap();
            assert_eq!(details.flow, "0");
            assert_eq!(details.sha384, [0, 255]);
        }
        for wire in [
            r#"{"flow":"0x1","viewpoint":"0x0","edges":[],"sha384":"0*"}"#,
            r#"{"flow":"f","viewpoint":"0~0","edges":[],"sha384":"0*"}"#,
            r#"{"flow":"f","viewpoint":"0","edges":[],"sha384":"0*"}"#,
            r#"{"flow":"f","viewpoint":0,"edges":[],"sha384":"0*"}"#,
            r#"{"flow":"f","viewpoint":"0x0","edges":[],"sha384":"00*"}"#,
            r#"{"flow":"f","viewpoint":"0x0","edges":[],"sha384":"0*?"}"#,
            r#"{"flow":"f","viewpoint":"0x0","edges":[],"sha384":"0* AP8"}"#,
            r#"{"flow":"f","viewpoint":"0x0","edges":[],"sha384":"0*AP9"}"#,
            r#"{"flow":"f","flow":"g","viewpoint":"0x0","edges":[],"sha384":"0*"}"#,
            r#"{"flow":"f","viewpoint":"0x0","edges":[],"sha384":"0*","extra":0}"#,
        ] {
            assert!(
                serde_json::from_str::<CommitDetails>(wire).is_err(),
                "{wire}"
            );
        }
    }

    #[test]
    fn commit_edges_are_required_even_when_empty() {
        for edges in [
            None,
            Some(serde_json::Value::Null),
            Some(serde_json::json!({})),
            Some(serde_json::json!("[]")),
        ] {
            let mut value = serde_json::json!({"flow":"f","viewpoint":"0x0","sha384":"0*"});
            if let Some(edges) = edges {
                value["edges"] = edges;
            }
            assert!(serde_json::from_value::<CommitDetails>(value).is_err());
        }
    }

    proptest! {
        #[test]
        fn arbitrary_precision_and_bytes(value in prop::collection::vec(any::<u8>(), 0..512)) {
            let integer = BigUint::from_bytes_be(&value);
            let wire = serde_json::json!({
                "flow": "f", "viewpoint": format!("0x{integer:x}"),
                "edges":[],"sha384": format!("0*{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&value)),
            });
            let details: CommitDetails = serde_json::from_value(wire).unwrap();
            prop_assert_eq!(details.sha384, value);
            prop_assert_eq!(details.viewpoint.decimal(), integer.to_string());
        }
    }
}
