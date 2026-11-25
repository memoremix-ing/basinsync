//! SHA-384 (FIPS 180-4) with lowercase hexadecimal rendering
//! (`docs/glossary/sha384.md`): 48-byte digests, 96 lowercase hex digits.
//! The digest comes from the audited `sha2` crate; the clean room's own
//! implementation was replaced when this became the codec kit.

/// Digest length in bytes.
pub const DIGEST_LEN: usize = 48;
/// Hex rendering length.
pub const HEX_LEN: usize = 96;

/// Digest of `data`.
pub fn digest(data: &[u8]) -> [u8; DIGEST_LEN] {
    use sha2::Digest;
    sha2::Sha384::digest(data).into()
}

/// Lowercase hex rendering of a digest (96 digits, leading zeros kept).
pub fn to_hex(digest: &[u8; DIGEST_LEN]) -> String {
    crate::hex::encode(digest)
}

/// Lowercase hex SHA-384 of `data`.
pub fn hex_digest(data: &[u8]) -> String {
    to_hex(&digest(data))
}

/// Parse a 96-digit lowercase hex digest.
pub fn from_hex(text: &str) -> crate::Result<[u8; DIGEST_LEN]> {
    if text.len() != HEX_LEN {
        return Err(crate::Error::LengthMismatch);
    }
    let v = crate::hex::decode_lower(text)?;
    let mut out = [0u8; DIGEST_LEN];
    out.copy_from_slice(&v);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use sha2::Digest;

    #[test]
    fn vectors() {
        assert_eq!(hex_digest(b""), "38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b");
        assert_eq!(hex_digest(b"abc"), "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7");
        let d = digest(b"abc");
        assert_eq!(from_hex(&to_hex(&d)).unwrap(), d);
        assert!(from_hex(&to_hex(&d).to_uppercase()).is_err());
        assert!(from_hex("00").is_err());
    }

    proptest! {
        #[test]
        fn hex_round_trips(data in prop::collection::vec(any::<u8>(), 0..400)) {
            let expect = sha2::Sha384::digest(&data);
            prop_assert_eq!(&digest(&data)[..], &expect[..]);
            prop_assert_eq!(from_hex(&hex_digest(&data)).unwrap(), digest(&data));
        }
    }
}
