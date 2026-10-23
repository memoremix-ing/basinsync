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
    matches!(
        name,
        "asyncIterator" | "iterator" | "species" | "unscopables"
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn extension_prefixes_and_wire_vectors() {
        for (value, wire) in [
            (0, vec![2, b'x', 0, 2, 48, 1]),
            (-1, vec![2, b'~', 0, 2, 48, 1]),
            (-257, vec![3, b'~', 1, 0, 3, 48, 1]),
        ] {
            let extension = Extension::BigInt(value.into());
            assert_eq!(encode(&extension).unwrap(), wire);
            assert_eq!(
                read(Reader::get_root(wire.as_slice()).unwrap()).unwrap(),
                extension
            );
        }
        for extension in [
            Extension::WellKnownSymbol("species".into()),
            Extension::GlobalSymbol("".into()),
            Extension::GlobalSymbol("shared 🌎".repeat(100)),
        ] {
            let wire = encode(&extension).unwrap();
            assert_eq!(
                read(Reader::get_root(wire.as_slice()).unwrap()).unwrap(),
                extension
            );
        }
        for wire in [
            vec![2, b'X', 0, 2, 48, 1],
            vec![1, b'~', 1, 48, 1],
            vec![3, b'x', 0, 1, 3, 48, 1],
            vec![2, b'$', 255, 2, 48, 1],
            vec![2, 0, b'x', 0, 0, 1, 4, 49, 1],
        ] {
            assert!(read(Reader::get_root(wire.as_slice()).unwrap()).is_err());
        }
        assert!(
            Extension::WellKnownSymbol("dispose".into())
                .payload()
                .is_err()
        );
    }

    #[test]
    fn vector_length_and_root_offset_width_boundaries() {
        for length in [1, 2, 3, 4, 254, 255, 256, 32767, 32768, 65535, 65536] {
            let extension = Extension::GlobalSymbol("x".repeat(length));
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
