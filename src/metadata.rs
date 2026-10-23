//! Typed JSON0 metadata for multipart commits. Query parameters are ordinary strings.
use crate::lexidecimal::Viewpoint;
use base64::{
    Engine,
    alphabet::{STANDARD, URL_SAFE},
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use num_bigint::BigUint;
use serde::{Deserialize, Deserializer, de::Error};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitMetadata {
    #[serde(deserialize_with = "text")]
    pub flow: String,
    #[serde(deserialize_with = "viewpoint")]
    pub viewpoint: Viewpoint,
    #[serde(deserialize_with = "bytes")]
    pub sha384: Vec<u8>,
}

fn text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let wire = String::deserialize(deserializer)?;
    if let Some(value) = wire.strip_prefix("00") {
        return Ok(format!("0{value}"));
    }
    if wire.starts_with('0') && wire.len() > 1 {
        return Err(D::Error::custom("flow must be a JSON0 string"));
    }
    Ok(wire)
}

fn viewpoint<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Viewpoint, D::Error> {
    let wire = String::deserialize(deserializer)?;
    let hex = wire
        .strip_prefix("0x")
        .filter(|hex| !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| D::Error::custom("viewpoint must be a nonnegative JSON0 bigint"))?;
    let integer = BigUint::parse_bytes(hex.as_bytes(), 16)
        .ok_or_else(|| D::Error::custom("invalid viewpoint"))?;
    Viewpoint::parse(&integer.to_str_radix(10)).map_err(D::Error::custom)
}

fn bytes<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    let wire = String::deserialize(deserializer)?;
    let alphabet = match wire.get(..2) {
        Some("0*") => &URL_SAFE,
        Some("0%") => &STANDARD,
        _ => return Err(D::Error::custom("sha384 must be JSON0 bytes")),
    };
    let config = GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true);
    let encoded: Vec<u8> = wire.as_bytes()[2..]
        .iter()
        .copied()
        .filter(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0c))
        .collect();
    GeneralPurpose::new(alphabet, config)
        .decode(encoded)
        .map_err(D::Error::custom)
}

#[cfg(test)]
mod tests {
    use super::*;
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
