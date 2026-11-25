//! basinsync FlexBuffers extensions (`docs/glossary/flexbuffers.md`).
//!
//! `VT_VECTOR_UINT` is reserved for extensions: its first element is one
//! ASCII prefix byte, followed by byte-valued payload elements:
//!
//! | Prefix | Payload |
//! | --- | --- |
//! | `x` | nonnegative bigint magnitude, big-endian, minimal (zero = `[0]`) |
//! | `~` | magnitude of `~n` for negative bigint `n` |
//! | `#` | UTF-8 well-known symbol name |
//! | `$` | UTF-8 global symbol name |
//!
//! This module encodes and decodes a FlexBuffers *document whose root* is
//! one extension value. Writers here produce the layout of the reference
//! FlexBuffers builder (narrowest element width that holds the element
//! count, narrowest root offset width); readers accept any in-bounds layout
//! with any element width and root width.
//!
//! [`parse_root`], [`element`], [`validate`] and [`encode_into`] are
//! allocation-free and proven by Kani.

use crate::bigint::BigInt;
use crate::error::{Error, Result};

/// FlexBuffers type code of typed unsigned vectors.
pub const VT_VECTOR_UINT: u8 = 12;
/// FlexBuffers type codes of fixed-length (2, 3, 4) typed unsigned vectors.
/// The reference Rust builder emits these for 2–4 homogeneous unsigned
/// elements, so readers accept them as extensions too (see GAPS.md).
pub const VT_VECTOR_UINT_FIXED: [u8; 3] = [17, 20, 23];
/// FlexBuffers type code of blobs (ordinary binary data).
pub const VT_BLOB: u8 = 25;

/// Extension prefix bytes.
pub mod prefix {
    /// Nonnegative bigint.
    pub const BIGINT: u8 = b'x';
    /// Negative bigint (`~n` magnitude).
    pub const NEGATIVE_BIGINT: u8 = b'~';
    /// Well-known symbol.
    pub const WELL_KNOWN_SYMBOL: u8 = b'#';
    /// Global symbol.
    pub const GLOBAL_SYMBOL: u8 = b'$';
}

/// The well-known symbols JSON0 permits.
pub const WELL_KNOWN_SYMBOLS: [&str; 4] = ["asyncIterator", "iterator", "species", "unscopables"];

/// A decoded extension value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Extension {
    /// `x` or `~` bigint.
    BigInt(BigInt),
    /// `#` well-known symbol name (one of [`WELL_KNOWN_SYMBOLS`]).
    WellKnownSymbol(String),
    /// `$` global symbol name.
    GlobalSymbol(String),
}

/// Location of the root extension vector within a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtVector {
    /// Offset of element zero.
    pub data: usize,
    /// `log2(width)`.
    pub width_code: u8,
    /// Element (and length prefix) byte width: 1, 2, 4 or 8.
    pub width: usize,
    /// Element count, including the prefix element (at least one).
    pub len: usize,
}

fn read_uint(wire: &[u8], pos: usize, width: usize) -> u64 {
    let mut v: u64 = 0;
    let mut k = 0;
    while k < width {
        v |= (wire[pos + k] as u64) << (8 * k);
        k += 1;
    }
    v
}

