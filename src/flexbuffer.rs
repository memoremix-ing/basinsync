//! Basinsync's reserved VectorUInt extension payloads.
use anyhow::{Context, Result, bail, ensure};
use flexbuffers::{FlexBufferType, Reader};
use num_bigint::{BigInt, Sign};

#[derive(Debug, PartialEq, Eq)]
pub enum Extension {
    BigInt(BigInt),
    WellKnownSymbol(String),
    GlobalSymbol(String),
}

impl Extension {
    pub fn payload(&self) -> Result<Vec<u8>> {
        Ok(match self {
            Self::BigInt(value) => {
                let negative = value.sign() == Sign::Minus;
                let magnitude = if negative { !value } else { value.clone() };
                let (_, mut magnitude) = magnitude.to_bytes_be();
                if magnitude.is_empty() {
                    magnitude.push(0);
                }
                let mut payload = vec![if negative { b'~' } else { b'x' }];
                payload.extend(magnitude);
                payload
            }
            Self::WellKnownSymbol(name) => {
                ensure!(well_known(name), "unknown well-known symbol");
                [b"#", name.as_bytes()].concat()
            }
            Self::GlobalSymbol(name) => [b"$", name.as_bytes()].concat(),
        })
    }
}

fn well_known(name: &str) -> bool {
    basinsync_structures::value::well_known(name)
}

pub fn read(reader: Reader<&[u8]>) -> Result<Extension> {
    ensure!(
        reader.flexbuffer_type() == FlexBufferType::VectorUInt,
        "extension must use VectorUInt"
    );
    let payload: Vec<u8> = reader
        .get_vector()?
        .iter()
        .map(|value| Ok(u8::try_from(value.get_u64()?)?))
        .collect::<Result<_>>()?;
    let (prefix, bytes) = payload.split_first().context("empty extension")?;
    match prefix {
        b'x' | b'~' => {
            ensure!(
                !bytes.is_empty() && (bytes.len() == 1 || bytes[0] != 0),
                "noncanonical bigint magnitude"
            );
            let integer = BigInt::from_bytes_be(Sign::Plus, bytes);
            Ok(Extension::BigInt(if *prefix == b'~' {
                !integer
            } else {
                integer
            }))
        }
        b'#' => {
            let name = std::str::from_utf8(bytes)?;
            ensure!(well_known(name), "unknown well-known symbol");
            Ok(Extension::WellKnownSymbol(name.into()))
        }
        b'$' => Ok(Extension::GlobalSymbol(std::str::from_utf8(bytes)?.into())),
        _ => bail!("unknown extension prefix"),
    }
}

/// Encode a standalone extension, keeping even short payloads in VectorUInt.
/// The upstream builder otherwise chooses fixed-length UInt2/3/4 vectors.
pub fn encode(extension: &Extension) -> Result<Vec<u8>> {
    let payload = extension.payload()?;
    let width = [1, 2, 4, 8]
        .into_iter()
        .find(|width| *width == 8 || (payload.len() as u64) < (1u64 << (width * 8)))
        .unwrap();
    let mut buffer = Vec::new();
    buffer.extend_from_slice(&(payload.len() as u64).to_le_bytes()[..width]);
    for byte in payload {
        buffer.extend_from_slice(&u64::from(byte).to_le_bytes()[..width]);
    }
    let root_width = [1, 2, 4, 8]
        .into_iter()
        .find(|root_width| {
            let root = buffer.len().next_multiple_of(*root_width);
            *root_width == 8 || ((root - width) as u64) < (1u64 << (root_width * 8))
        })
        .unwrap();
    buffer.resize(buffer.len().next_multiple_of(root_width), 0);
    let offset = buffer.len() - width;
    buffer.extend_from_slice(&(offset as u64).to_le_bytes()[..root_width]);
    buffer.push((FlexBufferType::VectorUInt as u8) << 2 | width.trailing_zeros() as u8);
    buffer.push(root_width as u8);
    Ok(buffer)
}

/// Reserve a typed UInt vector even when serde would choose UInt2/3/4.
pub fn bigint_payload(value: &num_bigint::BigUint) -> Result<Vec<u8>> {
    let mut payload = Extension::BigInt(value.clone().into()).payload()?;
    payload.resize(payload.len().max(5), 0);
    Ok(payload)
}

