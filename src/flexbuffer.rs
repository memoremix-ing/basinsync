//! Basinsync's reserved VectorUInt extension payloads.
use anyhow::{Context, Result, bail, ensure};
use flexbuffers::{FlexBufferType, Reader};
use num_bigint::{BigInt, Sign};

/// Parse a stored FlexBuffers document after checking its layout: every value
/// an offset refers to, with its length prefix or map header, lies inside the
/// buffer and ends at or before the slot holding that offset. Offsets therefore
/// point backward, and no value overlaps a slot that refers to it or the root
/// trailer. Widths, ordering, sharing, and unreferenced padding stay free.
pub fn root(bytes: &[u8]) -> Result<Reader<&[u8]>> {
    check_layout(bytes)?;
    Ok(Reader::get_root(bytes)?)
}

pub fn check_layout(bytes: &[u8]) -> Result<()> {
    ensure!(bytes.len() >= 3, "FlexBuffers document is too short");
    let width = usize::from(bytes[bytes.len() - 1]);
    ensure!(
        matches!(width, 1 | 2 | 4 | 8),
        "invalid FlexBuffers root width"
    );
    let slot = bytes
        .len()
        .checked_sub(2 + width)
        .context("FlexBuffers root does not fit")?;
    let mut walk = Layout {
        bytes,
        visits: 0,
        seen: Default::default(),
    };
    walk.value(slot, width, bytes[bytes.len() - 2], 0)
}

struct Layout<'a> {
    bytes: &'a [u8],
    visits: usize,
    seen: std::collections::HashSet<(usize, u8)>,
}

impl Layout<'_> {
    fn uint(&self, at: usize, width: usize) -> Result<usize> {
        let end = at
            .checked_add(width)
            .context("FlexBuffers offset overflow")?;
        let bytes = self
            .bytes
            .get(at..end)
            .context("FlexBuffers read out of bounds")?;
        let mut word = [0u8; 8];
        word[..width].copy_from_slice(bytes);
        usize::try_from(u64::from_le_bytes(word)).context("FlexBuffers value too large")
    }
    /// A referenced byte range must end at or before the slot referring to it.
    fn range(slot: usize, start: usize, len: usize) -> Result<()> {
        let end = start
            .checked_add(len)
            .context("FlexBuffers range overflow")?;
        ensure!(
            end <= slot,
            "FlexBuffers value overlaps the slot that refers to it"
        );
        Ok(())
    }
    fn value(&mut self, slot: usize, slot_width: usize, packed: u8, depth: usize) -> Result<()> {
        ensure!(depth <= 128, "FlexBuffers nesting is too deep");
        let kind = packed >> 2;
        let width = 1usize << (packed & 3);
        // Inline scalars: null, int, uint, float, bool.
        if matches!(kind, 0..=3 | 26) {
            return Ok(());
        }
        let offset = self.uint(slot, slot_width)?;
        let target = slot
            .checked_sub(offset)
            .context("FlexBuffers offset before the buffer")?;
        if !self.seen.insert((target, packed)) {
            return Ok(()); // shared values were already checked
        }
        self.visits += 1;
        ensure!(
            self.visits <= 4 * self.bytes.len() + 16,
            "FlexBuffers document has too many references"
        );
        let prefixed = |walk: &Self| -> Result<usize> {
            let at = target
                .checked_sub(width)
                .context("FlexBuffers length before the buffer")?;
            walk.uint(at, width)
        };
        match kind {
            4 => {
                // Key: NUL-terminated bytes.
                let end = self.bytes[target..slot]
                    .iter()
                    .position(|&b| b == 0)
                    .context("FlexBuffers key is unterminated before its slot")?;
                Self::range(slot, target, end + 1)
            }
            5 | 25 => {
                let len = prefixed(self)?;
                Self::range(slot, target - width, width + len + usize::from(kind == 5))
            }
            6..=8 => Self::range(slot, target, width),
            9 | 10 => {
                let len = prefixed(self)?;
                let elements = len
                    .checked_mul(width)
                    .context("FlexBuffers length overflow")?;
                Self::range(slot, target - width, width + elements + len)?;
                if kind == 9 {
                    Self::range(
                        slot,
                        target
                            .checked_sub(3 * width)
                            .context("FlexBuffers map header before the buffer")?,
                        3 * width,
                    )?;
                }
                for i in 0..len {
                    let child = self.bytes[target + elements + i];
                    self.value(target + i * width, width, child, depth + 1)?;
                }
                if kind == 9 {
                    let keys_at = target
                        .checked_sub(3 * width)
                        .context("FlexBuffers map header before the buffer")?;
                    let keys_width = self.uint(keys_at + width, width)?;
                    ensure!(
                        matches!(keys_width, 1 | 2 | 4 | 8),
                        "invalid FlexBuffers key width"
                    );
                    let keys_packed = (14 << 2) | keys_width.trailing_zeros() as u8;
                    self.value(keys_at, width, keys_packed, depth + 1)?;
                }
                Ok(())
            }
            11..=15 | 36 => {
                let len = prefixed(self)?;
                let elements = len
                    .checked_mul(width)
                    .context("FlexBuffers length overflow")?;
                Self::range(slot, target - width, width + elements)?;
                // Key vectors (and the deprecated string vectors) hold offsets.
                let child = match kind {
                    14 => Some(4u8),
                    15 => Some(5u8),
                    _ => None,
                };
                if let Some(child) = child {
                    for i in 0..len {
                        self.value(
                            target + i * width,
                            width,
                            (child << 2) | (packed & 3),
                            depth + 1,
                        )?;
                    }
                }
                Ok(())
            }
            16..=24 => Self::range(slot, target, (2 + usize::from((kind - 16) / 3)) * width),
            _ => bail!("unknown FlexBuffers type {kind}"),
        }
    }
}

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
        overlapping_layouts: Vec<Vec<u8>>,
        fixed_length_vectors: Vec<Vec<u8>>,
        unsupported_well_known_symbols: Vec<String>,
    }

    fn decoded(wire: &[u8]) -> Option<Extension> {
        read(root(wire).ok()?).ok()
    }

    #[test]
    fn overlapping_layouts_are_rejected_though_plain_readers_accept_them() {
        let vectors: Vectors =
            serde_json::from_str(include_str!("../tests/vectors/flexbuffer.json")).unwrap();
        assert!(!vectors.overlapping_layouts.is_empty());
        for wire in &vectors.overlapping_layouts {
            assert!(
                read(Reader::get_root(wire.as_slice()).unwrap()).is_ok(),
                "{wire:?}"
            );
            assert_eq!(decoded(wire), None, "{wire:?}");
        }
    }

    proptest! {
        /// Writers place every value before the root trailer, so their output passes.
        #[test]
        fn writer_output_passes_the_layout_check(
            values in proptest::collection::vec((any::<i64>(), ".{0,12}", proptest::collection::vec(any::<u8>(), 0..20)), 0..12),
            keys in proptest::collection::btree_map("[a-z]{1,6}", any::<u32>(), 0..8),
        ) {
            let bytes = flexbuffers::to_vec((&values, &keys, serde_bytes::Bytes::new(b"blob"))).unwrap();
            prop_assert!(check_layout(&bytes).is_ok());
        }
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
        for wire in vectors.invalid.iter().chain(&vectors.fixed_length_vectors) {
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
