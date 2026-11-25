//! EnvBuf ("Enveloped Buffers"): concatenable binary envelopes with matching
//! headers and footers (`docs/glossary/envbuf.md`, `docs/glossary/margin.md`).
//!
//! ```text
//! header: "enV" | format:3, alignment_power:5 | message_length:u32le
//! message (message_length bytes)
//! padding (0xee) up to ceil((message_length + 16) / alignment) * alignment
//! footer: message_length:u32le | format:3, alignment_power:5 | "vNE"
//! ```
//!
//! A concatenation of envelopes is a *feed*. Format `110` envelopes are
//! *margins*: skippable, but their framing is still validated. Format `100`
//! nests a feed whose inner boundaries are validated relative to the
//! containing message.
//!
//! [`encode_into`], [`parse_at`], [`parse_ending_at`] and
//! [`validate_feed`] are allocation-free and proven by Kani.

use crate::error::{Error, Result};

/// Header magic.
pub const HEADER_MAGIC: [u8; 3] = *b"enV";
/// Footer magic.
pub const FOOTER_MAGIC: [u8; 3] = *b"vNE";
/// Header (and footer) length.
pub const HEADER_LEN: usize = 8;
/// Combined header and footer length; also the smallest envelope.
pub const FRAMING_LEN: usize = 16;
/// Alignment padding byte.
pub const PADDING: u8 = 0xee;
/// Default alignment power (eight bytes).
pub const DEFAULT_ALIGNMENT_POWER: u8 = 3;
/// Deepest nesting of format-`100` feeds that [`validate_feed`] follows.
pub const MAX_NESTING: usize = 32;

/// Format codes (the descriptor's high three bits).
pub mod format {
    /// `000`: unknown/raw message.
    pub const RAW: u8 = 0b000;
    /// `100`: nested EnvBuf feed.
    pub const NESTED: u8 = 0b100;
    /// `101`: FlexBuffers message.
    pub const FLEXBUFFERS: u8 = 0b101;
    /// `110`: margin (skippable).
    pub const MARGIN: u8 = 0b110;
    /// `111`: reserved for platform extensions (larger headers); unsupported.
    pub const EXTENSION: u8 = 0b111;
}

/// Default FlexBuffers descriptor (`0xa3`).
pub const FLEXBUFFERS_DESCRIPTOR: u8 = 0xa3;
/// Default nested-feed descriptor (`0x83`).
pub const NESTED_DESCRIPTOR: u8 = 0x83;
/// Default raw descriptor (`0x03`).
pub const RAW_DESCRIPTOR: u8 = 0x03;
/// Default margin descriptor (`0xc3`).
pub const MARGIN_DESCRIPTOR: u8 = 0xc3;
/// Every margin is 24 bytes with default alignment.
pub const MARGIN_LEN: usize = 24;

/// Whether this build reads and writes `format`. `001`, `010`, `011` are
/// reserved and `111` (larger headers) is pending, so all four are refused.
#[inline]
pub const fn is_supported_format(format: u8) -> bool {
    matches!(format, format::RAW | format::NESTED | format::FLEXBUFFERS | format::MARGIN)
}

/// Build a descriptor byte.
pub const fn descriptor(format: u8, alignment_power: u8) -> Result<u8> {
    if format > 7 || alignment_power > 31 {
        return Err(Error::BadDescriptor);
    }
    if !is_supported_format(format) {
        return Err(Error::ReservedFormat);
    }
    Ok(format << 5 | alignment_power)
}

/// Split a descriptor byte into `(format, alignment_power)`.
#[inline]
pub const fn split_descriptor(d: u8) -> (u8, u8) {
    (d >> 5, d & 0x1f)
}

