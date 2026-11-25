//! Object-key prefixes, key builders and Flow-id normalization
//! (`docs/object-keys.md`).

use crate::bigint::BigInt;
use crate::error::{Error, Result};
use crate::lexidecimal;
use crate::sha384;

/// Basin Timeline DifferentialEvents: `${TIMELINE}${lex(~milestone)}`.
pub const TIMELINE: &str = "kernelspace/basin/timeline/";
/// Basin Epilogue (backup CommitMarkers and PromotionSigns).
pub const BASIN_EPILOGUE: &str = "kernelspace/basin/epilogue/";
/// Basin Analogue BulkOrders.
pub const ANALOGUE: &str = "kernelspace/basin/analogue/";
/// KernelSpace Heap (followed by `young/` or `old/`).
pub const KERNEL_HEAP: &str = "kernelspace/basin/heap/";
/// UserSpace Heap (followed by `young/` or `old/`).
pub const USER_HEAP: &str = "userspace/heap/";
/// UserSpace Flows.
pub const USER_FLOWS: &str = "userspace/flows/";
/// The empty-validator reference object (a full key).
pub const EMPTY_SENTINEL: &str = "kernelspace/sentinel/empty";
/// Tombstone probe prefix (followed by decimal length).
pub const TOMBSTONE_PROBES: &str = "kernelspace/sentinel/tombstone/";
/// Margin probe prefix (followed by decimal counter).
pub const MARGIN_PROBES: &str = "kernelspace/sentinel/margin/";
/// S3 key length limit in bytes.
pub const MAX_KEY_LEN: usize = 1024;
/// Longest Flow id.
pub const MAX_FLOW_ID_LEN: usize = 160;

/// Whether `c` may appear in a Flow id.
#[inline]
pub const fn is_flow_id_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-'
}

/// Normalize a Flow id in place into `out`, returning its length: accept
/// 1–160 ASCII letters, digits, `.`, `_` or `-`, excluding `.` and `..`,
/// and lowercase letters. Allocation-free core of [`normalize_flow_id`].
pub fn normalize_flow_id_into(id: &[u8], out: &mut [u8]) -> Result<usize> {
    let n = id.len();
    if n == 0 || n > MAX_FLOW_ID_LEN {
        return Err(Error::BadFlowId);
    }
    if out.len() < n {
        return Err(Error::BufferTooSmall);
    }
    if id == b"." || id == b".." {
        return Err(Error::BadFlowId);
    }
    let mut i = 0;
    while i < n {
        let c = id[i];
        if !is_flow_id_byte(c) {
            return Err(Error::BadFlowId);
        }
        out[i] = c.to_ascii_lowercase();
        i += 1;
    }
    Ok(n)
}

/// Canonical (lowercase) Flow id.
pub fn normalize_flow_id(id: &str) -> Result<String> {
    let mut buf = [0u8; MAX_FLOW_ID_LEN];
    let n = normalize_flow_id_into(id.as_bytes(), &mut buf)?;
    Ok(String::from_utf8(buf[..n].to_vec()).expect("ascii"))
}

/// Whether `s` is a lowercase UUIDv4 string (a basinsync revision).
pub fn is_revision(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, &c) in b.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => c == b'-',
            14 => c == b'4',
            19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
            _ => crate::hex::lower_digit_value(c).is_some(),
        };
        if !ok {
            return false;
        }
    }
    true
}

fn check_len(key: String) -> Result<String> {
    if key.len() > MAX_KEY_LEN {
        return Err(Error::Overflow);
    }
    Ok(key)
}

fn require_revision(r: &str) -> Result<()> {
    if is_revision(r) {
        Ok(())
    } else {
        Err(Error::BadKey)
    }
}

/// `kernelspace/basin/timeline/${lex(~milestone)}`; Milestones start at one.
pub fn timeline_key(milestone: &BigInt) -> Result<String> {
    if *milestone < BigInt::from_i128(1) {
        return Err(Error::OutOfRange);
    }
    check_len(format!("{TIMELINE}{}", lexidecimal::encode(&milestone.not())))
}

/// Inverse of [`timeline_key`]: the Milestone a Timeline key names.
pub fn timeline_milestone(key: &str) -> Result<BigInt> {
    let rest = key.strip_prefix(TIMELINE).ok_or(Error::BadKey)?;
    let m = lexidecimal::decode(rest)?.not();
    if m < BigInt::from_i128(1) {
        return Err(Error::OutOfRange);
    }
    if key.len() > MAX_KEY_LEN {
        return Err(Error::Overflow);
    }
    Ok(m)
}

fn require_nonnegative(v: &BigInt) -> Result<()> {
    if v.is_negative() {
        Err(Error::OutOfRange)
    } else {
        Ok(())
    }
}

