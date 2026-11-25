//! Diffuse16: a bucket-safe little-endian radix-16 integer encoding
//! (`docs/glossary/diffuse16.md`).
//!
//! ```text
//! n >= 0: "0w" + reverse(hex(n))                 + "z"
//! n <  0: "0w" + reverse(complement(hex(~n)))    + "y"
//! ```
//!
//! `hex` is minimal lowercase; decoding requires that canonical spelling.

use crate::bigint::BigInt;
use crate::error::{Error, Result};
use crate::hex;

/// Longest encoding of any `i128`: `0w` + 32 digits + suffix.
pub const MAX_I128_LEN: usize = 35;

/// Encode from the uncomplemented minimal lowercase hex digits of the
/// magnitude (`n`, or `~n` when `negative`), most significant first.
pub fn encode_hex_into(negative: bool, hex_digits: &[u8], out: &mut [u8]) -> Result<usize> {
    let len = hex_digits.len();
    if len == 0 || (len > 1 && hex_digits[0] == b'0') {
        return Err(Error::NonMinimal);
    }
    let mut j = 0;
    while j < len {
        if hex::lower_digit_value(hex_digits[j]).is_none() {
            return Err(Error::BadDigit);
        }
        j += 1;
    }
    let total = len + 3;
    if out.len() < total {
        return Err(Error::BufferTooSmall);
    }
    out[0] = b'0';
    out[1] = b'w';
    let mut j = 0;
    while j < len {
        let c = hex_digits[len - 1 - j];
        out[2 + j] = if negative { hex::complement_digit(c) } else { c };
        j += 1;
    }
    out[2 + len] = if negative { b'y' } else { b'z' };
    Ok(total)
}

/// Structure of a canonical Diffuse16 string: digits occupy
/// `text[2..text.len() - 1]`, least significant first, complemented when
/// negative.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Parsed {
    /// Suffix `y` rather than `z`.
    pub negative: bool,
}

/// Validate a canonical Diffuse16 string.
pub fn parse(text: &[u8]) -> Result<Parsed> {
    let n = text.len();
    if n < 4 {
        return Err(Error::Truncated);
    }
    if text[0] != b'0' || text[1] != b'w' {
        return Err(Error::BadPrefix);
    }
    let negative = match text[n - 1] {
        b'z' => false,
        b'y' => true,
        _ => return Err(Error::BadPrefix),
    };
    let mut j = 2;
    while j < n - 1 {
        if hex::lower_digit_value(text[j]).is_none() {
            return Err(Error::BadDigit);
        }
        j += 1;
    }
    let digits = n - 3;
    if digits > 1 {
        let msd = text[n - 2];
        if (!negative && msd == b'0') || (negative && msd == b'f') {
            return Err(Error::NonMinimal);
        }
    }
    Ok(Parsed { negative })
}

/// Encode an `i128` into `out`, returning the length used.
pub fn encode_i128(v: i128, out: &mut [u8; MAX_I128_LEN]) -> usize {
    let negative = v < 0;
    let m = if negative { !v } else { v } as u128;
    let mut digits = [0u8; 32];
    let len = hex::write_u128(m, &mut digits);
    encode_hex_into(negative, &digits[..len], out).expect("i128 always fits")
}

/// Decode a canonical Diffuse16 string to `i128`.
pub fn decode_i128(text: &[u8]) -> Result<i128> {
    let p = parse(text)?;
    let digits = &text[2..text.len() - 1];
    if digits.len() > 32 {
        return Err(Error::Overflow);
    }
    let mut m: u128 = 0;
    for &c in digits.iter().rev() {
        let c = if p.negative { hex::complement_digit(c) } else { c };
        m = (m << 4) | hex::lower_digit_value(c).expect("validated") as u128;
    }
    if m > i128::MAX as u128 {
        return Err(Error::Overflow);
    }
    let m = m as i128;
    Ok(if p.negative { !m } else { m })
}

/// Encode an arbitrary-precision integer.
pub fn encode(v: &BigInt) -> String {
    let negative = v.is_negative();
    let m = if negative { v.not() } else { v.clone() };
    let digits = m.magnitude_hex();
    let mut out = vec![0u8; digits.len() + 3];
    encode_hex_into(negative, digits.as_bytes(), &mut out).expect("sized exactly");
    String::from_utf8(out).expect("ascii")
}

/// Decode a canonical Diffuse16 string.
pub fn decode(text: &str) -> Result<BigInt> {
    let t = text.as_bytes();
    let p = parse(t)?;
    let digits: Vec<u8> = t[2..t.len() - 1]
        .iter()
        .rev()
        .map(|&c| if p.negative { hex::complement_digit(c) } else { c })
        .collect();
    let m = BigInt::from_hex_digits(&digits)?;
    Ok(if p.negative { m.not() } else { m })
}

/// Encode a machine integer (convenience).
pub fn encode_int(v: i128) -> String {
    let mut buf = [0u8; MAX_I128_LEN];
    let n = encode_i128(v, &mut buf);
    String::from_utf8(buf[..n].to_vec()).expect("ascii")
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn documented_examples() {
        assert_eq!(encode_int(0), "0w0z");
        assert_eq!(encode_int(16), "0w01z");
        assert_eq!(encode_int(27), "0wb1z");
        assert_eq!(encode_int(-1), "0wfy");
        assert_eq!(encode_int(-16), "0w0y");
        for (s, v) in [("0w0z", 0), ("0w01z", 16), ("0wb1z", 27), ("0wfy", -1), ("0w0y", -16)] {
            assert_eq!(decode_i128(s.as_bytes()).unwrap(), v);
            assert_eq!(decode(s).unwrap(), BigInt::from_i128(v));
        }
    }

    #[test]
    fn rejects_noncanonical() {
        for bad in ["", "0w", "0wz", "0wy", "0w00z", "0w10z", "0wffy", "0wAz", "0w0x", "1w0z", "0W0z", "0w0zz"] {
            assert!(decode(bad).is_err(), "{bad:?}");
            assert!(decode_i128(bad.as_bytes()).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn big() {
        let v = BigInt::parse_decimal("-340282366920938463463374607431768211457").unwrap();
        let e = encode(&v);
        assert_eq!(decode(&e).unwrap(), v);
        assert!(decode_i128(e.as_bytes()).is_err());
    }

    proptest! {
        #[test]
        fn roundtrip(v in any::<i128>()) {
            let e = encode_int(v);
            prop_assert_eq!(decode_i128(e.as_bytes()).unwrap(), v);
            prop_assert_eq!(encode(&BigInt::from_i128(v)), e.clone());
            prop_assert_eq!(decode(&e).unwrap(), BigInt::from_i128(v));
        }

        #[test]
        fn accepted_reencode(s in "0w[0-9a-f]{1,20}[yz]") {
            if let Ok(v) = decode(&s) {
                prop_assert_eq!(encode(&v), s);
            }
        }
    }
}
