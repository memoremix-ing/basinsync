//! JSON0 scalar adapters at the HTTP boundary.
use crate::lexidecimal::Viewpoint;
use base64::{
    Engine,
    alphabet::{STANDARD, URL_SAFE},
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use num_bigint::BigUint;
use serde::{Deserialize, Deserializer, Serializer, de::Error};

pub fn serialize_text<S: Serializer>(value: &str, serializer: S) -> Result<S::Ok, S::Error> {
    if value.starts_with('0') && value.len() > 1 {
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

pub fn deserialize_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let wire = String::deserialize(deserializer)?;
    if let Some(value) = wire.strip_prefix("00") {
        return Ok(format!("0{value}"));
    }
    if wire.starts_with('0') && wire.len() > 1 {
        return Err(D::Error::custom("flow must be a JSON0 string"));
    }
    Ok(wire)
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