/// Serialize a command, then restore the reserved bigint vectors' true lengths.
pub fn command(
    path: &str,
    query: &impl serde::Serialize,
    fields: &[(&str, &num_bigint::BigUint)],
) -> Result<Vec<u8>> {
    let species = Extension::WellKnownSymbol("species".into()).payload()?;
    let mut bytes = flexbuffers::to_vec((species, crate::event::NAMESPACE, path, query))?;
    for (name, value) in fields {
        let length = Extension::BigInt((*value).clone().into()).payload()?.len();
        if length >= 5 {
            continue;
        }
        let map = Reader::get_root(bytes.as_slice())?
            .get_vector()?
            .index(3)?
            .get_map()?;
        let index = map
            .iter_keys()
            .position(|key| key == *name)
            .context("missing bigint field")?;
        let count = map.len();
        let uint = |at: usize, width: usize| -> usize {
            let mut word = [0u8; 8];
            word[..width].copy_from_slice(&bytes[at..at + width]);
            u64::from_le_bytes(word) as usize
        };
        let root_width = *bytes.last().unwrap() as usize;
        let slot = bytes.len() - 2 - root_width;
        let root = slot - uint(slot, root_width);
        let tuple_width = 1usize << (bytes[bytes.len() - 2] & 3);
        let slot = root + 3 * tuple_width;
        let query = slot - uint(slot, tuple_width);
        let width = 1usize << (bytes[root + 4 * tuple_width + 3] & 3);
        let slot = query + index * width;
        let vector = slot - uint(slot, width);
        let element_width = 1usize << (bytes[query + count * width + index] & 3);
        bytes[vector - element_width..vector]
            .copy_from_slice(&(length as u64).to_le_bytes()[..element_width]);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        extensions: Vec<serde_json::Map<String, serde_json::Value>>,
        invalid: Vec<Vec<u8>>,
        unsupported_well_known_symbols: Vec<String>,
    }

    fn decoded(wire: &[u8]) -> Option<Extension> {
        read(Reader::get_root(wire).ok()?).ok()
    }

    /// Extension wire vectors shared with the TypeScript client.
    #[test]
    fn shared_vectors() {
        let vectors: Vectors =
            serde_json::from_str(include_str!("../tests/vectors/flexbuffer.json")).unwrap();
        for vector in &vectors.extensions {
            let wire: Vec<u8> = serde_json::from_value(vector["wire"].clone()).unwrap();
            let text = |key: &str| vector.get(key).and_then(|v| v.as_str()).map(String::from);
            let extension = if let Some(n) = text("bigint") {
                Extension::BigInt(n.parse().unwrap())
            } else if let Some(name) = text("wellKnownSymbol") {
                Extension::WellKnownSymbol(name)
            } else {
                Extension::GlobalSymbol(text("globalSymbol").unwrap())
            };
            assert_eq!(encode(&extension).unwrap(), wire);
            assert_eq!(decoded(&wire), Some(extension));
        }
        for wire in &vectors.invalid {
            assert_eq!(decoded(wire), None, "{wire:?}");
        }
        for name in &vectors.unsupported_well_known_symbols {
            assert!(Extension::WellKnownSymbol(name.clone()).payload().is_err());
            let payload = [b"#", name.as_bytes()].concat();
            let length = payload.len() as u8;
            let wire = [&[length][..], &payload, &[length, 48, 1]].concat();
            assert_eq!(decoded(&wire), None, "{name}");
        }
    }

    #[test]
    fn vector_length_and_root_offset_width_boundaries() {
        for name in [1, 2, 3, 4, 254, 255, 256, 32767, 32768, 65535, 65536]
            .map(|length| "x".repeat(length))
            .into_iter()
            .chain(["shared 🌎".repeat(100)])
        {
            let extension = Extension::GlobalSymbol(name);
            let wire = encode(&extension).unwrap();
            assert_eq!(
                read(Reader::get_root(wire.as_slice()).unwrap()).unwrap(),
                extension
            );
        }
    }

    proptest! {
        #[test]
        fn arbitrary_bigints(bytes in prop::collection::vec(any::<u8>(), 0..512), negative in any::<bool>()) {
            let integer = BigInt::from_bytes_be(if negative {Sign::Minus} else {Sign::Plus}, &bytes);
            let extension = Extension::BigInt(integer);
            let wire = encode(&extension).unwrap();
            prop_assert_eq!(read(Reader::get_root(wire.as_slice()).unwrap()).unwrap(), extension);
        }
    }
}
