//! The documented FlexBuffers layout rule for whole documents, for servers
//! that read them with a general FlexBuffers library: every value an offset
//! refers to, with its length prefix or map header, ends at or before the slot
//! holding that offset (docs/glossary/flexbuffers.md). Ported from the
//! reference implementation; `flexbuffers::parse_root` applies the same rule
//! to extension documents.
use crate::{Error, Result};

/// Check a stored FlexBuffers document's layout before parsing it.
pub fn check_layout(bytes: &[u8]) -> Result<()> {
    if !(bytes.len() >= 3) { return Err(Error::BadLayout); }
    let width = usize::from(bytes[bytes.len() - 1]);
    if !(matches!(width, 1 | 2 | 4 | 8)) { return Err(Error::BadLayout); }
    let slot = bytes
        .len()
        .checked_sub(2 + width)
        .ok_or(Error::BadLayout)?;
    let mut walk = Layout { bytes, visits: 0, seen: Default::default() };
    walk.value(slot, width, bytes[bytes.len() - 2], 0)
}

struct Layout<'a> {
    bytes: &'a [u8],
    visits: usize,
    seen: std::collections::HashSet<(usize, u8)>,
}

impl Layout<'_> {
    fn uint(&self, at: usize, width: usize) -> Result<usize> {
        let end = at.checked_add(width).ok_or(Error::BadLayout)?;
        let bytes = self.bytes.get(at..end).ok_or(Error::Truncated)?;
        let mut word = [0u8; 8];
        word[..width].copy_from_slice(bytes);
        usize::try_from(u64::from_le_bytes(word)).map_err(|_| Error::Overflow)
    }
    /// A referenced byte range must end at or before the slot referring to it.
    fn range(slot: usize, start: usize, len: usize) -> Result<()> {
        let end = start.checked_add(len).ok_or(Error::BadLayout)?;
        if !(end <= slot) { return Err(Error::BadLayout); }
        Ok(())
    }
    fn value(&mut self, slot: usize, slot_width: usize, packed: u8, depth: usize) -> Result<()> {
        if !(depth <= 128) { return Err(Error::BadLayout); }
        let kind = packed >> 2;
        let width = 1usize << (packed & 3);
        // Inline scalars: null, int, uint, float, bool.
        if matches!(kind, 0..=3 | 26) {
            return Ok(());
        }
        let offset = self.uint(slot, slot_width)?;
        let target = slot.checked_sub(offset).ok_or(Error::BadLayout)?;
        if !self.seen.insert((target, packed)) {
            return Ok(()); // shared values were already checked
        }
        self.visits += 1;
        if !(self.visits <= 4 * self.bytes.len() + 16) { return Err(Error::BadLayout); }
        let prefixed = |walk: &Self| -> Result<usize> {
            let at = target.checked_sub(width).ok_or(Error::BadLayout)?;
            walk.uint(at, width)
        };
        match kind {
            4 => {
                // Key: NUL-terminated bytes.
                let end = self.bytes[target..slot]
                    .iter()
                    .position(|&b| b == 0)
                    .ok_or(Error::BadLayout)?;
                Self::range(slot, target, end + 1)
            }
            5 | 25 => {
                let len = prefixed(self)?;
                Self::range(slot, target - width, width + len + usize::from(kind == 5))
            }
            6..=8 => Self::range(slot, target, width),
            9 | 10 => {
                let len = prefixed(self)?;
                let elements = len.checked_mul(width).ok_or(Error::BadLayout)?;
                Self::range(slot, target - width, width + elements + len)?;
                if kind == 9 {
                    Self::range(slot, target.checked_sub(3 * width).ok_or(Error::BadLayout)?, 3 * width)?;
                }
                for i in 0..len {
                    let child = self.bytes[target + elements + i];
                    self.value(target + i * width, width, child, depth + 1)?;
                }
                if kind == 9 {
                    let keys_at = target.checked_sub(3 * width).ok_or(Error::BadLayout)?;
                    let keys_width = self.uint(keys_at + width, width)?;
                    if !(matches!(keys_width, 1 | 2 | 4 | 8)) { return Err(Error::BadLayout); }
                    let keys_packed = (14 << 2) | keys_width.trailing_zeros() as u8;
                    self.value(keys_at, width, keys_packed, depth + 1)?;
                }
                Ok(())
            }
            11..=15 | 36 => {
                let len = prefixed(self)?;
                let elements = len.checked_mul(width).ok_or(Error::BadLayout)?;
                Self::range(slot, target - width, width + elements)?;
                // Key vectors (and the deprecated string vectors) hold offsets.
                let child = match kind { 14 => Some(4u8), 15 => Some(5u8), _ => None };
                if let Some(child) = child {
                    for i in 0..len {
                        self.value(target + i * width, width, (child << 2) | (packed & 3), depth + 1)?;
                    }
                }
                Ok(())
            }
            16..=24 => Self::range(slot, target, (2 + usize::from((kind - 16) / 3)) * width),
            _ => return Err(Error::BadLayout),
        }
    }
}

