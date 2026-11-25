//! A small arbitrary-precision signed integer.
//!
//! basinsync positions (Milestones, Viewpoints, coordinates) and bigint
//! extensions are unbounded. Only the operations the codecs need are offered:
//! canonical decimal and hexadecimal conversion, big-endian magnitude bytes,
//! and two's-complement `~`.

use core::cmp::Ordering;
use core::fmt;

use crate::error::{Error, Result};
use crate::hex;

/// Arbitrary-precision signed integer.
///
/// Invariant: `mag` is little-endian base-2^32 with no trailing zero limbs,
/// and zero is never negative.
#[derive(Clone, PartialEq, Eq, Hash, Default)]
pub struct BigInt {
    neg: bool,
    mag: Vec<u32>,
}

impl fmt::Debug for BigInt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "BigInt({})", self.to_decimal())
    }
}

impl fmt::Display for BigInt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_decimal())
    }
}

fn trim(mag: &mut Vec<u32>) {
    while mag.last() == Some(&0) {
        mag.pop();
    }
}

fn mag_add_one(mag: &mut Vec<u32>) {
    for limb in mag.iter_mut() {
        let (v, carry) = limb.overflowing_add(1);
        *limb = v;
        if !carry {
            return;
        }
    }
    mag.push(1);
}

/// Subtract one from a nonzero magnitude.
fn mag_sub_one(mag: &mut Vec<u32>) {
    for limb in mag.iter_mut() {
        let (v, borrow) = limb.overflowing_sub(1);
        *limb = v;
        if !borrow {
            break;
        }
    }
    trim(mag);
}

fn mag_cmp(a: &[u32], b: &[u32]) -> Ordering {
    a.len().cmp(&b.len()).then_with(|| a.iter().rev().cmp(b.iter().rev()))
}

impl BigInt {
    /// Zero.
    pub const fn zero() -> Self {
        BigInt { neg: false, mag: Vec::new() }
    }

    fn from_parts(neg: bool, mut mag: Vec<u32>) -> Self {
        trim(&mut mag);
        let neg = neg && !mag.is_empty();
        BigInt { neg, mag }
    }

    /// Whether the value is below zero.
    pub fn is_negative(&self) -> bool {
        self.neg
    }

    /// Whether the value is zero.
    pub fn is_zero(&self) -> bool {
        self.mag.is_empty()
    }

    /// From a machine integer.
    pub fn from_i128(v: i128) -> Self {
        let neg = v < 0;
        let mut m = v.unsigned_abs();
        let mut mag = Vec::new();
        while m != 0 {
            mag.push(m as u32);
            m >>= 32;
        }
        BigInt::from_parts(neg, mag)
    }

    /// From an unsigned machine integer.
    pub fn from_u128(mut m: u128) -> Self {
        let mut mag = Vec::new();
        while m != 0 {
            mag.push(m as u32);
            m >>= 32;
        }
        BigInt::from_parts(false, mag)
    }

    /// To a machine integer, if it fits.
    pub fn to_i128(&self) -> Option<i128> {
        if self.mag.len() > 4 {
            return None;
        }
        let mut m: u128 = 0;
        for &limb in self.mag.iter().rev() {
            m = m << 32 | limb as u128;
        }
        if self.neg {
            if m <= i128::MAX as u128 + 1 {
                Some((m as i128).wrapping_neg())
            } else {
                None
            }
        } else if m <= i128::MAX as u128 {
            Some(m as i128)
        } else {
            None
        }
    }

    /// To an unsigned machine integer, if nonnegative and it fits.
    pub fn to_u64(&self) -> Option<u64> {
        if self.neg || self.mag.len() > 2 {
            return None;
        }
        let mut m: u64 = 0;
        for &limb in self.mag.iter().rev() {
            m = m << 32 | limb as u64;
        }
        Some(m)
    }

    /// Arbitrary-precision bitwise complement: `~v = -v - 1`.
    pub fn not(&self) -> Self {
        let mut mag = self.mag.clone();
        if self.neg {
            // -m -> m - 1
            mag_sub_one(&mut mag);
            BigInt::from_parts(false, mag)
        } else {
            // m -> -(m + 1)
            mag_add_one(&mut mag);
            BigInt::from_parts(true, mag)
        }
    }

    /// Parse canonical decimal: `-?(0|[1-9][0-9]*)`, rejecting `-0`.
    pub fn parse_decimal(text: &str) -> Result<Self> {
        let t = text.as_bytes();
        let (neg, digits) = match t.first() {
            Some(b'-') => (true, &t[1..]),
            _ => (false, t),
        };
        if digits.is_empty() {
            return Err(Error::BadNumber);
        }
        if digits.iter().any(|c| !c.is_ascii_digit()) {
            return Err(Error::BadNumber);
        }
        if digits.len() > 1 && digits[0] == b'0' {
            return Err(Error::BadNumber);
        }
        if neg && digits == b"0" {
            return Err(Error::BadNumber);
        }
        let mut mag: Vec<u32> = Vec::new();
        for chunk in digits.chunks(9) {
            let mut mul: u64 = 1;
            let mut add: u64 = 0;
            for &c in chunk {
                mul *= 10;
                add = add * 10 + (c - b'0') as u64;
            }
            let mut carry = add;
            for limb in mag.iter_mut() {
                let v = *limb as u64 * mul + carry;
                *limb = v as u32;
                carry = v >> 32;
            }
            if carry != 0 {
                mag.push(carry as u32);
            }
        }
        Ok(BigInt::from_parts(neg, mag))
    }