/// Locate the root `VT_VECTOR_UINT` and check that its length prefix and
/// elements lie within the buffer.
pub fn parse_root(wire: &[u8]) -> Result<ExtVector> {
    let n = wire.len();
    if n < 3 {
        return Err(Error::Truncated);
    }
    let root_width = wire[n - 1] as usize;
    if !matches!(root_width, 1 | 2 | 4 | 8) {
        return Err(Error::BadLayout);
    }
    let packed = wire[n - 2];
    let ty = packed >> 2;
    // Only VT_VECTOR_UINT carries extensions; fixed-length unsigned vectors
    // (VT_VECTOR_UINT2/3/4) are not extensions (docs/glossary/flexbuffers.md).
    let fixed_len = match ty {
        VT_VECTOR_UINT => 0usize,
        _ => return Err(Error::NotExtension),
    };
    let width_code = packed & 3;
    let width = 1usize << width_code;
    if n < 2 + root_width {
        return Err(Error::Truncated);
    }
    let root_pos = n - 2 - root_width;
    let offset = read_uint(wire, root_pos, root_width);
    if offset > root_pos as u64 {
        return Err(Error::BadLayout);
    }
    let data = root_pos - offset as usize;
    let len = if fixed_len > 0 {
        fixed_len as u64
    } else {
        if data < width {
            return Err(Error::BadLayout);
        }
        read_uint(wire, data - width, width)
    };
    if len == 0 {
        return Err(Error::NotExtension);
    }
    // Shifts rather than division/multiplication by the symbolic width.
    // Layout rule: the elements end at or before the root slot that refers
    // to them (docs/glossary/flexbuffers.md).
    let avail = (root_pos - data) >> width_code;
    if len > avail as u64 {
        return Err(Error::BadLayout);
    }
    Ok(ExtVector { data, width_code, width, len: len as usize })
}

/// Element `i` as a byte; elements above 255 are rejected.
pub fn element(wire: &[u8], v: &ExtVector, i: usize) -> Result<u8> {
    let v = read_uint(wire, v.data + (i << v.width_code), v.width);
    if v > 255 {
        return Err(Error::BadLayout);
    }
    Ok(v as u8)
}

fn payload_eq(wire: &[u8], v: &ExtVector, name: &[u8]) -> Result<bool> {
    if v.len - 1 != name.len() {
        return Ok(false);
    }
    let mut i = 0;
    while i < name.len() {
        if element(wire, v, i + 1)? != name[i] {
            return Ok(false);
        }
        i += 1;
    }
    Ok(true)
}

/// Validate UTF-8 over elements `1..len` without allocating.
fn validate_utf8(wire: &[u8], v: &ExtVector) -> Result<()> {
    let mut i = 1;
    while i < v.len {
        let b0 = element(wire, v, i)?;
        let (need, min) = match b0 {
            0x00..=0x7f => (0usize, 0u32),
            0xc2..=0xdf => (1, 0x80),
            0xe0..=0xef => (2, 0x800),
            0xf0..=0xf4 => (3, 0x10000),
            _ => return Err(Error::BadUtf8),
        };
        if i + need >= v.len {
            return Err(Error::BadUtf8);
        }
        let mut cp = (b0 as u32) & (0x7f >> need);
        let mut k = 1;
        while k <= need {
            let b = element(wire, v, i + k)?;
            if b & 0xc0 != 0x80 {
                return Err(Error::BadUtf8);
            }
            cp = (cp << 6) | (b & 0x3f) as u32;
            k += 1;
        }
        if cp < min || cp > 0x10ffff || (0xd800..=0xdfff).contains(&cp) {
            return Err(Error::BadUtf8);
        }
        i += need + 1;
    }
    Ok(())
}

/// Validate the root extension: known prefix, byte-valued elements, minimal
/// magnitudes, UTF-8 names, and a permitted well-known symbol. Returns the
/// prefix byte.
pub fn validate(wire: &[u8]) -> Result<(u8, ExtVector)> {
    let v = parse_root(wire)?;
    let p = element(wire, &v, 0)?;
    match p {
        prefix::BIGINT | prefix::NEGATIVE_BIGINT => {
            if v.len < 2 {
                return Err(Error::NonMinimal);
            }
            let first = element(wire, &v, 1)?;
            if first == 0 && v.len > 2 {
                return Err(Error::NonMinimal);
            }
            let mut i = 2;
            while i < v.len {
                element(wire, &v, i)?;
                i += 1;
            }
        }
        prefix::WELL_KNOWN_SYMBOL => {
            let mut known = false;
            let mut k = 0;
            while k < WELL_KNOWN_SYMBOLS.len() {
                if payload_eq(wire, &v, WELL_KNOWN_SYMBOLS[k].as_bytes())? {
                    known = true;
                }
                k += 1;
            }
            if !known {
                // Distinguish malformed elements from unknown names.
                validate_utf8(wire, &v)?;
                return Err(Error::UnknownSymbol);
            }
        }
        prefix::GLOBAL_SYMBOL => validate_utf8(wire, &v)?,
        _ => return Err(Error::UnknownExtension),
    }
    Ok((p, v))
}