/// Complete envelope length for a message: header, message, padding, footer.
pub const fn envelope_len(message_len: usize, alignment_power: u8) -> Result<usize> {
    if message_len > u32::MAX as usize {
        return Err(Error::Overflow);
    }
    if alignment_power > 31 {
        return Err(Error::BadDescriptor);
    }
    // `align` is a power of two, so rounding up is a mask (and avoids a
    // symbolic division, which model checkers handle poorly).
    let mask = (1u64 << alignment_power) - 1;
    let raw = message_len as u64 + FRAMING_LEN as u64;
    let total = (raw + mask) & !mask;
    if total > usize::MAX as u64 {
        return Err(Error::Overflow);
    }
    Ok(total as usize)
}

/// Encode one envelope into `out`, returning its length. Does not inspect
/// the message (see [`validate_message`]).
pub fn encode_into(format: u8, alignment_power: u8, message: &[u8], out: &mut [u8]) -> Result<usize> {
    let d = descriptor(format, alignment_power)?;
    let total = envelope_len(message.len(), alignment_power)?;
    if out.len() < total {
        return Err(Error::BufferTooSmall);
    }
    let len = (message.len() as u32).to_le_bytes();
    out[..3].copy_from_slice(&HEADER_MAGIC);
    out[3] = d;
    out[4..8].copy_from_slice(&len);
    let end = HEADER_LEN + message.len();
    out[HEADER_LEN..end].copy_from_slice(message);
    let footer = total - HEADER_LEN;
    let mut i = end;
    while i < footer {
        out[i] = PADDING;
        i += 1;
    }
    out[footer..footer + 4].copy_from_slice(&len);
    out[footer + 4] = d;
    out[footer + 5..total].copy_from_slice(&FOOTER_MAGIC);
    Ok(total)
}

/// Encode one envelope, validating a nested feed's inner framing first.
pub fn encode(format: u8, alignment_power: u8, message: &[u8]) -> Result<Vec<u8>> {
    descriptor(format, alignment_power)?;
    validate_message(format, message, 0)?;
    let total = envelope_len(message.len(), alignment_power)?;
    let mut out = vec![0u8; total];
    encode_into(format, alignment_power, message, &mut out)?;
    Ok(out)
}

/// One envelope located inside a feed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Envelope {
    /// Offset of the header within the feed.
    pub offset: usize,
    /// Complete envelope length, including framing and padding.
    pub len: usize,
    /// Format code (three bits).
    pub format: u8,
    /// Alignment power (five bits).
    pub alignment_power: u8,
    /// Message length (excludes padding and framing).
    pub message_len: usize,
}

impl Envelope {
    /// Exclusive end offset within the feed.
    pub const fn end(&self) -> usize {
        self.offset + self.len
    }
    /// Offset of the message within the feed (eight bytes after the header).
    pub const fn message_start(&self) -> usize {
        self.offset + HEADER_LEN
    }
    /// The message bytes.
    pub fn message<'a>(&self, feed: &'a [u8]) -> &'a [u8] {
        &feed[self.message_start()..self.message_start() + self.message_len]
    }
    /// The complete envelope bytes.
    pub fn bytes<'a>(&self, feed: &'a [u8]) -> &'a [u8] {
        &feed[self.offset..self.end()]
    }
    /// Whether this is a margin (format `110`).
    pub const fn is_margin(&self) -> bool {
        self.format == format::MARGIN
    }
    /// The descriptor byte.
    pub const fn descriptor(&self) -> u8 {
        self.format << 5 | self.alignment_power
    }
}

