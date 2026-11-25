//! CRC32C (Castagnoli), cumulative and incremental (`docs/glossary/crc32c.md`).
//!
//! `append(crc, data)` continues a checksum exactly like the `crc32c`
//! crate's `crc32c_append`: the cumulative checksum of the empty run is
//! zero, and `append(append(0, a), b) == append(0, a ++ b)`.

/// Reflected Castagnoli polynomial.
pub const POLY: u32 = 0x82f6_3b78;

const fn make_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { (c >> 1) ^ POLY } else { c >> 1 };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
}

/// Byte-at-a-time lookup table.
pub static TABLE: [u32; 256] = make_table();

/// Continue checksum `crc` over `data`.
pub fn append(crc: u32, data: &[u8]) -> u32 {
    let mut c = !crc;
    for &b in data {
        c = TABLE[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    !c
}

/// Checksum of `data` from zero.
pub fn checksum(data: &[u8]) -> u32 {
    append(0, data)
}

/// Bit-at-a-time reference implementation (used by proofs and tests).
pub fn append_bitwise(crc: u32, data: &[u8]) -> u32 {
    let mut c = !crc;
    for &b in data {
        c ^= b as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { (c >> 1) ^ POLY } else { c >> 1 };
            k += 1;
        }
    }
    !c
}

/// Eight lowercase hexadecimal digits, as stored in S3 metadata.
pub fn to_hex(crc: u32) -> String {
    format!("{crc:08x}")
}

/// Parse exactly eight lowercase hexadecimal digits.
pub fn from_hex(text: &str) -> crate::Result<u32> {
    let t = text.as_bytes();
    if t.len() != 8 {
        return Err(crate::Error::LengthMismatch);
    }
    let mut v = 0u32;
    for &c in t {
        v = v << 4 | crate::hex::lower_digit_value(c).ok_or(crate::Error::BadDigit)? as u32;
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn vectors() {
        assert_eq!(checksum(b""), 0);
        assert_eq!(to_hex(checksum(b"")), "00000000");
        assert_eq!(checksum(b"123456789"), 0xe306_9283);
        assert_eq!(checksum(&[0u8; 32]), 0x8a91_36aa);
        assert_eq!(from_hex("e3069283").unwrap(), 0xe306_9283);
        assert!(from_hex("E3069283").is_err());
        assert!(from_hex("e306928").is_err());
    }

    proptest! {
        #[test]
        fn matches_reference_crate(a in prop::collection::vec(any::<u8>(), 0..200), b in prop::collection::vec(any::<u8>(), 0..200)) {
            prop_assert_eq!(checksum(&a), ::crc32c::crc32c(&a));
            let mut ab = a.clone();
            ab.extend_from_slice(&b);
            prop_assert_eq!(append(checksum(&a), &b), checksum(&ab));
            prop_assert_eq!(append(7, &b), ::crc32c::crc32c_append(7, &b));
            prop_assert_eq!(append_bitwise(3, &a), append(3, &a));
        }
    }
}
