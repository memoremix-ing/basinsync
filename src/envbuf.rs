//! Bidirectionally traversable EnvBuf frames, with an eight-byte alignment default.
use anyhow::{Context, Result, ensure};

pub const FLEXBUFFERS: u8 = 5;
pub const NESTED: u8 = 4;
pub const MARGIN: u8 = 6;
pub const PLATFORM_EXTENSION: u8 = 7;
const ALIGNMENT_POWER: u8 = 3;
const FRAME: usize = 8;

fn alignment(descriptor: u8) -> Result<usize> {
    ensure!(
        matches!(descriptor >> 5, 0 | 4 | 5 | MARGIN),
        "unsupported EnvBuf descriptor"
    );
    Ok(1usize << (descriptor & 31))
}

fn frame_length(length: usize, alignment: usize) -> Result<usize> {
    Ok(length
        .checked_add(FRAME * 2)
        .context("EnvBuf length overflow")?
        .checked_add(alignment - 1)
        .context("EnvBuf length overflow")?
        / alignment
        * alignment)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope<'a> {
    pub start: usize,
    pub content_start: usize,
    pub end: usize,
    pub format: u8,
    pub content: &'a [u8],
}

pub fn append(output: &mut Vec<u8>, content: &[u8], format: u8) -> Result<usize> {
    append_with_alignment(output, content, format, ALIGNMENT_POWER)
}

pub fn append_with_alignment(
    output: &mut Vec<u8>,
    content: &[u8],
    format: u8,
    alignment_power: u8,
) -> Result<usize> {
    ensure!(
        alignment_power <= 31,
        "EnvBuf alignment power exceeds five bits"
    );
    ensure!(
        matches!(format, 0 | 4 | 5 | MARGIN),
        "reserved EnvBuf format"
    );
    let descriptor = (format << 5) | alignment_power;
    let alignment = alignment(descriptor)?;
    ensure!(
        output.len().is_multiple_of(alignment),
        "unaligned EnvBuf header"
    );
    let length = u32::try_from(content.len()).context("EnvBuf exceeds u32 content length")?;
    let end = output
        .len()
        .checked_add(frame_length(content.len(), alignment)?)
        .context("EnvBuf length overflow")?;
    output.extend_from_slice(b"enV");
    output.push(descriptor);
    output.extend_from_slice(&length.to_le_bytes());
    output.extend_from_slice(content);
    output.resize(end - FRAME, 0xee);
    output.extend_from_slice(&length.to_le_bytes());
    output.push(descriptor);
    output.extend_from_slice(b"vNE");
    Ok(output.len())
}

pub fn at(bytes: &[u8], start: usize) -> Result<Envelope<'_>> {
    let header = bytes
        .get(start..start.checked_add(FRAME).context("EnvBuf offset overflow")?)
        .context("truncated EnvBuf header")?;
    ensure!(&header[..3] == b"enV", "invalid EnvBuf magic");
    let format = header[3] >> 5;
    let alignment = alignment(header[3])?;
    ensure!(start.is_multiple_of(alignment), "unaligned EnvBuf header");
    let length = u32::from_le_bytes(header[4..8].try_into()?) as usize;
    let content_start = start + FRAME;
    let content_end = content_start
        .checked_add(length)
        .context("EnvBuf length overflow")?;
    let end = start
        .checked_add(frame_length(length, alignment)?)
        .context("EnvBuf length overflow")?;
    let footer_start = end - FRAME;
    let footer = bytes
        .get(footer_start..end)
        .context("truncated EnvBuf footer")?;
    ensure!(
        footer[..4] == header[4..8] && footer[4] == header[3] && &footer[5..] == b"vNE",
        "EnvBuf header/footer mismatch"
    );
    ensure!(
        bytes
            .get(content_end..footer_start)
            .context("truncated EnvBuf padding")?
            .iter()
            .all(|b| *b == 0xee),
        "invalid EnvBuf padding"
    );
    Ok(Envelope {
        start,
        content_start,
        end,
        format,
        content: &bytes[content_start..content_end],
    })
}

