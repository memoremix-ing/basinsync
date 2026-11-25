//! JSON0 scalar adapters at the HTTP boundary.
use crate::lexidecimal::Viewpoint;
use base64::{
    alphabet::{STANDARD, URL_SAFE},
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use num_bigint::BigUint;
use serde::{Deserialize, Deserializer, Serializer, de::Error};

pub fn serialize_text<S: Serializer>(value: &str, serializer: S) -> Result<S::Ok, S::Error> {
    if value.starts_with('0') {
        serializer.serialize_str(&format!("0{value}"))
    } else {
        serializer.serialize_str(value)
    }
}

pub fn serialize_viewpoint<S: Serializer>(
    value: &Viewpoint,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&format!("0x{}", value.hexadecimal()))
}

pub fn serialize_biguint<S: Serializer>(value: &BigUint, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&format!("0x{value:x}"))
}

pub fn deserialize_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let wire = String::deserialize(deserializer)?;
    if let Some(value) = wire.strip_prefix("00") {
        return Ok(format!("0{value}"));
    }
    // Any other leading `0`, including a lone "0", is a non-text encoding.
    if wire.starts_with('0') {
        return Err(D::Error::custom("expected a JSON0 literal string"));
    }
    Ok(wire)
}

pub fn deserialize_text_map<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<std::collections::BTreeMap<String, String>, D::Error> {
    #[derive(Deserialize)]
    struct Text(#[serde(deserialize_with = "deserialize_text")] String);
    let values = std::collections::BTreeMap::<String, Text>::deserialize(deserializer)?;
    Ok(values
        .into_iter()
        .map(|(key, value)| (key, value.0))
        .collect())
}

pub fn serialize_text_map<S: Serializer>(
    values: &std::collections::BTreeMap<String, String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    #[derive(serde::Serialize)]
    struct Text<'a>(#[serde(serialize_with = "serialize_text")] &'a str);
    let mut map = serializer.serialize_map(Some(values.len()))?;
    for (key, value) in values {
        map.serialize_entry(key, &Text(value))?;
    }
    map.end()
}

pub fn deserialize_viewpoint<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Viewpoint, D::Error> {
    let wire = String::deserialize(deserializer)?;
    let hex = wire
        .strip_prefix("0x")
        .filter(|hex| !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| D::Error::custom("viewpoint must be a nonnegative JSON0 bigint"))?;
    let integer = BigUint::parse_bytes(hex.as_bytes(), 16)
        .ok_or_else(|| D::Error::custom("invalid viewpoint"))?;
    Viewpoint::parse(&integer.to_str_radix(10)).map_err(D::Error::custom)
}

pub fn deserialize_bytes<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    let wire = String::deserialize(deserializer)?;
    let alphabet = match wire.get(..2) {
        Some("0*") => &URL_SAFE,
        Some("0%") => &STANDARD,
        _ => return Err(D::Error::custom("sha384 must be JSON0 bytes")),
    };
    decode_base64(&wire[2..], alphabet).map_err(D::Error::custom)
}

/// JSON0 base64: `=` padding is optional but, when present, exact; whitespace
/// and nonzero unused bits are rejected.
fn decode_base64(payload: &str, alphabet: &base64::alphabet::Alphabet) -> anyhow::Result<Vec<u8>> {
    use base64::Engine;
    anyhow::ensure!(
        !payload.contains('=') || payload.len().is_multiple_of(4),
        "inexact base64 padding"
    );
    let config =
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent);
    Ok(GeneralPurpose::new(alphabet, config).decode(payload)?)
}

/// One JSON0 string value, decoded (the oracle's view; decimal reals aside).
#[derive(Debug, PartialEq, Eq)]
pub enum Scalar {
    Text(String),
    BigInt(num_bigint::BigInt),
    Bytes(Vec<u8>),
    WellKnownSymbol(String),
    GlobalSymbol(String),
}

const WELL_KNOWN: [&str; 4] = ["asyncIterator", "iterator", "species", "unscopables"];