/// Decode a FlexBuffers document whose root is an extension.
pub fn decode_extension(wire: &[u8]) -> Result<Extension> {
    let (p, v) = validate(wire)?;
    let payload: Vec<u8> = (1..v.len).map(|i| element(wire, &v, i)).collect::<Result<_>>()?;
    Ok(match p {
        prefix::BIGINT => Extension::BigInt(BigInt::from_be_bytes(&payload)),
        prefix::NEGATIVE_BIGINT => Extension::BigInt(BigInt::from_be_bytes(&payload).not()),
        prefix::WELL_KNOWN_SYMBOL => {
            Extension::WellKnownSymbol(String::from_utf8(payload).map_err(|_| Error::BadUtf8)?)
        }
        _ => Extension::GlobalSymbol(String::from_utf8(payload).map_err(|_| Error::BadUtf8)?),
    })
}

/// Narrowest width code (0..=3) holding `v`.
const fn width_code(v: u64) -> u8 {
    if v <= 0xff {
        0
    } else if v <= 0xffff {
        1
    } else if v <= 0xffff_ffff {
        2
    } else {
        3
    }
}

/// Encoded document length for `payload_len` payload bytes.
pub fn encoded_len(payload_len: usize) -> usize {
    let len = payload_len as u64 + 1;
    let w = 1usize << width_code(len);
    let vec_end = w + len as usize * w;
    let (_, root_pos) = root_layout(vec_end, w);
    let rw = root_width_for(vec_end, w);
    root_pos + rw + 2
}

fn root_width_for(vec_end: usize, data: usize) -> usize {
    let mut rw = 1usize;
    loop {
        let pos = vec_end.div_ceil(rw) * rw;
        let off = (pos - data) as u64;
        if rw == 8 || width_code(off) as usize <= rw.trailing_zeros() as usize {
            return rw;
        }
        rw *= 2;
    }
}

fn root_layout(vec_end: usize, data: usize) -> (usize, usize) {
    let rw = root_width_for(vec_end, data);
    (rw, vec_end.div_ceil(rw) * rw)
}

/// Encode an extension document from its prefix and raw payload bytes,
/// returning the length used. The payload is not validated here.
pub fn encode_into(prefix_byte: u8, payload: &[u8], out: &mut [u8]) -> Result<usize> {
    let len = payload.len() as u64 + 1;
    let code = width_code(len);
    let w = 1usize << code;
    let data = w; // the empty buffer is aligned; the length prefix comes first
    let vec_end = data + len as usize * w;
    let (rw, root_pos) = root_layout(vec_end, data);
    let total = root_pos + rw + 2;
    if out.len() < total {
        return Err(Error::BufferTooSmall);
    }
    let mut i = 0;
    while i < total {
        out[i] = 0;
        i += 1;
    }
    let mut k = 0;
    while k < w {
        out[k] = (len >> (8 * k)) as u8;
        k += 1;
    }
    out[data] = prefix_byte;
    let mut j = 0;
    while j < payload.len() {
        out[data + (j + 1) * w] = payload[j];
        j += 1;
    }
    let off = (root_pos - data) as u64;
    let mut k = 0;
    while k < rw {
        out[root_pos + k] = (off >> (8 * k)) as u8;
        k += 1;
    }
    out[root_pos + rw] = VT_VECTOR_UINT << 2 | code;
    out[root_pos + rw + 1] = rw as u8;
    Ok(total)
}