pub fn before(bytes: &[u8], end: usize) -> Result<Envelope<'_>> {
    let footer = bytes
        .get(end.checked_sub(FRAME).context("truncated EnvBuf footer")?..end)
        .context("truncated EnvBuf footer")?;
    let length = u32::from_le_bytes(footer[..4].try_into()?) as usize;
    let alignment = alignment(footer[4])?;
    ensure!(end.is_multiple_of(alignment), "unaligned EnvBuf footer");
    let start = end
        .checked_sub(frame_length(length, alignment)?)
        .context("EnvBuf footer length exceeds prefix")?;
    let envelope = at(bytes, start)?;
    ensure!(envelope.end == end, "EnvBuf reverse boundary mismatch");
    Ok(envelope)
}

pub fn all(bytes: &[u8]) -> Result<Vec<Envelope<'_>>> {
    let mut result = Vec::new();
    let mut start = 0;
    while start < bytes.len() {
        let envelope = at(bytes, start)?;
        start = envelope.end;
        result.push(envelope);
    }
    Ok(result)
}

/// Validate every envelope, omitting margins from the readable contents.
pub fn readable(bytes: &[u8]) -> Result<Vec<Envelope<'_>>> {
    Ok(all(bytes)?
        .into_iter()
        .filter(|envelope| envelope.format != MARGIN)
        .collect())
}

pub fn append_counter_margin(bytes: &mut Vec<u8>, counter: u64) -> Result<usize> {
    append(bytes, &counter.to_le_bytes(), MARGIN)
}

/// Finalize a nested feed constructed after an eight-byte header reservation.
pub fn finish_nested(mut bytes: Vec<u8>) -> Result<Vec<u8>> {
    ensure!(
        bytes.get(..FRAME) == Some(&[0; FRAME]),
        "missing nested header reservation"
    );
    let length = bytes.len() - FRAME;
    let word = u32::try_from(length)
        .context("nested EnvBuf exceeds u32 message length")?
        .to_le_bytes();
    let descriptor = (NESTED << 5) | ALIGNMENT_POWER;
    let end = frame_length(length, 1 << ALIGNMENT_POWER)?;
    bytes[..3].copy_from_slice(b"enV");
    bytes[3] = descriptor;
    bytes[4..8].copy_from_slice(&word);
    bytes.resize(end - FRAME, 0xee);
    bytes.extend_from_slice(&word);
    bytes.push(descriptor);
    bytes.extend_from_slice(b"vNE");
    Ok(bytes)
}

/// Borrow one complete nested message, with no concatenated siblings or suffix.
pub fn nested_message(bytes: &[u8]) -> Result<&[u8]> {
    let envelope = at(bytes, 0)?;
    ensure!(
        envelope.format == NESTED && envelope.end == bytes.len(),
        "expected one nested EnvBuf"
    );
    Ok(envelope.content)
}

pub fn wrap(message: &[u8]) -> Result<Vec<u8>> {
    let mut bytes = vec![];
    append(&mut bytes, message, 0)?;
    append_counter_margin(&mut bytes, 0)?;
    Ok(bytes)
}

pub fn message(bytes: &[u8]) -> Result<&[u8]> {
    let frames = readable(bytes)?;
    ensure!(
        frames.len() == 1 && frames[0].format == 0 && frames[0].start == 0,
        "expected one raw EnvBuf message"
    );
    Ok(frames[0].content)
}

pub fn encoded_length(message_length: u64) -> Result<u64> {
    let length = usize::try_from(message_length)?;
    u32::try_from(length).context("EnvBuf message exceeds u32 length")?;
    Ok(frame_length(length, 1 << ALIGNMENT_POWER)? as u64)
}

