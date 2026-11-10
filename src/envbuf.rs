//! Eight-byte aligned, bidirectionally traversable EnvBuf frames.
use anyhow::{Context, Result, ensure};

pub const FLEXBUFFERS: u8 = 5;
const ALIGNMENT_POWER: u8 = 3;
const FRAME: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Envelope<'a> {
    pub start: usize,
    pub content_start: usize,
    pub end: usize,
    pub format: u8,
    pub content: &'a [u8],
}

pub fn append(output: &mut Vec<u8>, content: &[u8], format: u8) -> Result<usize> {
    ensure!(
        output.len().is_multiple_of(FRAME),
        "unaligned EnvBuf header"
    );
    ensure!(matches!(format, 0 | 4 | 5), "reserved EnvBuf format");
    let length = u32::try_from(content.len()).context("EnvBuf exceeds u32 content length")?;
    let descriptor = (format << 5) | ALIGNMENT_POWER;
    output.extend_from_slice(b"enV");
    output.push(descriptor);
    output.extend_from_slice(&length.to_le_bytes());
    output.extend_from_slice(content);
    output.resize(output.len().next_multiple_of(FRAME), 0xee);
    output.extend_from_slice(&length.to_le_bytes());
    output.push(descriptor);
    output.extend_from_slice(b"vNE");
    Ok(output.len())
}

pub fn at(bytes: &[u8], start: usize) -> Result<Envelope<'_>> {
    ensure!(start.is_multiple_of(FRAME), "unaligned EnvBuf header");
    let header = bytes
        .get(start..start.checked_add(FRAME).context("EnvBuf offset overflow")?)
        .context("truncated EnvBuf header")?;
    ensure!(&header[..3] == b"enV", "invalid EnvBuf magic");
    let format = header[3] >> 5;
    ensure!(
        header[3] & 31 == ALIGNMENT_POWER && matches!(format, 0 | 4 | 5),
        "unsupported EnvBuf descriptor"
    );
    let length = u32::from_le_bytes(header[4..8].try_into()?) as usize;
    let content_start = start + FRAME;
    let content_end = content_start
        .checked_add(length)
        .context("EnvBuf length overflow")?;
    let footer_start = content_end
        .checked_add(FRAME - 1)
        .context("EnvBuf length overflow")?
        / FRAME
        * FRAME;
    let end = footer_start
        .checked_add(FRAME)
        .context("EnvBuf length overflow")?;
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
    ensure!(end.is_multiple_of(FRAME), "unaligned EnvBuf footer");
    let footer = bytes
        .get(end.checked_sub(FRAME).context("truncated EnvBuf footer")?..end)
        .context("truncated EnvBuf footer")?;
    let length = u32::from_le_bytes(footer[..4].try_into()?) as usize;
    let padded = length
        .checked_add(FRAME - 1)
        .context("EnvBuf length overflow")?
        / FRAME
        * FRAME;
    let start = end
        .checked_sub(
            padded
                .checked_add(FRAME * 2)
                .context("EnvBuf length overflow")?,
        )
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

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    #[test]
    fn known_frame_and_bidirectional_concatenation() -> Result<()> {
        let mut bytes = vec![];
        append(&mut bytes, &[1], FLEXBUFFERS)?;
        assert_eq!(
            bytes,
            [
                b"enV".as_slice(),
                &[0xa3, 1, 0, 0, 0, 1],
                &[0xee; 7],
                &[1, 0, 0, 0, 0xa3],
                b"vNE"
            ]
            .concat()
        );
        let boundary = bytes.len();
        append(&mut bytes, b"second command", FLEXBUFFERS)?;
        assert_eq!(at(&bytes, boundary)?, before(&bytes, bytes.len())?);
        assert_eq!(before(&bytes, boundary)?.content, [1]);
        for offset in [0, 3, 4, 9, 16, 20, 23] {
            let mut bad = bytes.clone();
            bad[offset] ^= 1;
            assert!(all(&bad).is_err(), "offset {offset}");
        }
        for length in 1..bytes.len() {
            if length != boundary {
                assert!(all(&bytes[..length]).is_err());
            }
        }
        Ok(())
    }
    proptest! {
        #[test]
        fn roundtrip_chunks(chunks in prop::collection::vec(prop::collection::vec(any::<u8>(),0..2048),0..30)) {
            let mut bytes=vec![];
            for chunk in &chunks { append(&mut bytes,chunk,FLEXBUFFERS).unwrap(); }
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