/// Parse and fully validate the envelope whose header starts at `offset`:
/// magic markers, supported format, matching footer, `0xee` padding, and
/// that the whole envelope lies within `feed`. Nested feeds are *not*
/// descended into (see [`validate_feed`]).
pub fn parse_at(feed: &[u8], offset: usize) -> Result<Envelope> {
    let n = feed.len();
    if offset > n || n - offset < HEADER_LEN {
        return Err(Error::Truncated);
    }
    let h = offset;
    if feed[h] != HEADER_MAGIC[0] || feed[h + 1] != HEADER_MAGIC[1] || feed[h + 2] != HEADER_MAGIC[2] {
        return Err(Error::BadPrefix);
    }
    let d = feed[h + 3];
    let (fmt, power) = split_descriptor(d);
    if !is_supported_format(fmt) {
        return Err(Error::ReservedFormat);
    }
    let message_len = u32::from_le_bytes([feed[h + 4], feed[h + 5], feed[h + 6], feed[h + 7]]) as usize;
    let total = envelope_len(message_len, power)?;
    if n - offset < total {
        return Err(Error::Truncated);
    }
    let f = offset + total - HEADER_LEN;
    let footer_len = u32::from_le_bytes([feed[f], feed[f + 1], feed[f + 2], feed[f + 3]]) as usize;
    if footer_len != message_len || feed[f + 4] != d {
        return Err(Error::FramingMismatch);
    }
    if feed[f + 5] != FOOTER_MAGIC[0] || feed[f + 6] != FOOTER_MAGIC[1] || feed[f + 7] != FOOTER_MAGIC[2] {
        return Err(Error::BadPrefix);
    }
    let mut i = offset + HEADER_LEN + message_len;
    while i < f {
        if feed[i] != PADDING {
            return Err(Error::BadPadding);
        }
        i += 1;
    }
    Ok(Envelope { offset, len: total, format: fmt, alignment_power: power, message_len })
}

/// Parse and fully validate the envelope whose footer ends at `end`, for
/// backward traversal.
pub fn parse_ending_at(feed: &[u8], end: usize) -> Result<Envelope> {
    if end > feed.len() || end < HEADER_LEN {
        return Err(Error::Truncated);
    }
    let f = end - HEADER_LEN;
    if feed[f + 5] != FOOTER_MAGIC[0] || feed[f + 6] != FOOTER_MAGIC[1] || feed[f + 7] != FOOTER_MAGIC[2] {
        return Err(Error::BadPrefix);
    }
    let message_len = u32::from_le_bytes([feed[f], feed[f + 1], feed[f + 2], feed[f + 3]]) as usize;
    let (fmt, power) = split_descriptor(feed[f + 4]);
    if !is_supported_format(fmt) {
        return Err(Error::ReservedFormat);
    }
    let total = envelope_len(message_len, power)?;
    if total > end {
        return Err(Error::Truncated);
    }
    let env = parse_at(&feed[..end], end - total)?;
    if env.len != total {
        return Err(Error::FramingMismatch);
    }
    Ok(env)
}

/// Validate a message's contents for its format: a nested feed (`100`)
/// must itself be a valid feed. Other formats are opaque here. `depth` is
/// the nesting level of the envelope carrying `message` (0 = outermost).
pub fn validate_message(format: u8, message: &[u8], depth: usize) -> Result<()> {
    if format == format::NESTED {
        if depth >= MAX_NESTING {
            return Err(Error::TooDeep);
        }
        validate_feed_at_depth(message, depth + 1)?;
    }
    Ok(())
}

/// Iterative feed validation with an explicit, fixed-size stack (no
/// recursion, no allocation), so model checkers need not unwind recursion.
/// Returns the number of envelopes at the starting level.
fn validate_feed_at_depth(feed: &[u8], start_depth: usize) -> Result<usize> {
    // ends[k]: exclusive end of the feed open at stack level k;
    // resume[k]: where the enclosing feed continues once level k is done.
    let mut ends = [0usize; MAX_NESTING + 1];
    let mut resume = [0usize; MAX_NESTING + 1];
    let mut level = 0usize;
    ends[0] = feed.len();
    let mut pos = 0usize;
    let mut count = 0usize;
    loop {
        if pos == ends[level] {
            if level == 0 {
                return Ok(count);
            }
            pos = resume[level];
            level -= 1;
            continue;
        }
        let env = parse_at(&feed[..ends[level]], pos)?;
        if level == 0 {
            count += 1;
        }
        if env.format == format::NESTED {
            if start_depth + level >= MAX_NESTING || level >= MAX_NESTING {
                return Err(Error::TooDeep);
            }
            level += 1;
            ends[level] = env.message_start() + env.message_len;
            resume[level] = env.end();
            pos = env.message_start();
        } else {
            pos = env.end();
        }
    }
}

