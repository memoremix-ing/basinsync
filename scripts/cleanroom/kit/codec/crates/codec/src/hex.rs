//! Lowercase hexadecimal helpers shared by the codecs.

use crate::error::{Error, Result};

/// Lowercase hexadecimal digits.
pub const DIGITS: &[u8; 16] = b"0123456789abcdef";

/// Value of a lowercase hexadecimal digit; uppercase is rejected.
#[inline]
pub const fn lower_digit_value(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

/// Value of a hexadecimal digit of either case.
#[inline]
pub const fn any_digit_value(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => lower_digit_value(c),
    }
}

/// Complement a lowercase hex digit (`d -> f - d`). Input must be valid.
#[inline]
pub const fn complement_digit(c: u8) -> u8 {
    match lower_digit_value(c) {
        Some(v) => DIGITS[(15 - v) as usize],
        None => c,
    }
}

/// Render bytes as lowercase hexadecimal, two digits per byte.
pub fn encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

/// Parse lowercase hexadecimal (even length) into bytes.
pub fn decode_lower(text: &str) -> Result<Vec<u8>> {
    let t = text.as_bytes();
    if t.len() % 2 != 0 {
        return Err(Error::LengthMismatch);
    }
    let mut out = Vec::with_capacity(t.len() / 2);
    for pair in t.chunks_exact(2) {
        let hi = lower_digit_value(pair[0]).ok_or(Error::BadDigit)?;
        let lo = lower_digit_value(pair[1]).ok_or(Error::BadDigit)?;
        out.push(hi << 4 | lo);
    }
    Ok(out)
}

/// Write the minimal lowercase hex digits of `v` into `out`, returning the
/// digit count (zero is `"0"`). `out` must hold at least 32 bytes.
pub fn write_u128(v: u128, out: &mut [u8]) -> usize {
    let n = if v == 0 { 1 } else { (128 - v.leading_zeros() as usize).div_ceil(4) };
    let mut i = 0;
    while i < n {
        let shift = 4 * (n - 1 - i);
        out[i] = DIGITS[((v >> shift) & 15) as usize];
        i += 1;
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        assert_eq!(encode(&[0, 1, 0xab, 0xff]), "0001abff");
        assert_eq!(decode_lower("0001abff").unwrap(), vec![0, 1, 0xab, 0xff]);
        assert_eq!(decode_lower("0A"), Err(Error::BadDigit));
        assert_eq!(decode_lower("abc"), Err(Error::LengthMismatch));
    }

    #[test]
    fn u128_digits() {
        let mut b = [0u8; 32];
        let n = write_u128(0, &mut b);
        assert_eq!(&b[..n], b"0");
        let n = write_u128(0x10, &mut b);
        assert_eq!(&b[..n], b"10");
        let n = write_u128(u128::MAX, &mut b);
        assert_eq!(&b[..n], &[b'f'; 32]);
    }
}
