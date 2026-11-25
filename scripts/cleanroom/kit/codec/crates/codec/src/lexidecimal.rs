//! Lexidecimal: a doubly size-prefixed, big-endian radix-16 text encoding of
//! signed integers whose lexicographic order follows numeric order
//! (`docs/glossary/lexidecimal.md`).
//!
//! ```text
//! 0z [magnitude] size payload      nonnegative n, payload = hex(n)
//! 0y [magnitude] size payload      negative n,    payload = complement(hex(~n))
//! ```
//!
//! `size = len(hex) - 1`, zero-padded to the smallest width of 1, 2, 4, 8 or
//! 16 digits, spelled with anti-hex `g..v` (reversed, `v..g`, for negatives).
//! Widths above one carry a magnitude letter `m` with `1 << (1 + m) == width`:
//! `wxyz` for nonnegatives, `ZYXW` for negatives.
//!
//! The allocation-free cores ([`write_size_prefix`], [`encode_hex_into`],
//! [`parse`], [`encode_i128`], [`decode_i128`]) are what the Kani harnesses
//! prove; [`encode`] and [`decode`] wrap them for [`BigInt`].

use crate::bigint::BigInt;
use crate::error::{Error, Result};
use crate::hex;

/// Magnitude letters for nonnegative values, indexed by `m`.
pub const POSITIVE_MAGNITUDES: [u8; 4] = *b"wxyz";
/// Magnitude letters for negative values, indexed by `m`.
pub const NEGATIVE_MAGNITUDES: [u8; 4] = *b"ZYXW";
/// Longest size prefix: one magnitude letter plus sixteen size digits.
pub const MAX_SIZE_PREFIX_LEN: usize = 17;
/// Longest encoding of any `i128`: `0z` + `w` + 2 size digits + 32 payload.
pub const MAX_I128_LEN: usize = 37;

/// Minimal hexadecimal digit count of `s` (zero needs one digit).
#[inline]
pub const fn hex_len_u64(s: u64) -> usize {
    if s == 0 {
        1
    } else {
        (64 - s.leading_zeros() as usize).div_ceil(4)
    }
}

/// Smallest permitted size width (1, 2, 4, 8 or 16) that holds `s`.
#[inline]
pub const fn size_width(s: u64) -> usize {
    let l = hex_len_u64(s);
    if l <= 1 {
        1
    } else if l <= 2 {
        2
    } else if l <= 4 {
        4
    } else if l <= 8 {
        8
    } else {
        16
    }
}

/// Length of the size prefix (magnitude letter, if any, plus size digits).
#[inline]
pub const fn size_prefix_len(s: u64) -> usize {
    let w = size_width(s);
    if w == 1 {
        1
    } else {
        w + 1
    }
}

/// Write the size prefix for size `s` (`len(hex) - 1`) into `out`, returning
/// its length. This excludes the `0z`/`0y` sign prefix.
pub fn write_size_prefix(s: u64, negative: bool, out: &mut [u8]) -> Result<usize> {
    let w = size_width(s);
    let n = size_prefix_len(s);
    if out.len() < n {
        return Err(Error::BufferTooSmall);
    }
    let mut i = 0;
    if w > 1 {
        let m = (w.trailing_zeros() - 1) as usize;
        out[0] = if negative { NEGATIVE_MAGNITUDES[m] } else { POSITIVE_MAGNITUDES[m] };
        i = 1;
    }
    let mut k = 0;
    while k < w {
        let shift = 4 * (w - 1 - k);
        let d = ((s >> shift) & 0xf) as u8;
        out[i + k] = if negative { b'v' - d } else { b'g' + d };
        k += 1;
    }
    Ok(n)
}

/// Size prefix as a string (see [`write_size_prefix`]).
pub fn size_prefix(s: u64, negative: bool) -> String {
    let mut buf = [0u8; MAX_SIZE_PREFIX_LEN];
    let n = write_size_prefix(s, negative, &mut buf).expect("buffer holds any prefix");
    // Only ASCII letters are written.
    String::from_utf8(buf[..n].to_vec()).expect("ascii")
}

/// Total encoded length for a payload of `hex_len` digits.
pub const fn encoded_len(hex_len: usize) -> usize {
    2 + size_prefix_len(hex_len as u64 - 1) + hex_len
}