    /// Canonical decimal text.
    pub fn to_decimal(&self) -> String {
        if self.mag.is_empty() {
            return "0".to_string();
        }
        let mut mag = self.mag.clone();
        let mut chunks: Vec<u32> = Vec::new();
        while !mag.is_empty() {
            let mut rem: u64 = 0;
            for limb in mag.iter_mut().rev() {
                let cur = rem << 32 | *limb as u64;
                *limb = (cur / 1_000_000_000) as u32;
                rem = cur % 1_000_000_000;
            }
            trim(&mut mag);
            chunks.push(rem as u32);
        }
        let mut s = String::new();
        if self.neg {
            s.push('-');
        }
        let mut iter = chunks.iter().rev();
        if let Some(first) = iter.next() {
            s.push_str(&first.to_string());
        }
        for c in iter {
            s.push_str(&format!("{c:09}"));
        }
        s
    }

    /// Minimal lowercase hex digits of the magnitude (`"0"` for zero).
    pub fn magnitude_hex(&self) -> String {
        if self.mag.is_empty() {
            return "0".to_string();
        }
        let mut s = String::with_capacity(self.mag.len() * 8);
        let mut iter = self.mag.iter().rev();
        if let Some(first) = iter.next() {
            s.push_str(&format!("{first:x}"));
        }
        for limb in iter {
            s.push_str(&format!("{limb:08x}"));
        }
        s
    }

    /// Nonnegative value from hexadecimal digits of either case. Leading
    /// zeros are accepted; at least one digit is required.
    pub fn from_hex_digits(digits: &[u8]) -> Result<Self> {
        if digits.is_empty() {
            return Err(Error::BadDigit);
        }
        let mut mag = Vec::with_capacity(digits.len() / 8 + 1);
        for chunk in digits.rchunks(8) {
            let mut limb: u32 = 0;
            for &c in chunk {
                limb = limb << 4 | hex::any_digit_value(c).ok_or(Error::BadDigit)? as u32;
            }
            mag.push(limb);
        }
        Ok(BigInt::from_parts(false, mag))
    }

    /// Minimal big-endian magnitude bytes; zero is one zero byte.
    pub fn magnitude_be_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.mag.len() * 4);
        for limb in self.mag.iter().rev() {
            out.extend_from_slice(&limb.to_be_bytes());
        }
        let first = out.iter().position(|&b| b != 0).unwrap_or(out.len());
        out.drain(..first);
        if out.is_empty() {
            out.push(0);
        }
        out
    }

    /// Nonnegative value from big-endian bytes (any leading zeros).
    pub fn from_be_bytes(bytes: &[u8]) -> Self {
        let mut mag = Vec::with_capacity(bytes.len() / 4 + 1);
        for chunk in bytes.rchunks(4) {
            let mut limb: u32 = 0;
            for &b in chunk {
                limb = limb << 8 | b as u32;
            }
            mag.push(limb);
        }
        BigInt::from_parts(false, mag)
    }
}

impl Ord for BigInt {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self.neg, other.neg) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => mag_cmp(&self.mag, &other.mag),
            (true, true) => mag_cmp(&other.mag, &self.mag),
        }
    }
}

impl PartialOrd for BigInt {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl From<i64> for BigInt {
    fn from(v: i64) -> Self {
        BigInt::from_i128(v as i128)
    }
}

impl From<u64> for BigInt {
    fn from(v: u64) -> Self {
        BigInt::from_u128(v as u128)
    }
}

impl core::str::FromStr for BigInt {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self> {
        BigInt::parse_decimal(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn decimal_edges() {
        for s in ["0", "1", "-1", "4294967296", "-340282366920938463463374607431768211456"] {
            assert_eq!(BigInt::parse_decimal(s).unwrap().to_decimal(), s);
        }
        for s in ["", "-", "-0", "01", "+1", "1a", " 1"] {
            assert!(BigInt::parse_decimal(s).is_err(), "{s:?}");
        }
        let big = "18446744073709551616";
        let v = BigInt::parse_decimal(big).unwrap();
        assert_eq!(v.magnitude_hex(), "10000000000000000");
    }

    #[test]
    fn complement() {
        assert_eq!(BigInt::zero().not(), BigInt::from_i128(-1));
        assert_eq!(BigInt::from_i128(-1).not(), BigInt::zero());
        assert_eq!(BigInt::from_i128(-17).not(), BigInt::from_i128(16));
        let p = BigInt::parse_decimal("4294967295").unwrap();
        assert_eq!(p.not().to_decimal(), "-4294967296");
        assert_eq!(p.not().not(), p);
    }

    #[test]
    fn bytes() {
        assert_eq!(BigInt::zero().magnitude_be_bytes(), vec![0]);
        assert_eq!(BigInt::from_i128(256).magnitude_be_bytes(), vec![1, 0]);
        assert_eq!(BigInt::from_be_bytes(&[0, 0, 1, 0]), BigInt::from_i128(256));
    }

    proptest! {
        #[test]
        fn i128_roundtrips(v in any::<i128>()) {
            let b = BigInt::from_i128(v);
            prop_assert_eq!(b.to_i128(), Some(v));
            prop_assert_eq!(b.to_decimal(), v.to_string());
            prop_assert_eq!(BigInt::parse_decimal(&v.to_string()).unwrap(), b.clone());
            prop_assert_eq!(b.not().to_i128(), Some(!v));
            prop_assert_eq!(b.magnitude_hex(), format!("{:x}", v.unsigned_abs()));
        }

        #[test]
        fn ordering(a in any::<i128>(), b in any::<i128>()) {
            prop_assert_eq!(BigInt::from_i128(a).cmp(&BigInt::from_i128(b)), a.cmp(&b));
        }

        #[test]
        fn big_decimal_roundtrip(s in "-?[1-9][0-9]{0,80}") {
            prop_assert_eq!(BigInt::parse_decimal(&s).unwrap().to_decimal(), s);
        }
    }
}