/// Wrap an exported image on disk, retaining bounded memory and one PUT.
pub fn wrap_file(path: &std::path::Path) -> Result<tempfile::NamedTempFile> {
    use std::io::{Read, Write};
    let mut source = std::fs::File::open(path)?;
    let length = source.metadata()?.len();
    let end = encoded_length(length)?;
    let word = u32::try_from(length)?.to_le_bytes();
    let mut output = tempfile::NamedTempFile::new()?;
    let mut write = |bytes: &[u8]| -> Result<()> {
        output.write_all(bytes)?;
        Ok(())
    };
    write(b"enV")?;
    write(&[ALIGNMENT_POWER])?;
    write(&word)?;
    let mut buffer = [0u8; 64 * 1024];
    let mut copied = 0;
    loop {
        let n = source.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        write(&buffer[..n])?;
        copied += n as u64;
    }
    ensure!(copied == length, "snapshot image changed while enveloping");
    write(&vec![0xee; (end - length - 16) as usize])?;
    write(&word)?;
    write(&[ALIGNMENT_POWER])?;
    write(b"vNE")?;
    let mut margin = vec![];
    append_counter_margin(&mut margin, 0)?;
    write(&margin)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    #[test]
    fn empty_sentinel_and_wrapped_messages_are_distinct() -> Result<()> {
        use std::io::Write;
        let mut empty_feed = vec![];
        append(&mut empty_feed, &[], MARGIN)?;
        for length in [0, 1, 7, 8, 15, 16, 17, 65536] {
            let original = vec![42; length];
            let bytes = wrap(&original)?;
            assert_eq!(message(&bytes)?, original);
            assert_eq!(bytes.len() as u64, encoded_length(length as u64)? + 24);
            let mut raw = tempfile::NamedTempFile::new()?;
            raw.write_all(&original)?;
            let file = wrap_file(raw.path())?;
            assert_eq!(std::fs::read(file.path())?, bytes);
        }
        let prefixed = [empty_feed.clone(), wrap(b"data")?].concat();
        assert!(
            message(&prefixed).is_err(),
            "marker message must begin at byte eight"
        );
        assert!(message(&empty_feed).is_err());
        assert!(encoded_length(u32::MAX as u64 + 1).is_err());
        Ok(())
    }
    #[test]
    fn margin_is_skipped_but_raw_content_is_readable() -> Result<()> {
        let mut bytes = vec![];
        append(&mut bytes, b"ignored enV vNE", MARGIN)?;
        let raw_start = bytes.len();
        append(&mut bytes, b"read me", 0)?;
        append(&mut bytes, &[], MARGIN)?;
        let frames = all(&bytes)?;
        assert_eq!(
            frames.iter().map(|e| e.format).collect::<Vec<_>>(),
            [6, 0, 6]
        );
        assert_eq!(before(&bytes, bytes.len())?.format, MARGIN);
        assert_eq!(readable(&bytes)?, [at(&bytes, raw_start)?]);
        assert_eq!(readable(&bytes)?[0].content, b"read me");
        let mut bad = bytes.clone();
        bad[frames[0].end - 1] ^= 1;
        assert!(readable(&bad).is_err());
        Ok(())
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Frame {
        format: u8,
        alignment_power: u8,
        content: Vec<u8>,
        wire: Vec<u8>,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        frames: Vec<Frame>,
        reserved_formats: Vec<u8>,
    }

    /// Wire vectors shared with the TypeScript client.
    #[test]
    fn shared_vectors_concatenate_and_walk_both_ways() -> Result<()> {
        let vectors: Vectors = serde_json::from_str(include_str!("../tests/vectors/envbuf.json"))?;
        let mut bytes = vec![];
        let mut boundaries = vec![0];
        for frame in &vectors.frames {
            let mut wire = vec![];
            append_with_alignment(
                &mut wire,
                &frame.content,
                frame.format,
                frame.alignment_power,
            )?;
            assert_eq!(wire, frame.wire);
            let decoded = at(&frame.wire, 0)?;
            assert_eq!(
                (decoded.format, decoded.content),
                (frame.format, frame.content.as_slice())
            );
            bytes.extend_from_slice(&frame.wire);
            boundaries.push(bytes.len());
        }
        for format in &vectors.reserved_formats {
            assert!(append(&mut vec![], &[], *format).is_err(), "{format}");
        }
        for (pair, frame) in boundaries.windows(2).zip(&vectors.frames) {
            assert_eq!(at(&bytes, pair[0])?, before(&bytes, pair[1])?);
            assert_eq!(before(&bytes, pair[1])?.content, frame.content);
        }
        // Frames concatenate only at their own alignment, so the 32-byte frame leads.
        // Corrupt the framing (not content) of the canonical one-byte frame.
        let canonical = boundaries[vectors
            .frames
            .iter()
            .position(|f| f.content == [1])
            .unwrap()];
        for offset in [0, 3, 4, 9, 16, 20, 23] {
            let mut bad = bytes.clone();
            bad[canonical + offset] ^= 1;
            assert!(all(&bad).is_err(), "offset {offset}");
        }
        for length in 1..bytes.len() {
            if !boundaries.contains(&length) {
                assert!(all(&bytes[..length]).is_err());
            }
        }
        Ok(())
    }
    #[test]
    fn total_frame_size_is_a_multiple_of_eight() -> Result<()> {
        let mut bytes = vec![];
        for length in 0..=1024 {
            let start = bytes.len();
            let content = vec![0x42; length];
            let end = append(&mut bytes, &content, [0, 4, 5, MARGIN][length % 4])?;
            assert_eq!(end - start, 16 + length.next_multiple_of(8));
            assert_eq!(start % 8, 0);
            assert_eq!(end % 8, 0);
            let frame = at(&bytes, start)?;
            assert_eq!(frame, before(&bytes, end)?);
            assert_eq!(frame.content, content);
        }
        assert!(append(&mut vec![0; 4], &[], FLEXBUFFERS).is_err());
        Ok(())
    }
    #[test]
    fn full_frame_rounds_up_to_its_declared_alignment() -> Result<()> {
        for power in 0..=10 {
            let alignment = 1usize << power;
            let mut bytes = vec![];
            for length in 0..=128 {
                let start = bytes.len();
                let content = vec![0x42; length];
                let end = append_with_alignment(&mut bytes, &content, FLEXBUFFERS, power)?;
                assert_eq!(end - start, (length + 16).next_multiple_of(alignment));
                assert_eq!((end - start) % alignment, 0);
                assert_eq!(bytes[start + 3] & 31, power);
                let frame = at(&bytes, start)?;
                assert_eq!(frame.content, content);
                assert_eq!(frame, before(&bytes, end)?);
            }
            assert_eq!(all(&bytes)?.len(), 129);
        }
        assert_eq!(frame_length(0, 1usize << 31)?, 1usize << 31);
        assert!(append_with_alignment(&mut vec![], &[], FLEXBUFFERS, 32).is_err());
        // With 32-byte alignment, the framing itself fills half the first block.
        let mut bytes = vec![];
        assert_eq!(
            append_with_alignment(&mut bytes, &[1; 16], FLEXBUFFERS, 5)?,
            32
        );
        Ok(())
    }
    proptest! {
        #[test]
        fn roundtrip_chunks(chunks in prop::collection::vec(prop::collection::vec(any::<u8>(),0..2048),0..30)) {
            let mut bytes=vec![];
            for chunk in &chunks { append(&mut bytes,chunk,FLEXBUFFERS).unwrap(); prop_assert_eq!(bytes.len()%8,0); }
            let frames=all(&bytes).unwrap();
            prop_assert_eq!(frames.iter().map(|e|e.content.to_vec()).collect::<Vec<_>>(),chunks.clone());
            let mut end=bytes.len();
            for chunk in chunks.iter().rev() {let e=before(&bytes,end).unwrap();prop_assert_eq!(e.content,chunk.as_slice());end=e.start;}
            prop_assert_eq!(end,0);
        }
        #[test]
        fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(),0..4096), boundary in any::<usize>()) {
            let _=all(&bytes);let _=at(&bytes,boundary);let _=before(&bytes,boundary);
        }
    }
}