/// Basin backup CommitMarker: `kernelspace/basin/epilogue/${lex(~viewpoint)}`.
pub fn basin_commit_marker_key(viewpoint: &BigInt) -> Result<String> {
    require_nonnegative(viewpoint)?;
    check_len(format!("{BASIN_EPILOGUE}{}", lexidecimal::encode(&viewpoint.not())))
}

/// Basin PromotionSign: `kernelspace/basin/epilogue/${lex(viewpoint)}`.
pub fn basin_promotion_sign_key(viewpoint: &BigInt) -> Result<String> {
    require_nonnegative(viewpoint)?;
    check_len(format!("{BASIN_EPILOGUE}{}", lexidecimal::encode(viewpoint)))
}

/// Flow CommitMarker:
/// `userspace/flows/${flow}/${flow_revision}/epilogue/${lex(~viewpoint)}`.
pub fn flow_commit_marker_key(flow: &str, revision: &str, viewpoint: &BigInt) -> Result<String> {
    let flow = normalize_flow_id(flow)?;
    require_revision(revision)?;
    require_nonnegative(viewpoint)?;
    check_len(format!("{USER_FLOWS}{flow}/{revision}/epilogue/{}", lexidecimal::encode(&viewpoint.not())))
}

/// Flow PromotionSign:
/// `userspace/flows/${flow}/${flow_revision}/epilogue/${lex(viewpoint)}`.
pub fn flow_promotion_sign_key(flow: &str, revision: &str, viewpoint: &BigInt) -> Result<String> {
    let flow = normalize_flow_id(flow)?;
    require_revision(revision)?;
    require_nonnegative(viewpoint)?;
    check_len(format!("{USER_FLOWS}{flow}/{revision}/epilogue/{}", lexidecimal::encode(viewpoint)))
}

/// Basin Analogue BulkOrder:
/// `kernelspace/basin/analogue/${lex(~lowest)}/${lex(~highest)}/v0/${bulkmanifest_start}/${coordinate}`.
/// `lowest` is inclusive (>= 1), `highest` exclusive.
pub fn analogue_key(lowest: &BigInt, highest: &BigInt, bulkmanifest_start: &BigInt, coordinate: &BigInt) -> Result<String> {
    if *lowest < BigInt::from_i128(1) || highest <= lowest {
        return Err(Error::OutOfRange);
    }
    require_nonnegative(bulkmanifest_start)?;
    require_nonnegative(coordinate)?;
    check_len(format!(
        "{ANALOGUE}{}/{}/v0/{}/{}",
        lexidecimal::encode(&lowest.not()),
        lexidecimal::encode(&highest.not()),
        bulkmanifest_start.to_decimal(),
        coordinate.to_decimal()
    ))
}

/// Heap generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Generation {
    /// `young/`
    Young,
    /// `old/`
    Old,
}

impl Generation {
    fn segment(self) -> &'static str {
        match self {
            Generation::Young => "young",
            Generation::Old => "old",
        }
    }
}

/// Heap space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Space {
    /// KernelSpace (`kernelspace/basin/heap/`).
    Kernel,
    /// UserSpace (`userspace/heap/`).
    User,
}

/// Node id: `n-${lex(~height)}/v.${lex(version)}/t.${lex(token.length)}/d_${sha384(token)}`.
pub fn node_id(height: &BigInt, version: &BigInt, token: &[u8]) -> Result<String> {
    require_nonnegative(height)?;
    require_nonnegative(version)?;
    Ok(format!(
        "n-{}/v.{}/t.{}/d_{}",
        lexidecimal::encode(&height.not()),
        lexidecimal::encode(version),
        lexidecimal::encode(&BigInt::from_u128(token.len() as u128)),
        sha384::hex_digest(token)
    ))
}

/// Heap node object key: `${space heap}${generation}/${node_id}/${node_revision}`.
pub fn heap_key(space: Space, generation: Generation, node_id: &str, revision: &str) -> Result<String> {
    require_revision(revision)?;
    let prefix = match space {
        Space::Kernel => KERNEL_HEAP,
        Space::User => USER_HEAP,
    };
    check_len(format!("{prefix}{}/{node_id}/{revision}", generation.segment()))
}

/// Retainer kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetainerKind {
    /// `_a_`: staging area.
    Staging,
    /// `_m_`: CommitMarker.
    CommitMarker,
}

/// Database retainer id: `_a_${owner}/v.${lex(version)}/e.${lex(viewpoint)}`
/// (or `_m_`). `owner` is a Flow id, or `None` for the KernelSpace owner
/// `basin`.
pub fn retainer_id(kind: RetainerKind, owner: Option<&str>, version: &BigInt, viewpoint: &BigInt) -> Result<String> {
    let owner = match owner {
        Some(flow) => normalize_flow_id(flow)?,
        None => "basin".to_string(),
    };
    require_nonnegative(version)?;
    require_nonnegative(viewpoint)?;
    let tag = match kind {
        RetainerKind::Staging => "_a_",
        RetainerKind::CommitMarker => "_m_",
    };
    Ok(format!("{tag}{owner}/v.{}/e.{}", lexidecimal::encode(version), lexidecimal::encode(viewpoint)))
}

