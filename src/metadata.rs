//! Typed JSON0 metadata for multipart commits. Query parameters are ordinary strings.
use crate::lexidecimal::Viewpoint;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitMetadata {
    #[serde(deserialize_with = "crate::json0::deserialize_text")]
    pub flow: String,
    #[serde(deserialize_with = "crate::json0::deserialize_viewpoint")]
    pub viewpoint: Viewpoint,
    #[serde(deserialize_with = "crate::json0::deserialize_bytes")]
    pub sha384: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use num_bigint::BigUint;
    use proptest::prelude::*;

    #[test]
    fn json0_types_escaping_and_duplicate_rejection() {
        let metadata: CommitMetadata = serde_json::from_str(
            r#"{"flow":"00x1","viewpoint":"0x100000000000000000000000000000000","sha384":"0*AP8"}"#,
        )
        .unwrap();
        assert_eq!(metadata.flow, "0x1");
        assert_eq!(
            metadata.viewpoint.decimal(),
            (BigUint::from(1u8) << 128usize).to_string()
        );
        assert_eq!(metadata.sha384, [0, 255]);
        for wire in ["0*AP8", "0*AP8=", "0%AP8=", "0%AP8", "0* A\tP8\n"] {
            let metadata: CommitMetadata = serde_json::from_value(serde_json::json!({
                "flow": "0", "viewpoint": "0x0", "sha384": wire,
            }))
            .unwrap();
            assert_eq!(metadata.flow, "0");
            assert_eq!(metadata.sha384, [0, 255]);
        }
        for wire in [
            r#"{"flow":"0x1","viewpoint":"0x0","sha384":"0*"}"#,
            r#"{"flow":"f","viewpoint":"0~0","sha384":"0*"}"#,
            r#"{"flow":"f","viewpoint":"0","sha384":"0*"}"#,
            r#"{"flow":"f","viewpoint":0,"sha384":"0*"}"#,
            r#"{"flow":"f","viewpoint":"0x0","sha384":"00*"}"#,
            r#"{"flow":"f","viewpoint":"0x0","sha384":"0*?"}"#,
            r#"{"flow":"f","flow":"g","viewpoint":"0x0","sha384":"0*"}"#,
            r#"{"flow":"f","viewpoint":"0x0","sha384":"0*","extra":0}"#,
        ] {
            assert!(
                serde_json::from_str::<CommitMetadata>(wire).is_err(),
                "{wire}"
            );
        }
    }

    proptest! {
        #[test]
        fn arbitrary_precision_and_bytes(value in prop::collection::vec(any::<u8>(), 0..512)) {
            let integer = BigUint::from_bytes_be(&value);
            let wire = serde_json::json!({
                "flow": "f", "viewpoint": format!("0x{integer:x}"),
                "sha384": format!("0*{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&value)),
            });
            let metadata: CommitMetadata = serde_json::from_value(wire).unwrap();
            prop_assert_eq!(metadata.sha384, value);
            prop_assert_eq!(metadata.viewpoint.decimal(), integer.to_string());
        }
    }
}
