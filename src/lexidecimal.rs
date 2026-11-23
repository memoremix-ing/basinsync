//! Canonical signed Lexidecimal; see docs/glossary/lexidecimal.md.
use anyhow::{Context, Result, bail, ensure};
use num_bigint::{BigInt, BigUint, Sign};

const HEX: &[u8; 16] = b"0123456789abcdef";

fn size_prefix(size: usize, negative: bool) -> String {
    let size = format!("{size:x}");
    let width = size.len().next_power_of_two();
    // A usize-sized allocation needs at most sixteen hexadecimal size digits.
    assert!(width <= 16);
    let mut prefix = String::with_capacity(width + 1);
    if width > 1 {
        let power = width.trailing_zeros() as u8 - 1;
        prefix.push(char::from(if negative {
            b'Z' - power
        } else {
            b'w' + power
        }));
    }
    for digit in format!("{size:0>width$}").bytes() {
        let value = (digit as char).to_digit(16).unwrap() as u8;
        prefix.push(char::from(if negative {
            b'v' - value
        } else {
            b'g' + value
        }));
    }
    prefix
}

pub fn encode(value: &BigInt) -> String {
    let negative = value.sign() == Sign::Minus;
    let magnitude = if negative { !value } else { value.clone() };
    let hex = magnitude.to_str_radix(16);
    let size = size_prefix(hex.len() - 1, negative);
    if negative {
        format!("0y{size}{}", complement(&hex))
    } else {
        format!("0z{size}{hex}")
    }
}

fn complement(hex: &str) -> String {
    hex.bytes()
        .map(|digit| HEX[15 - (digit as char).to_digit(16).unwrap() as usize] as char)
        .collect()
}

pub fn decode(encoded: &str) -> Result<BigInt> {
    let (prefix, body) = encoded.split_at_checked(2).context("missing sign prefix")?;
    ensure!(matches!(prefix, "0y" | "0z"), "invalid sign prefix");
    let negative = prefix == "0y";
    let first = *body.as_bytes().first().context("missing size")?;
    let power = if negative && (b'W'..=b'Z').contains(&first) {
        Some(b'Z' - first)
    } else if !negative && (b'w'..=b'z').contains(&first) {
        Some(first - b'w')
    } else {
        None
    };
    let (start, width) = power.map_or((0, 1), |m| (1, 1usize << (1 + m)));
    let size = body.get(start..start + width).context("truncated size")?;
    ensure!(
        size.bytes().all(|b| (b'g'..=b'v').contains(&b)),
        "invalid anti-hex size"
    );
    let size: String = size
        .bytes()
        .map(|b| HEX[if negative { b'v' - b } else { b - b'g' } as usize] as char)
        .collect();
    let size = usize::from_str_radix(&size, 16).context("size exceeds address space")?;
    let hex = &body[start + width..];
    ensure!(
        !hex.is_empty()
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid hex payload"
    );
    ensure!(size == hex.len() - 1, "incorrect size");
    let hex = if negative {
        complement(hex)
    } else {
        hex.to_owned()
    };
    let magnitude = BigInt::parse_bytes(hex.as_bytes(), 16).context("invalid value")?;
    let value = if negative { !magnitude } else { magnitude };
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

    pub fn lexidecimal(&self) -> String {
        encode(&BigInt::from(self.0.clone()))
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
        let key = format!(
            "{}{}",
            crate::epilogue::BASIN_PREFIX,
            encode(&!BigInt::from(self.0.clone()))
        );
        ensure!(key.len() <= 1024, "viewpoint exceeds S3's key size limit");
        Ok(key)
    }

    pub fn from_key(key: &str) -> Result<Self> {
        let encoded = key
            .strip_prefix(crate::epilogue::BASIN_PREFIX)
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

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        canonical: Vec<(String, String)>,
        invalid: Vec<String>,
        size_prefixes: Vec<(u64, String, String)>,
    }

    /// Wire vectors shared with the TypeScript client.
    #[test]
    fn shared_vectors() {
        let vectors: Vectors =
            serde_json::from_str(include_str!("../tests/vectors/lexidecimal.json")).unwrap();
        for (n, wire) in &vectors.canonical {
            let n: BigInt = n.parse().unwrap();
            assert_eq!(&encode(&n), wire);
            assert_eq!(decode(wire).unwrap(), n);
        }
        for bad in &vectors.invalid {
            assert!(decode(bad).is_err(), "{bad}");
        }
        for (size, positive, negative) in &vectors.size_prefixes {
            let Ok(size) = usize::try_from(*size) else {
                continue;
            };
            assert_eq!(&size_prefix(size, false), positive);
            assert_eq!(&size_prefix(size, true), negative);
        }
    }

    #[test]
    fn viewpoints_reject_noncanonical_decimals_foreign_keys_and_oversized_keys() {
        for bad in ["", "-1", "+1", "01", "1.0", " 1", "١"] {
            assert!(Viewpoint::parse(bad).is_err(), "{bad}");
        }
        for bad in [
            "kernelspace/basin/epilogue/0zg0",
            "kernelspace/basin/epilogue/0yvf/extra",
            "other/0yvf",
        ] {
            assert!(Viewpoint::from_key(bad).is_err(), "{bad}");
        }
        assert!(Viewpoint(BigUint::from(1u8) << 4096usize).key().is_err());
    }

    proptest! {
        #[test]
        fn signed_roundtrip_and_order(a in prop::collection::vec(any::<u8>(), 0..512), b in prop::collection::vec(any::<u8>(), 0..512), negative_a in any::<bool>(), negative_b in any::<bool>()) {
            let a = BigInt::from_bytes_be(if negative_a {Sign::Minus} else {Sign::Plus}, &a);
            let b = BigInt::from_bytes_be(if negative_b {Sign::Minus} else {Sign::Plus}, &b);
            prop_assert_eq!(decode(&encode(&a)).unwrap(), a.clone());
            prop_assert_eq!(encode(&a).cmp(&encode(&b)), a.cmp(&b));
        }

        /// Neighbors of powers of two cross every size-prefix width, including widths beyond
        /// machine precision; Epilogue keys of viewpoints sort in reverse.
        #[test]
        fn width_boundaries_keep_order_and_descending_keys(bits in prop_oneof![63 => 0usize..2048, 1 => Just(262_144)], negative in any::<bool>()) {
            let n = BigInt::from(1u8) << bits;
            let values: Vec<BigInt> = if negative {
                vec![-&n - 1u8, -&n, -&n + 1u8]
            } else {
                vec![&n - 1u8, n.clone(), &n + 1u8]
            };
            for pair in values.windows(2) {
                prop_assert!(encode(&pair[0]) < encode(&pair[1]));
                prop_assert_eq!(decode(&encode(&pair[0])).unwrap(), pair[0].clone());
                if let (true, Some(a), Some(b)) = (bits < 2048, pair[0].to_biguint(), pair[1].to_biguint()) {
                    let (a, b) = (Viewpoint(a), Viewpoint(b));
                    prop_assert!(a.key().unwrap() > b.key().unwrap());
                    prop_assert_eq!(Viewpoint::from_key(&a.key().unwrap()).unwrap(), a);
                }
            }
        }

        #[test]
        fn arbitrary_text_never_panics(text in ".{0,200}") { let _ = decode(&text); }
    }
}