/// Validate a complete feed (zero or more envelopes, exactly filling
/// `feed`), descending into nested feeds. Returns the envelope count.
pub fn validate_feed(feed: &[u8]) -> Result<usize> {
    validate_feed_at_depth(feed, 0)
}

/// Decode exactly one envelope occupying all of `wire`, validating nested
/// feeds. Returns the envelope; use [`Envelope::message`] for the content.
pub fn decode_one(wire: &[u8]) -> Result<Envelope> {
    let env = decode_envelope(wire)?;
    validate_message(env.format, env.message(wire), 0)?;
    Ok(env)
}

/// Framing-only core of [`decode_one`]: exactly one fully validated
/// envelope occupying all of `wire`, without descending into a nested feed.
pub fn decode_envelope(wire: &[u8]) -> Result<Envelope> {
    let env = parse_at(wire, 0)?;
    if env.len != wire.len() {
        return Err(Error::LengthMismatch);
    }
    Ok(env)
}

/// Forward iterator over a feed's envelopes (including margins). Stops
/// after the first error.
#[derive(Debug, Clone)]
pub struct Envelopes<'a> {
    feed: &'a [u8],
    offset: usize,
    failed: bool,
}

impl<'a> Iterator for Envelopes<'a> {
    type Item = Result<Envelope>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.failed || self.offset >= self.feed.len() {
            return None;
        }
        match parse_at(self.feed, self.offset) {
            Ok(env) => {
                self.offset = env.end();
                Some(Ok(env))
            }
            Err(e) => {
                self.failed = true;
                Some(Err(e))
            }
        }
    }
}

/// Iterate a feed forward.
pub fn envelopes(feed: &[u8]) -> Envelopes<'_> {
    Envelopes { feed, offset: 0, failed: false }
}

/// Backward iterator over a feed's envelopes using footers.
#[derive(Debug, Clone)]
pub struct EnvelopesRev<'a> {
    feed: &'a [u8],
    end: usize,
    failed: bool,
}

impl<'a> Iterator for EnvelopesRev<'a> {
    type Item = Result<Envelope>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.failed || self.end == 0 {
            return None;
        }
        match parse_ending_at(self.feed, self.end) {
            Ok(env) => {
                self.end = env.offset;
                Some(Ok(env))
            }
            Err(e) => {
                self.failed = true;
                Some(Err(e))
            }
        }
    }
}

/// Iterate a feed backward from its end.
pub fn envelopes_rev(feed: &[u8]) -> EnvelopesRev<'_> {
    EnvelopesRev { feed, end: feed.len(), failed: false }
}

/// Non-margin messages of a feed in order, as `(format, message)`; margins
/// are skipped after their framing is validated.
pub fn messages(feed: &[u8]) -> Result<Vec<(u8, &[u8])>> {
    let mut out = Vec::new();
    for env in envelopes(feed) {
        let env = env?;
        if !env.is_margin() {
            out.push((env.format, env.message(feed)));
        }
    }
    Ok(out)
}

/// A feed's default trailing counter margin: a 24-byte format-`110`
/// envelope whose eight-byte message is `counter` as little-endian `u64`.
pub fn counter_margin(counter: u64) -> [u8; MARGIN_LEN] {
    let mut out = [0u8; MARGIN_LEN];
    encode_into(format::MARGIN, DEFAULT_ALIGNMENT_POWER, &counter.to_le_bytes(), &mut out)
        .expect("24 bytes");
    out
}

/// A standalone margin: a 24-byte envelope with one `u8` message, 1..=7.
pub fn standalone_margin(counter: u8) -> Result<[u8; MARGIN_LEN]> {
    if !(1..=7).contains(&counter) {
        return Err(Error::OutOfRange);
    }
    let mut out = [0u8; MARGIN_LEN];
    encode_into(format::MARGIN, DEFAULT_ALIGNMENT_POWER, &[counter], &mut out)?;
    Ok(out)
}