pub fn encode_scalar(value: &Scalar) -> anyhow::Result<String> {
    use base64::Engine;
    Ok(match value {
        Scalar::Text(text) if text.starts_with('0') => format!("0{text}"),
        Scalar::Text(text) => text.clone(),
        Scalar::BigInt(n) if n.sign() == num_bigint::Sign::Minus => format!("0~{:x}", -n - 1),
        Scalar::BigInt(n) => format!("0x{n:x}"),
        Scalar::Bytes(bytes) => format!(
            "0*{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        ),
        Scalar::WellKnownSymbol(name) => {
            anyhow::ensure!(
                WELL_KNOWN.contains(&name.as_str()),
                "unsupported well-known symbol"
            );
            format!("0#{name}")
        }
        Scalar::GlobalSymbol(name) => format!("0${name}"),
    })
}

pub fn decode_scalar(wire: &str) -> anyhow::Result<Scalar> {
    use anyhow::{bail, ensure};
    let Some(rest) = wire.strip_prefix('0') else {
        return Ok(Scalar::Text(wire.to_owned()));
    };
    let mut chars = rest.chars();
    let Some(prefix) = chars.next() else {
        bail!("a lone 0 is not a JSON0 string")
    };
    let payload = chars.as_str();
    let hex = |text: &str| -> anyhow::Result<num_bigint::BigInt> {
        ensure!(
            !text.is_empty() && text.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid JSON0 hexadecimal"
        );
        Ok(num_bigint::BigInt::parse_bytes(text.as_bytes(), 16).expect("checked hex"))
    };
    Ok(match prefix {
        '0' => Scalar::Text(rest.to_owned()),
        'x' => Scalar::BigInt(hex(payload)?),
        '~' => Scalar::BigInt(-hex(payload)? - 1),
        '*' => Scalar::Bytes(decode_base64(payload, &URL_SAFE)?),
        '%' => Scalar::Bytes(decode_base64(payload, &STANDARD)?),
        '#' => {
            ensure!(
                WELL_KNOWN.contains(&payload),
                "unsupported well-known symbol"
            );
            Scalar::WellKnownSymbol(payload.to_owned())
        }
        '$' => Scalar::GlobalSymbol(payload.to_owned()),
        '.' => bail!("JSON0 decimal reals are not supported here"),
        _ => bail!("reserved or invalid JSON0 prefix"),
    })
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Text(
        #[serde(
            serialize_with = "super::serialize_text",
            deserialize_with = "super::deserialize_text"
        )]
        String,
    );

    #[test]
    fn literal_zero_strings_gain_a_zero_and_a_lone_zero_is_rejected() {
        for (value, wire) in [
            ("0", "\"00\""),
            ("00", "\"000\""),
            ("0x1", "\"00x1\""),
            ("", "\"\""),
            ("a0", "\"a0\""),
        ] {
            assert_eq!(serde_json::to_string(&Text(value.into())).unwrap(), wire);
            assert_eq!(
                serde_json::from_str::<Text>(wire).unwrap(),
                Text(value.into())
            );
        }
        for invalid in ["\"0\"", "\"0x1\"", "\"0z\""] {
            assert!(serde_json::from_str::<Text>(invalid).is_err(), "{invalid}");
        }
    }

    /// Scalars shared with the TypeScript client and the clean-room oracle.
    #[test]
    fn shared_vectors() {
        use super::{Scalar, decode_scalar, encode_scalar};
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../tests/vectors/json0.json")).unwrap();
        let pairs = |field: &str| {
            v[field]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| (p[0].clone(), p[1].as_str().unwrap().to_owned()))
                .collect::<Vec<_>>()
        };
        for (field, make) in [
            (
                "text",
                (|x: &serde_json::Value| Scalar::Text(x.as_str().unwrap().into()))
                    as fn(&serde_json::Value) -> Scalar,
            ),
            ("bigint", |x| {
                Scalar::BigInt(x.as_str().unwrap().parse().unwrap())
            }),
            ("bytes", |x| {
                Scalar::Bytes(serde_json::from_value(x.clone()).unwrap())
            }),
            ("wellKnownSymbol", |x| {
                Scalar::WellKnownSymbol(x.as_str().unwrap().into())
            }),
            ("globalSymbol", |x| {
                Scalar::GlobalSymbol(x.as_str().unwrap().into())
            }),
        ] {
            for (value, wire) in pairs(field) {
                assert_eq!(encode_scalar(&make(&value)).unwrap(), wire);
                assert_eq!(decode_scalar(&wire).unwrap(), make(&value), "{wire}");
            }
        }
        for case in v["decodeOnly"].as_array().unwrap() {
            let (wire, want) = (case[0].as_str().unwrap(), &case[1]);
            let got = decode_scalar(wire).unwrap();
            let expected = if let Some(n) = want["bigint"].as_str() {
                Scalar::BigInt(n.parse().unwrap())
            } else {
                Scalar::Bytes(serde_json::from_value(want["bytes"].clone()).unwrap())
            };
            assert_eq!(got, expected, "{wire}");
        }
        for wire in v["invalid"].as_array().unwrap() {
            assert!(decode_scalar(wire.as_str().unwrap()).is_err(), "{wire}");
        }
        for name in v["unsupportedWellKnownSymbols"].as_array().unwrap() {
            assert!(
                encode_scalar(&Scalar::WellKnownSymbol(name.as_str().unwrap().into())).is_err()
            );
        }
    }
}
