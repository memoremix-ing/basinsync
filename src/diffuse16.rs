use anyhow::{Context, Result, ensure};
use num_bigint::{BigInt, BigUint, Sign};

pub const PREFIX: &str = "timeline/";

fn complement(digits: &str) -> String {
    digits
        .chars()
        .map(|d| char::from_digit(15 - d.to_digit(16).unwrap(), 16).unwrap())
        .collect()
}

pub fn encode(value: &BigInt) -> String {
    let negative = value.sign() == Sign::Minus;
    let magnitude = if negative { !value } else { value.clone() };
    let hex = magnitude.to_str_radix(16);
    let digits = if negative { complement(&hex) } else { hex };
    format!(
        "0w{}{}",
        digits.chars().rev().collect::<String>(),
        if negative { 'y' } else { 'z' }
    )
}

pub fn decode(encoded: &str) -> Result<BigInt> {
    let digits = encoded
        .strip_prefix("0w")
        .context("invalid Diffuse16 prefix")?;
    let negative = digits.ends_with('y');
    let digits = if negative {
        digits.strip_suffix('y')
    } else {
        digits.strip_suffix('z')
    }
    .context("invalid Diffuse16 sign")?;
    ensure!(
        !digits.is_empty()
            && digits
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid Diffuse16 digits"
    );
    let hex = digits.chars().rev().collect::<String>();
    let hex = if negative { complement(&hex) } else { hex };
    let magnitude = BigInt::parse_bytes(hex.as_bytes(), 16).context("invalid Diffuse16 integer")?;
    let value = if negative { !magnitude } else { magnitude };
    ensure!(encode(&value) == encoded, "noncanonical Diffuse16");
    Ok(value)
}

pub fn key(milestone: &BigUint) -> Result<String> {
    ensure!(
        *milestone != BigUint::from(0u8),
        "Milestone zero has no Timeline object"
    );
    let key = format!("{PREFIX}{}", encode(&BigInt::from(milestone.clone())));
    ensure!(key.len() <= 1024, "Milestone exceeds S3 key limit");
    Ok(key)
}

pub fn from_key(key: &str) -> Result<BigUint> {
    let value = decode(
        key.strip_prefix(PREFIX)
            .context("invalid Timeline prefix")?,
    )?
    .to_biguint()
    .context("Milestone must be positive")?;
    ensure!(self::key(&value)? == key, "invalid Timeline key");
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn vectors_and_invalid_keys() {
        for (n, wire) in [
            (0, "0w0z"),
            (1, "0w1z"),
            (15, "0wfz"),
            (16, "0w01z"),
            (27, "0wb1z"),
            (256, "0w001z"),
            (-1, "0wfy"),
            (-16, "0w0y"),
            (-17, "0wfey"),
            (-256, "0w00y"),
            (-257, "0wffey"),
        ] {
            assert_eq!(encode(&n.into()), wire);
            assert_eq!(decode(wire).unwrap(), n.into());
        }
        assert!(key(&0u8.into()).is_err());
        assert!(key(&16u8.into()).unwrap() < key(&1u8.into()).unwrap());
        for bad in [
            "", "0wz", "0w00z", "0w10z", "0wFz", "0w-1z", "0w1z/x", "0wffy", "0w0fy", "💧",
        ] {
            assert!(decode(bad).is_err());
        }
        for bad in [
            "timeline/0w0z",
            "timeline/0wfy",
            "timeline/0w1z/extra",
            "epilogue/0w1z",
        ] {
            assert!(from_key(bad).is_err());
        }
    }

    proptest! {
        #[test]
        fn arbitrary_precision_roundtrips(bytes in prop::collection::vec(any::<u8>(), 0..256)) {
            let value = BigInt::from_bytes_be(Sign::Plus, &bytes);
            prop_assert_eq!(decode(&encode(&value)).unwrap(), value.clone());
            if value != 0u8.into() { prop_assert_eq!(from_key(&key(&value.to_biguint().unwrap()).unwrap()).unwrap(), value.to_biguint().unwrap());
                let negative = !value;
                prop_assert_eq!(decode(&encode(&negative)).unwrap(), negative); }
        }
        #[test]
        fn arbitrary_text_never_panics(text in ".{0,200}") { let _ = decode(&text); }
    }
}