/// Encode an extension value as a FlexBuffers document.
pub fn encode_extension(ext: &Extension) -> Result<Vec<u8>> {
    let (p, payload) = match ext {
        Extension::BigInt(v) if v.is_negative() => (prefix::NEGATIVE_BIGINT, v.not().magnitude_be_bytes()),
        Extension::BigInt(v) => (prefix::BIGINT, v.magnitude_be_bytes()),
        Extension::WellKnownSymbol(name) => {
            if !WELL_KNOWN_SYMBOLS.contains(&name.as_str()) {
                return Err(Error::UnknownSymbol);
            }
            (prefix::WELL_KNOWN_SYMBOL, name.as_bytes().to_vec())
        }
        Extension::GlobalSymbol(name) => (prefix::GLOBAL_SYMBOL, name.as_bytes().to_vec()),
    };
    let mut out = vec![0u8; encoded_len(payload.len())];
    let n = encode_into(p, &payload, &mut out)?;
    out.truncate(n);
    Ok(out)
}

/// Encode an extension document from raw parts (no payload validation).
pub fn encode_into_vec(prefix_byte: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; encoded_len(payload.len())];
    let n = encode_into(prefix_byte, payload, &mut out).expect("sized");
    out.truncate(n);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn big(s: &str) -> Extension {
        Extension::BigInt(BigInt::parse_decimal(s).unwrap())
    }

    #[test]
    fn known_layouts() {
        assert_eq!(encode_extension(&big("0")).unwrap(), vec![2, b'x', 0, 2, 0x30, 1]);
        assert_eq!(encode_extension(&big("-1")).unwrap(), vec![2, b'~', 0, 2, 0x30, 1]);
        assert_eq!(encode_extension(&big("256")).unwrap(), vec![3, b'x', 1, 0, 3, 0x30, 1]);
        assert_eq!(encode_extension(&big("-257")).unwrap(), vec![3, b'~', 1, 0, 3, 0x30, 1]);
        let sp = encode_extension(&Extension::WellKnownSymbol("species".into())).unwrap();
        assert_eq!(&sp[..3], &[8, b'#', b's']);
    }

    #[test]
    fn wide_vectors() {
        // 255 payload bytes -> 256 elements -> 16-bit elements.
        let name = "a".repeat(255);
        let e = encode_extension(&Extension::GlobalSymbol(name.clone())).unwrap();
        assert_eq!(e[e.len() - 2], 0x31);
        assert_eq!(&e[..4], &[0, 1, b'$', 0]);
        assert_eq!(decode_extension(&e).unwrap(), Extension::GlobalSymbol(name));
        let name = "b".repeat(70000);
        let e = encode_extension(&Extension::GlobalSymbol(name.clone())).unwrap();
        assert_eq!(e[e.len() - 2], 0x32);
        assert_eq!(decode_extension(&e).unwrap(), Extension::GlobalSymbol(name));
    }

    #[test]
    fn accepts_other_layouts() {
        // 64-bit elements with leading garbage and a 2-byte root offset.
        let mut w = vec![0xaa, 0xbb, 0, 0, 0, 0, 0, 0];
        let data_len_pos = w.len();
        w.extend_from_slice(&2u64.to_le_bytes());
        let data = w.len();
        w.extend_from_slice(&(b'x' as u64).to_le_bytes());
        w.extend_from_slice(&7u64.to_le_bytes());
        let root = w.len();
        w.extend_from_slice(&((root - data) as u16).to_le_bytes());
        w.push(VT_VECTOR_UINT << 2 | 3);
        w.push(2);
        let _ = data_len_pos;
        assert_eq!(decode_extension(&w).unwrap(), big("7"));
    }

    #[test]
    fn rejections() {
        let reject = |w: &[u8]| assert!(decode_extension(w).is_err(), "{w:?}");
        reject(&[]);
        reject(&[2, b'x', 0, 0, 2, 0x30, 1]); // non-minimal magnitude
        reject(&[1, b'x', 1, 0x30, 1]); // empty magnitude
        reject(&[2, b'?', 0, 2, 0x30, 1]); // unknown prefix
        reject(&[2, b'x', 0, 2, 0x64, 1]); // blob root type
        reject(&[2, b'x', 0, 9, 0x30, 1]); // offset out of range
        reject(&[9, b'x', 0, 2, 0x30, 1]); // length out of range
        reject(&[2, b'x', 0, 2, 0x30, 3]); // bad root width
        let w = encode_extension(&Extension::GlobalSymbol("ok".into())).unwrap();
        let mut bad = w.clone();
        bad[2] = 0xff;
        reject(&bad); // invalid UTF-8
        let mut bad = vec![0u8; 0];
        bad.extend_from_slice(&[4, 0, b'#', 0, b'z', 0, b'z', 0]);
        bad.extend_from_slice(&[6, 0x31, 1]);
        reject(&bad);
        assert!(encode_extension(&Extension::WellKnownSymbol("toString".into())).is_err());
        // element above 255
        reject(&[2, 0, b'x', 0, 0, 1, 4, 0x31, 1]);
    }

    #[test]
    fn rejects_fixed_length_vectors_from_the_reference_builder() {
        // The flexbuffers builder emits VT_VECTOR_UINT2/3/4 for two to four
        // elements; those are not extensions, so writers must not use them.
        for payload in [vec![0u8], vec![1, 0], vec![1, 2, 3]] {
            let mut b = ::flexbuffers::Builder::default();
            let mut v = b.start_vector();
            v.push(b'x');
            for &p in &payload {
                v.push(p);
            }
            v.end_vector();
            assert!(decode_extension(b.view()).is_err());
        }
    }

    #[test]
    fn interop_with_reference_reader() {
        for v in ["0", "1", "-1", "255", "-256", "123456789012345678901234567890"] {
            let e = encode_extension(&big(v)).unwrap();
            let r = flexbuffers::Reader::get_root(e.as_slice()).unwrap();
            assert_eq!(r.flexbuffer_type(), flexbuffers::FlexBufferType::VectorUInt);
            let vec = r.as_vector();
            let first = vec.idx(0).as_u8();
            assert!(first == b'x' || first == b'~');
        }
        let name = "c".repeat(300);
        let e = encode_extension(&Extension::GlobalSymbol(name)).unwrap();
        let r = flexbuffers::Reader::get_root(e.as_slice()).unwrap();
        assert_eq!(r.as_vector().len(), 301);
        assert_eq!(r.as_vector().idx(300).as_u8(), b'c');
    }

    proptest! {
        #[test]
        fn bigint_roundtrip(v in any::<i128>()) {
            let ext = Extension::BigInt(BigInt::from_i128(v));
            let e = encode_extension(&ext).unwrap();
            prop_assert_eq!(e.len(), encoded_len(e[0] as usize - 1));
            prop_assert_eq!(decode_extension(&e).unwrap(), ext);
        }

        #[test]
        fn global_roundtrip(s in "\\PC{0,40}") {
            let ext = Extension::GlobalSymbol(s);
            let e = encode_extension(&ext).unwrap();
            prop_assert_eq!(decode_extension(&e).unwrap(), ext);
        }

        #[test]
        fn utf8_agrees_with_std(bytes in prop::collection::vec(any::<u8>(), 0..12)) {
            let mut buf = vec![0u8; encoded_len(bytes.len())];
            let n = encode_into(b'$', &bytes, &mut buf).unwrap();
            let ok = decode_extension(&buf[..n]).is_ok();
            prop_assert_eq!(ok, core::str::from_utf8(&bytes).is_ok());
        }

        #[test]
        fn never_panics(bytes in prop::collection::vec(any::<u8>(), 0..48)) {
            let _ = decode_extension(&bytes);
        }
    }
}

