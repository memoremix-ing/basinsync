//! The SDK's signed Lexidecimal wire format; see docs/glossary/lexidecimal.md.
use anyhow::{Context, Result, bail, ensure};
use num_bigint::{BigInt, BigUint, Sign};

pub fn encode(value: &BigInt) -> String {
    let negative = value.sign() == Sign::Minus;
    let magnitude = if negative { !value } else { value.clone() };
    let hex = magnitude.to_str_radix(16);
    let size = format!("{:x}", hex.len() - 1);
    // A usize-sized allocation cannot require more than 16 size digits.
    let body = format!("{:x}{size}{hex}", size.len() - 1);
    if negative {
        format!("0y{}", complement(&body))
    } else {
        format!("0z{body}")
    }
}

fn complement(hex: &str) -> String {
    hex.bytes()
        .map(|b| char::from_digit(15 - (b as char).to_digit(16).unwrap(), 16).unwrap())
        .collect()
}

pub fn decode(encoded: &str) -> Result<BigInt> {
    let (prefix, suffix) = encoded.split_at_checked(2).context("missing sign prefix")?;
    ensure!(matches!(prefix, "0y" | "0z"), "invalid sign prefix");
    ensure!(
        suffix.len() >= 3
            && suffix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid hex"
    );
    let body = if prefix == "0y" {
        complement(suffix)
    } else {
        suffix.to_owned()
    };
    let size_digits = body.as_bytes()[0] as char;
    let value_start = 2 + size_digits.to_digit(16).unwrap() as usize;
    ensure!(body.len() > value_start, "missing value");
    let size = usize::from_str_radix(&body[1..value_start], 16).context("invalid size")?;
    ensure!(size == body.len() - value_start - 1, "incorrect size");
    let magnitude =
        BigInt::parse_bytes(&body.as_bytes()[value_start..], 16).context("invalid value")?;
    let value = if prefix == "0y" {
        !magnitude
    } else {
        magnitude
    };
    ensure!(encode(&value) == encoded, "noncanonical encoding");
    Ok(value)
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Viewpoint(BigUint);

impl Viewpoint {
    pub fn zero() -> Self {
        Self(BigUint::from(0u8))
    }

    pub fn parse(decimal: &str) -> Result<Self> {
        ensure!(
            !decimal.is_empty() && decimal.bytes().all(|b| b.is_ascii_digit()),
            "viewpoint must be an unsigned decimal string"
        );
        let value = BigUint::parse_bytes(decimal.as_bytes(), 10).context("invalid viewpoint")?;
        ensure!(
            value.to_str_radix(10) == decimal,
            "viewpoint must be canonical decimal"
        );
        Ok(Self(value))
    }

    pub fn hexadecimal(&self) -> String {
        self.0.to_str_radix(16)
    }

    pub fn decimal(&self) -> String {
        self.0.to_str_radix(10)
    }
    pub fn next(&self) -> Self {
        Self(&self.0 + 1u8)
    }

    pub fn key(&self) -> Result<String> {
        let key = format!("epilogue/{}", encode(&!BigInt::from(self.0.clone())));
        ensure!(key.len() <= 1024, "viewpoint exceeds S3's key size limit");
        Ok(key)
    }

    pub fn from_key(key: &str) -> Result<Self> {
        let encoded = key
            .strip_prefix("epilogue/")
            .context("invalid Epilogue prefix")?;
        let signed = decode(encoded)?;
        if signed.sign() != Sign::Minus {
            bail!("Epilogue keys must encode complemented viewpoints");
        }
        let result = Self((!signed).to_biguint().context("invalid viewpoint")?);
        ensure!(result.key()? == key, "noncanonical Epilogue key");
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn sdk_vectors_and_canonical_rejection() {
        for (n, wire) in [
            (0, "0z000"),
            (1, "0z001"),
            (15, "0z00f"),
            (16, "0z0110"),
            (255, "0z01ff"),
            (256, "0z02100"),
            (-1, "0yfff"),
            (-2, "0yffe"),
            (-16, "0yff0"),
            (-17, "0yfeef"),
            (-256, "0yfe00"),
            (-257, "0yfdeff"),
        ] {
            assert_eq!(encode(&n.into()), wire);
            assert_eq!(decode(wire).unwrap(), n.into());
        }
        for bad in [
            "", "0", "0x000", "0z00", "0z0000", "0z010", "0yggg", "0z1000", "0z0100", "0z00F", "💧",
        ] {
            assert!(decode(bad).is_err(), "{bad}");
        }
        for bad in ["", "-1", "+1", "01", "1.0", " 1", "١"] {
            assert!(Viewpoint::parse(bad).is_err());
        }
        for bad in ["epilogue/0z000", "epilogue/0yfff/extra", "other/0yfff"] {
            assert!(Viewpoint::from_key(bad).is_err());
        }
    }

    #[test]
    fn boundaries_beyond_machine_precision() {
        for bits in [4, 8, 64, 68, 256, 1024, 4096] {
            let n = BigInt::from(1u8) << (bits as usize);
            let values = [&n - 1u8, n.clone(), &n + 1u8];
            for pair in values.windows(2) {
                assert!(encode(&pair[0]) < encode(&pair[1]));
                assert_eq!(decode(&encode(&pair[0])).unwrap(), pair[0]);
                if bits == 4096 {
                    assert!(Viewpoint(pair[0].to_biguint().unwrap()).key().is_err());
                    continue;
                }
                let a = Viewpoint(pair[0].to_biguint().unwrap());
                let b = Viewpoint(pair[1].to_biguint().unwrap());
                assert!(a.key().unwrap() > b.key().unwrap());
                assert_eq!(Viewpoint::from_key(&a.key().unwrap()).unwrap(), a);
            }
        }
    }

    proptest! {
        #[test]
        fn signed_roundtrip_and_order(a in prop::collection::vec(any::<u8>(), 0..512), b in prop::collection::vec(any::<u8>(), 0..512), negative_a in any::<bool>(), negative_b in any::<bool>()) {
            let a = BigInt::from_bytes_be(if negative_a {Sign::Minus} else {Sign::Plus}, &a);
            let b = BigInt::from_bytes_be(if negative_b {Sign::Minus} else {Sign::Plus}, &b);
            prop_assert_eq!(decode(&encode(&a)).unwrap(), a.clone());
            prop_assert_eq!(encode(&a).cmp(&encode(&b)), a.cmp(&b));
        }

        #[test]
        fn arbitrary_text_never_panics(text in ".{0,200}") { let _ = decode(&text); }
    }
}