/// Read the counter of a 24-byte counter margin envelope.
pub fn counter_margin_value(wire: &[u8]) -> Result<u64> {
    let env = decode_one(wire)?;
    if !env.is_margin() || env.message_len != 8 || env.alignment_power != DEFAULT_ALIGNMENT_POWER {
        return Err(Error::BadPrefix);
    }
    let m = env.message(wire);
    Ok(u64::from_le_bytes([m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7]]))
}

/// Read the counter of a standalone margin (1..=7).
pub fn standalone_margin_value(wire: &[u8]) -> Result<u8> {
    let env = decode_one(wire)?;
    if !env.is_margin() || env.message_len != 1 || env.alignment_power != DEFAULT_ALIGNMENT_POWER {
        return Err(Error::BadPrefix);
    }
    let c = env.message(wire)[0];
    if !(1..=7).contains(&c) {
        return Err(Error::OutOfRange);
    }
    Ok(c)
}

/// Length of the feed without its trailing margins (the margin-free prefix
/// that digests and coordinates cover).
pub fn margin_free_len(feed: &[u8]) -> Result<usize> {
    let mut end = feed.len();
    while end > 0 {
        let env = parse_ending_at(feed, end)?;
        if !env.is_margin() {
            break;
        }
        end = env.offset;
    }
    Ok(end)
}

/// Increment a feed's trailing counter margin in place, returning the new
/// counter. The counter never wraps.
pub fn bump_counter_margin(feed: &mut [u8]) -> Result<u64> {
    if feed.len() < MARGIN_LEN {
        return Err(Error::Truncated);
    }
    let start = feed.len() - MARGIN_LEN;
    let current = counter_margin_value(&feed[start..])?;
    let next = current.checked_add(1).ok_or(Error::Overflow)?;
    feed[start..].copy_from_slice(&counter_margin(next));
    Ok(next)
}

/// Incremental feed builder.
#[derive(Debug, Clone, Default)]
pub struct FeedBuilder {
    buf: Vec<u8>,
}

impl FeedBuilder {
    /// Empty feed.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append one envelope, returning its location.
    pub fn push(&mut self, format: u8, alignment_power: u8, message: &[u8]) -> Result<Envelope> {
        descriptor(format, alignment_power)?;
        validate_message(format, message, 0)?;
        let total = envelope_len(message.len(), alignment_power)?;
        let offset = self.buf.len();
        self.buf.resize(offset + total, 0);
        encode_into(format, alignment_power, message, &mut self.buf[offset..])?;
        Ok(Envelope { offset, len: total, format, alignment_power, message_len: message.len() })
    }

    /// Append a FlexBuffers message with the default descriptor.
    pub fn push_flexbuffers(&mut self, message: &[u8]) -> Result<Envelope> {
        self.push(format::FLEXBUFFERS, DEFAULT_ALIGNMENT_POWER, message)
    }

    /// Append a raw message with the default descriptor.
    pub fn push_raw(&mut self, message: &[u8]) -> Result<Envelope> {
        self.push(format::RAW, DEFAULT_ALIGNMENT_POWER, message)
    }

    /// Append a nested feed with the default descriptor.
    pub fn push_nested(&mut self, feed: &[u8]) -> Result<Envelope> {
        self.push(format::NESTED, DEFAULT_ALIGNMENT_POWER, feed)
    }

    /// Append a counter margin.
    pub fn push_counter_margin(&mut self, counter: u64) -> Envelope {
        let offset = self.buf.len();
        self.buf.extend_from_slice(&counter_margin(counter));
        Envelope {
            offset,
            len: MARGIN_LEN,
            format: format::MARGIN,
            alignment_power: DEFAULT_ALIGNMENT_POWER,
            message_len: 8,
        }
    }

    /// Current length.
    pub fn len(&self) -> usize {
        self.buf.len()
    }