/// Encode from the uncomplemented minimal lowercase hex digits of the
/// magnitude: `n` itself when `negative` is false, otherwise `~n`.
pub fn encode_hex_into(negative: bool, hex_digits: &[u8], out: &mut [u8]) -> Result<usize> {
    let len = hex_digits.len();
    if len == 0 {
        return Err(Error::NonMinimal);
    }
    if len > 1 && hex_digits[0] == b'0' {
        return Err(Error::NonMinimal);
    }
    let mut j = 0;
    while j < len {
        if hex::lower_digit_value(hex_digits[j]).is_none() {
            return Err(Error::BadDigit);
        }
        j += 1;
    }
    let s = (len - 1) as u64;
    let total = 2 + size_prefix_len(s) + len;
    if out.len() < total {
        return Err(Error::BufferTooSmall);
    }
    out[0] = b'0';
    out[1] = if negative { b'y' } else { b'z' };
    let p = write_size_prefix(s, negative, &mut out[2..])?;
    let base = 2 + p;
    let mut j = 0;
    while j < len {
        let c = hex_digits[j];
        out[base + j] = if negative { hex::complement_digit(c) } else { c };
        j += 1;
    }
    Ok(total)
}

/// Structure of a canonical Lexidecimal string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Parsed {
    /// `0y` (negative) rather than `0z`.
    pub negative: bool,
    /// Offset of the payload, which runs to the end of the text. For
    /// negatives the payload digits are complemented.
    pub payload_start: usize,
}

/// Validate a Lexidecimal string, requiring the canonical spelling: correct
/// sign-specific alphabets, smallest size width, payload length matching the
/// size, lowercase payload digits, and minimal uncomplemented payload.
pub fn parse(text: &[u8]) -> Result<Parsed> {
    let n = text.len();
    if n < 4 {
        return Err(Error::Truncated);
    }
    if text[0] != b'0' {
        return Err(Error::BadPrefix);
    }
    let negative = match text[1] {
        b'z' => false,
        b'y' => true,
        _ => return Err(Error::BadPrefix),
    };
    let c = text[2];
    let (width, mut i) = match (negative, c) {
        (false, b'w'..=b'z') => (2usize << (c - b'w'), 3usize),
        (true, b'W'..=b'Z') => (2usize << (b'Z' - c), 3usize),
        (_, b'g'..=b'v') => (1usize, 2usize),
        _ => return Err(Error::BadDigit),
    };
    // At least the size digits and one payload digit must follow.
    if n < i + width + 1 {
        return Err(Error::Truncated);
    }
    let mut s: u64 = 0;
    let mut k = 0;
    while k < width {
        let d = text[i + k];
        if !(b'g'..=b'v').contains(&d) {
            return Err(Error::BadDigit);
        }
        let v = if negative { b'v' - d } else { d - b'g' };
        s = (s << 4) | v as u64;
        k += 1;
    }
    if size_width(s) != width {
        return Err(Error::NonCanonicalSize);
    }
    i += width;
    let payload_len = n - i;
    if (payload_len - 1) as u64 != s {
        return Err(Error::LengthMismatch);
    }
    let mut j = i;
    while j < n {
        if hex::lower_digit_value(text[j]).is_none() {
            return Err(Error::BadDigit);
        }
        j += 1;
    }
    if payload_len > 1 {
        let lead = text[i];
        if (!negative && lead == b'0') || (negative && lead == b'f') {
            return Err(Error::NonMinimal);
        }
    }
    Ok(Parsed { negative, payload_start: i })
}

/// Encode an `i128` into `out`, returning the length used.
pub fn encode_i128(v: i128, out: &mut [u8; MAX_I128_LEN]) -> usize {
    let negative = v < 0;
    let m = if negative { !v } else { v } as u128;
    let mut digits = [0u8; 32];
    let len = hex::write_u128(m, &mut digits);
    encode_hex_into(negative, &digits[..len], out).expect("i128 always fits")
}