/// Tombstone probe key (`length` is decimal 2, 4, ..., 14).
pub fn tombstone_probe_key(length: u8) -> Result<String> {
    if length < 2 || length > 14 || length % 2 != 0 {
        return Err(Error::OutOfRange);
    }
    Ok(format!("{TOMBSTONE_PROBES}{length}"))
}

/// Margin probe key (`counter` 1..=7).
pub fn margin_probe_key(counter: u8) -> Result<String> {
    if !(1..=7).contains(&counter) {
        return Err(Error::OutOfRange);
    }
    Ok(format!("{MARGIN_PROBES}{counter}"))
}

/// Tombstone candidate bytes of `length` (repetitions of `0xdead`).
pub fn tombstone_candidate(length: u8) -> Result<Vec<u8>> {
    tombstone_probe_key(length)?;
    Ok([0xde, 0xad].iter().copied().cycle().take(length as usize).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn b(v: i128) -> BigInt {
        BigInt::from_i128(v)
    }

    #[test]
    fn flow_ids() {
        assert_eq!(normalize_flow_id("My.Flow_1-X").unwrap(), "my.flow_1-x");
        assert_eq!(normalize_flow_id("...").unwrap(), "...");
        assert_eq!(normalize_flow_id(&"A".repeat(160)).unwrap(), "a".repeat(160));
        for bad in ["", ".", "..", "a/b", "a b", "é", "a\0", &"a".repeat(161)] {
            assert!(normalize_flow_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn timeline() {
        assert_eq!(timeline_key(&b(1)).unwrap(), "kernelspace/basin/timeline/0yve");
        assert_eq!(timeline_key(&b(16)).unwrap(), "kernelspace/basin/timeline/0yuef");
        assert!(timeline_key(&b(0)).is_err());
        assert_eq!(timeline_milestone("kernelspace/basin/timeline/0yve").unwrap(), b(1));
        assert!(timeline_milestone("kernelspace/basin/timeline/0yvf").is_err()); // milestone 0
        assert!(timeline_milestone("kernelspace/basin/timeline/0zg1").is_err());
        assert!(timeline_milestone("kernelspace/basin/epilogue/0yve").is_err());
        assert!(timeline_key(&b(2)).unwrap() < timeline_key(&b(1)).unwrap());
    }

    #[test]
    fn other_keys() {
        let rev = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert!(is_revision(rev));
        assert!(!is_revision("0F8FAD5B-D9CB-469F-A165-70867728950E"));
        assert!(!is_revision("0f8fad5b-d9cb-169f-a165-70867728950e"));
        assert_eq!(basin_commit_marker_key(&b(0)).unwrap(), "kernelspace/basin/epilogue/0yvf");
        assert_eq!(basin_promotion_sign_key(&b(0)).unwrap(), "kernelspace/basin/epilogue/0zg0");
        assert_eq!(
            flow_commit_marker_key("Chat", rev, &b(1)).unwrap(),
            format!("userspace/flows/chat/{rev}/epilogue/0yve")
        );
        assert_eq!(
            analogue_key(&b(42), &b(45), &b(1976), &b(65536)).unwrap(),
            "kernelspace/basin/analogue/0yud5/0yud2/v0/1976/65536"
        );
        let id = node_id(&b(0), &b(0), b"").unwrap();
        assert!(id.starts_with("n-0yvf/v.0zg0/t.0zg0/d_38b060a7"));
        assert_eq!(
            heap_key(Space::User, Generation::Old, &id, rev).unwrap(),
            format!("userspace/heap/old/{id}/{rev}")
        );
        assert_eq!(
            retainer_id(RetainerKind::Staging, None, &b(0), &b(3)).unwrap(),
            "_a_basin/v.0zg0/e.0zg3"
        );
        assert_eq!(tombstone_candidate(6).unwrap(), vec![0xde, 0xad, 0xde, 0xad, 0xde, 0xad]);
        assert!(tombstone_probe_key(16).is_err());
        assert_eq!(margin_probe_key(7).unwrap(), "kernelspace/sentinel/margin/7");
    }

    proptest! {
        #[test]
        fn timeline_roundtrip(m in 1u64..) {
            let k = timeline_key(&BigInt::from(m)).unwrap();
            prop_assert_eq!(timeline_milestone(&k).unwrap(), BigInt::from(m));
        }

        #[test]
        fn flow_idempotent(s in "[A-Za-z0-9._/ -]{0,12}") {
            if let Ok(n) = normalize_flow_id(&s) {
                prop_assert_eq!(normalize_flow_id(&n).unwrap(), n.clone());
                prop_assert_eq!(n, s.to_ascii_lowercase());
            }
        }
    }
}