    /// Whether nothing has been appended.
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Bytes so far.
    pub fn as_bytes(&self) -> &[u8] {
        &self.buf
    }

    /// Finish without a trailing margin.
    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    /// Finish with the default trailing counter margin starting at zero.
    pub fn finish_with_margin(mut self) -> Vec<u8> {
        self.push_counter_margin(0);
        self.buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn layout() {
        let e = encode(format::FLEXBUFFERS, 3, b"abc").unwrap();
        assert_eq!(e.len(), 24);
        assert_eq!(&e[..8], &[b'e', b'n', b'V', 0xa3, 3, 0, 0, 0]);
        assert_eq!(&e[8..11], b"abc");
        assert_eq!(&e[11..16], &[0xee; 5]);
        assert_eq!(&e[16..], &[3, 0, 0, 0, 0xa3, b'v', b'N', b'E']);
        let empty = encode(format::RAW, 3, b"").unwrap();
        assert_eq!(empty, [b'e', b'n', b'V', 3, 0, 0, 0, 0, 0, 0, 0, 0, 3, b'v', b'N', b'E']);
        // alignment 1: no padding
        assert_eq!(encode(format::RAW, 0, b"x").unwrap().len(), 17);
        // alignment 32
        assert_eq!(encode(format::RAW, 5, b"x").unwrap().len(), 32);
        assert_eq!(envelope_len(16, 3).unwrap(), 32);
        assert_eq!(envelope_len(17, 3).unwrap(), 40);
        assert_eq!(envelope_len(u32::MAX as usize, 31).unwrap(), 3 << 31);
    }

    #[test]
    fn margins() {
        let m = counter_margin(0);
        assert_eq!(m.len(), 24);
        assert_eq!(m[3], 0xc3);
        assert_eq!(counter_margin_value(&m).unwrap(), 0);
        let s = standalone_margin(7).unwrap();
        assert_eq!(&s[..9], &[b'e', b'n', b'V', 0xc3, 1, 0, 0, 0, 7]);
        assert_eq!(standalone_margin_value(&s).unwrap(), 7);
        assert!(standalone_margin(0).is_err());
        assert!(standalone_margin(8).is_err());

        let mut f = FeedBuilder::new();
        f.push_flexbuffers(b"hello").unwrap();
        let mut feed = f.finish_with_margin();
        assert_eq!(margin_free_len(&feed).unwrap(), 24);
        assert_eq!(bump_counter_margin(&mut feed).unwrap(), 1);
        assert_eq!(bump_counter_margin(&mut feed).unwrap(), 2);
        assert_eq!(messages(&feed).unwrap(), vec![(5, &b"hello"[..])]);
        let n = feed.len();
        feed[n - 24..].copy_from_slice(&counter_margin(u64::MAX));
        assert_eq!(bump_counter_margin(&mut feed), Err(Error::Overflow));
    }

    #[test]
    fn nested() {
        let mut inner = FeedBuilder::new();
        inner.push_flexbuffers(b"cmd").unwrap();
        inner.push_counter_margin(3);
        inner.push_flexbuffers(b"manifest").unwrap();
        let inner = inner.into_bytes();
        let outer = encode(format::NESTED, 3, &inner).unwrap();
        assert_eq!(outer[3], 0x83);
        let env = decode_one(&outer).unwrap();
        assert_eq!(env.message(&outer), &inner[..]);
        // corrupt inner framing
        let mut bad_inner = inner.clone();
        bad_inner[0] = b'x';
        assert!(encode(format::NESTED, 3, &bad_inner).is_err());
        let mut bad_outer = outer.clone();
        bad_outer[8] = b'x';
        assert!(decode_one(&bad_outer).is_err());
        // nesting limit
        let mut deep = FeedBuilder::new().into_bytes();
        for _ in 0..MAX_NESTING {
            deep = encode(format::NESTED, 3, &deep).unwrap();
        }
        assert!(validate_feed(&deep).is_ok());
        let mut too_deep = deep.clone();
        too_deep = { let mut v = vec![0u8; envelope_len(too_deep.len(), 3).unwrap()]; encode_into(format::NESTED, 3, &too_deep, &mut v).unwrap(); v };
        assert_eq!(validate_feed(&too_deep), Err(Error::TooDeep));
        // a nested feed followed by more envelopes at the outer level
        let mut f = FeedBuilder::new();
        f.push_nested(&inner).unwrap();
        f.push_raw(b"after").unwrap();
        let mut f2 = FeedBuilder::new();
        f2.push_nested(f.as_bytes()).unwrap();
        assert_eq!(validate_feed(f2.as_bytes()).unwrap(), 1);
        assert_eq!(validate_feed(f.as_bytes()).unwrap(), 2);
        // empty nested feed is a valid (empty) feed
        assert!(decode_one(&encode(format::NESTED, 3, b"").unwrap()).is_ok());
    }

    #[test]
    fn rejections() {
        let good = encode(format::RAW, 3, b"abc").unwrap();
        assert!(decode_one(&good).is_ok());
        let mut bad = good.clone();
        bad[12] = 0; // padding
        assert_eq!(decode_one(&bad), Err(Error::BadPadding));
        let mut bad = good.clone();
        bad[20] = 0x04; // footer descriptor
        assert_eq!(decode_one(&bad), Err(Error::FramingMismatch));
        let mut bad = good.clone();
        bad[16] = 4; // footer length
        assert_eq!(decode_one(&bad), Err(Error::FramingMismatch));
        let mut bad = good.clone();
        bad[23] = b'e';
        assert_eq!(decode_one(&bad), Err(Error::BadPrefix));
        let mut bad = good.clone();
        bad[3] = 0x23;
        bad[20] = 0x23; // format 001
        assert_eq!(decode_one(&bad), Err(Error::ReservedFormat));
        let mut longer = good.clone();
        longer.push(0);
        assert_eq!(decode_one(&longer), Err(Error::LengthMismatch));
        assert_eq!(decode_one(&good[..23]), Err(Error::Truncated));
        assert!(encode(7, 3, b"").is_err());
        assert!(encode(1, 3, b"").is_err());
        assert!(encode(0, 32, b"").is_err());
    }

    #[test]
    fn traversal() {
        let mut f = FeedBuilder::new();
        f.push_raw(b"a").unwrap();
        f.push(format::FLEXBUFFERS, 4, b"0123456789abcdef0").unwrap();
        f.push_counter_margin(9);
        let feed = f.into_bytes();
        let fwd: Vec<_> = envelopes(&feed).map(|e| e.unwrap()).collect();
        let mut rev: Vec<_> = envelopes_rev(&feed).map(|e| e.unwrap()).collect();
        rev.reverse();
        assert_eq!(fwd, rev);
        assert_eq!(fwd.len(), 3);
        assert_eq!(validate_feed(&feed).unwrap(), 3);
    }

    proptest! {
        #[test]
        fn roundtrip(fmt in prop::sample::select(vec![0u8, 4, 5, 6]), power in 0u8..8, msg in prop::collection::vec(any::<u8>(), 0..100)) {
            let msg = if fmt == format::NESTED { Vec::new() } else { msg };
            let e = encode(fmt, power, &msg).unwrap();
            prop_assert_eq!(e.len() % (1usize << power), 0);
            let env = decode_one(&e).unwrap();
            prop_assert_eq!(env.format, fmt);
            prop_assert_eq!(env.alignment_power, power);
            prop_assert_eq!(env.message(&e), &msg[..]);
            prop_assert_eq!(parse_ending_at(&e, e.len()).unwrap(), env);
        }

        #[test]
        fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..64)) {
            let _ = decode_one(&bytes);
            let _ = validate_feed(&bytes);
            let _ = margin_free_len(&bytes);
            let _ = envelopes_rev(&bytes).count();
        }
    }
}