/// Decode a canonical Lexidecimal string to `i128`.
pub fn decode_i128(text: &[u8]) -> Result<i128> {
    let p = parse(text)?;
    let payload = &text[p.payload_start..];
    if payload.len() > 32 {
        return Err(Error::Overflow);
    }
    let mut m: u128 = 0;
    for &c in payload {
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
    let mut out = vec![0u8; encoded_len(digits.len())];
    let n = encode_hex_into(negative, digits.as_bytes(), &mut out).expect("sized exactly");
    debug_assert_eq!(n, out.len());
    String::from_utf8(out).expect("ascii")
}

/// Decode a canonical Lexidecimal string to an arbitrary-precision integer.
pub fn decode(text: &str) -> Result<BigInt> {
    let t = text.as_bytes();
    let p = parse(t)?;
    let payload = &t[p.payload_start..];
    if p.negative {
        let digits: Vec<u8> = payload.iter().map(|&c| hex::complement_digit(c)).collect();
        Ok(BigInt::from_hex_digits(&digits)?.not())
    } else {
        BigInt::from_hex_digits(payload)
    }
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
        assert_eq!(encode_int(0), "0zg0");
        assert_eq!(encode_int(16), "0zh10");
        assert_eq!(encode_int(-1), "0yvf");
        assert_eq!(encode_int(-17), "0yuef");
        let two64 = BigInt::parse_decimal("18446744073709551616").unwrap();
        assert_eq!(encode(&two64), "0zwhg10000000000000000");
        assert_eq!(size_prefix(0x100, false), "xghgg");
        assert_eq!(decode("0zwhg10000000000000000").unwrap(), two64);
    }

    #[test]
    fn size_prefixes() {
        assert_eq!(size_prefix(0, false), "g");
        assert_eq!(size_prefix(15, false), "v");
        assert_eq!(size_prefix(16, false), "whg");
        assert_eq!(size_prefix(0, true), "v");
        assert_eq!(size_prefix(15, true), "g");
        assert_eq!(size_prefix(16, true), "Zuv");
        assert_eq!(size_prefix(0xff, false), "wvv");
        assert_eq!(size_prefix(0xffff, false), "xvvvv");
        assert_eq!(size_prefix(0x10000, false), "yggghgggg");
        assert_eq!(size_prefix(0x1_0000_0000, true), "Wvvvvvvvuvvvvvvvv");
        assert_eq!(size_prefix(u64::MAX, false), format!("z{}", "v".repeat(16)));
    }

    #[test]
    fn rejects_noncanonical() {
        for bad in [
            "", "0z", "0zg", "0zg00", "0zh01", "0zhA", "0zG0", "1zg0", "0xg0", "0zwgf0",
            "0zgA", "0yvF", "0yuff", "0zwhg1", "0yZg0", "0zWuv0", "0zvg", "0zh1",
            "0zh100", "0z g0", "0yv0f",
        ] {
            assert!(decode(bad).is_err(), "{bad:?} should be rejected");
            assert!(decode_i128(bad.as_bytes()).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn boundaries() {
        for v in [
            15i128, 16, 255, 256, -16, -17, -256, -257,
            i128::MAX, i128::MIN, i64::MAX as i128, i64::MIN as i128,
        ] {
            let e = encode_int(v);
            assert_eq!(decode_i128(e.as_bytes()).unwrap(), v, "{e}");
            assert_eq!(decode(&e).unwrap(), BigInt::from_i128(v));
            assert_eq!(encode(&BigInt::from_i128(v)), e);
        }
        // 16 hex digits needs size 15 (width 1); 17 needs width 2.
        assert_eq!(encode_int(0xffff_ffff_ffff_ffff), "0zvffffffffffffffff");
        assert_eq!(encode_int(-0x1_0000_0000_0000_0000), "0yg0000000000000000");
    }

    #[test]
    fn huge_values() {
        // 2^(4*300) has 301 hex digits: size 300 = 0x12c, width 4.
        let mut digits = String::from("1");
        digits.push_str(&"0".repeat(300));
        let v = BigInt::from_hex_digits(digits.as_bytes()).unwrap();
        let e = encode(&v);
        assert!(e.starts_with("0zxghis1"), "{e}");
        assert_eq!(decode(&e).unwrap(), v);
        let n = v.not();
        let en = encode(&n);
        assert!(en.starts_with("0yYvutje"), "{en}");
        assert_eq!(decode(&en).unwrap(), n);
        assert!(en < encode_int(-1));
    }

    proptest! {
        #[test]
        fn roundtrip_i128(v in any::<i128>()) {
            let e = encode_int(v);
            prop_assert_eq!(decode_i128(e.as_bytes()).unwrap(), v);
            prop_assert_eq!(encode(&BigInt::from_i128(v)), e);
        }

        #[test]
        fn order_preserved(a in any::<i128>(), b in any::<i128>()) {
            prop_assert_eq!(encode_int(a).cmp(&encode_int(b)), a.cmp(&b));
        }

        #[test]
        fn order_preserved_big(a in "-?[1-9][0-9]{0,60}", b in "-?[1-9][0-9]{0,60}") {
            let (a, b) = (BigInt::parse_decimal(&a).unwrap(), BigInt::parse_decimal(&b).unwrap());
            prop_assert_eq!(encode(&a).cmp(&encode(&b)), a.cmp(&b));
            prop_assert_eq!(decode(&encode(&a)).unwrap(), a);
        }

        #[test]
        fn accepted_strings_reencode(s in "0[yz][wxyzWXYZg-v]{1,4}[0-9a-f]{1,20}") {
            if let Ok(v) = decode(&s) {
                prop_assert_eq!(encode(&v), s);
            }
        }
    }
}
