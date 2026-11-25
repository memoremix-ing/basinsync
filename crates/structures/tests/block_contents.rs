use anyhow::Result;
use basinsync_structures::{
    basin::{Basin, MemoryStorage},
    volume,
};
fn bytes(n: usize) -> Vec<u8> {
    let mut x = 0x13579bdfu32;
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x >> 24) as u8
        })
        .collect()
}
#[test]
fn mixed_ranges_crc_and_page_updates_preserve_the_prefix() -> Result<()> {
    let mut b = Basin::new(MemoryStorage::default(), vec![42; 32])?;
    let prefix = bytes(200003);
    let suffix = vec![77; 9000];
    let rows = |data: &[u8]| {
        data.chunks(4096)
            .enumerate()
            .map(|(i, p)| (i.into(), p.to_vec()))
            .collect()
    };
    let block = volume::build_mixed_block(
        &mut b,
        &prefix,
        rows(&suffix),
        volume::ChunkPolicy::default(),
    )?;
    let root = volume::from_blocks(&mut b, vec![("/file".into(), block.clone())], vec![])?;
    let expected = [prefix.clone(), suffix.clone()].concat();
    assert_eq!(volume::read(&mut b, &root, "/file", false)?, expected);
    for at in [0, prefix.len() - 11, prefix.len(), expected.len() + 1] {
        b.clear_cache();
        assert_eq!(
            volume::read_range(&mut b, &root, "/file", at as u64, 33, true)?,
            expected[at.min(expected.len())..(at + 33).min(expected.len())]
        );
    }
    assert!(volume::PageReader::open(&mut b, &root, "/file").is_err());
    let changed = volume::update_block(
        &mut b,
        &block,
        vec![(0.into(), Some(vec![88; 4096]))],
        1280,
        volume::Algorithm::Crc64Nvme,
    )?;
    let next = volume::replace_blocks(&mut b, &root, vec![("/file".into(), changed)])?;
    let mut expected = expected;
    expected[prefix.len()..prefix.len() + 4096].fill(88);
    assert_eq!(volume::read(&mut b, &next, "/file", false)?, expected);
    assert_eq!(
        volume::read(&mut b, &root, "/file", false)?,
        [prefix, suffix].concat()
    );
    Ok(())
}
#[test]
fn shared_chunk_boundaries() -> Result<()> {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/vectors/chunking.json"))?;
    for v in vectors.as_array().unwrap() {
        let n = v["length"].as_u64().unwrap() as usize;
        let data = match v["pattern"].as_str().unwrap() {
            "random" => bytes(n),
            "runs" => (0..n).map(|i| (1 + i / 16384) as u8).collect(),
            _ => vec![0; n],
        };
        let lengths = volume::chunks(&data, volume::ChunkPolicy::default())?
            .iter()
            .map(Vec::len)
            .collect::<Vec<_>>();
        let expected = v["lengths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as usize)
            .collect::<Vec<_>>();
        assert_eq!(lengths, expected);
    }
    Ok(())
}
