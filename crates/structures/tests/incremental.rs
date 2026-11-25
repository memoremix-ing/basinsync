use anyhow::Result;
use basinsync_structures::{
    Value,
    basin::{Basin, MemoryStorage},
    trie::{self, Consumer, Count},
};
use std::collections::BTreeMap;
struct Budget(usize);
impl Consumer for Budget {
    fn trie_inline_limit(&self) -> usize {
        self.0
    }
    fn empty(&self) -> Value {
        Count(0).empty()
    }
    fn entry(&self, k: &[u8], v: &Value) -> Result<Value> {
        Count(0).entry(k, v)
    }
    fn combine(&self, v: &[Value]) -> Result<Value> {
        Count(0).combine(v)
    }
}
#[test]
fn canonical_path_copying_matches_independent_full_rebuilds() -> Result<()> {
    for budget in [1, 4, 16, 1280] {
        let c = Budget(budget);
        let mut b = Basin::new(MemoryStorage::default(), vec![19; 32])?;
        let mut model = BTreeMap::new();
        let mut root = trie::build(&mut b, vec![], &c)?;
        let mut random = 0x13579bdfu32;
        for step in 0..120 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            let key = if step % 3 == 0 {
                vec![(random % 32) as u8]
            } else {
                format!("page/{:x}", random % 60).into_bytes()
            };
            let value = if step % 5 == 0 {
                None
            } else {
                Some(Value::Blob(vec![(random >> 24) as u8; 13]))
            };
            if let Some(v) = &value {
                model.insert(key.clone(), v.clone());
            } else {
                model.remove(&key);
            }
            let updated = trie::update_node(&mut b, root.clone(), vec![(key, value)], &c)?;
            let expected = trie::build_node(&mut b, model.clone().into_iter().collect(), &c)?;
            assert_eq!(updated.node, expected.node, "budget={budget},step={step}");
            root = b.seal(updated.node, &updated.edges)?;
        }
        let removals = model.keys().cloned().map(|k| (k, None)).collect();
        let updated = trie::update_node(&mut b, root, removals, &c)?;
        assert_eq!(updated.node, trie::build_node(&mut b, vec![], &c)?.node);
    }
    Ok(())
}

#[test]
fn ordinary_packing_and_long_prefix_changes_match_full_rebuilds() -> Result<()> {
    let mut b = Basin::new(MemoryStorage::default(), vec![39; 32])?;
    let c = Budget(1280);
    let mut rows = (0..1400u32)
        .map(|i| {
            (
                vec![(i % 16) as u8, (i / 16) as u8, 7],
                Value::Big(i.into()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut root = trie::build(&mut b, rows.clone().into_iter().collect(), &c)?;
    for (key, value) in [
        (vec![0], Some(Value::Null)),
        (vec![15, 40, 7], None),
        (vec![], Some(Value::Big(3.into()))),
        (vec![255, 1, 2, 3], Some(Value::Big(9.into()))),
    ] {
        if let Some(v) = &value {
            rows.insert(key.clone(), v.clone());
        } else {
            rows.remove(&key);
        }
        let next = trie::update_node(&mut b, root, vec![(key, value)], &c)?;
        let full = trie::build_node(&mut b, rows.clone().into_iter().collect(), &c)?;
        assert_eq!(next.node, full.node);
        root = b.seal(next.node, &next.edges)?;
    }
    Ok(())
}

#[test]
fn long_compressed_prefixes_do_not_consume_nesting_budget() -> Result<()> {
    let mut b = Basin::new(MemoryStorage::default(), vec![5; 32])?;
    let c = Budget(1);
    let mut a = vec![9; 8000];
    a.push(1);
    let mut z = vec![9; 8000];
    z.push(2);
    let root = trie::build(&mut b, vec![(a.clone(), Value::Int(1))], &c)?;
    let next = trie::update_node(&mut b, root, vec![(z.clone(), Some(Value::Int(2)))], &c)?;
    let full = trie::build_node(&mut b, vec![(a, Value::Int(1)), (z, Value::Int(2))], &c)?;
    assert_eq!(next.node, full.node);
    Ok(())
}

#[test]
fn published_body_cache_preserves_descriptor_validation() -> Result<()> {
    let mut b = Basin::new(MemoryStorage::default(), vec![31; 32])?;
    let root = trie::build(&mut b, vec![(vec![1], Value::Int(7))], &Count(0))?;
    assert!(b.load(&root).is_ok());
    let mut bad = root.clone();
    if let Value::Array(fields) = &mut bad {
        fields[6].set("length", Value::Int(1))?;
    }
    assert!(b.load(&bad).is_err());
    Ok(())
}

#[test]
fn crc64nvme_summaries_compose_and_incremental_pages_match_full_rebuilds() -> Result<()> {
    use basinsync_structures::volume::{self, Algorithm};
    assert_eq!(crc_fast::crc64_nvme(b"123456789"), 0xae8b14860a799888);
    for split in 0..=9 {
        assert_eq!(
            crc_fast::checksum_combine(
                crc_fast::CrcAlgorithm::Crc64Nvme,
                crc_fast::crc64_nvme(&b"123456789"[..split]),
                crc_fast::crc64_nvme(&b"123456789"[split..]),
                (9 - split) as u64
            ),
            0xae8b14860a799888
        );
    }
    for algorithm in [Algorithm::Sl2, Algorithm::Crc64Nvme] {
        for budget in [1, 4, 16] {
            let mut b = Basin::new(MemoryStorage::default(), vec![23; 32])?;
            let mut model = (0..270u32)
                .map(|n| (n, vec![(n & 255) as u8; 17]))
                .collect::<BTreeMap<_, _>>();
            let mut old = volume::build_block_with_algorithm(
                &mut b,
                model
                    .iter()
                    .map(|(p, v)| ((*p).into(), v.clone()))
                    .collect(),
                budget,
                algorithm,
            )?;
            for round in 0..6 {
                let page = if round % 2 == 0 {
                    (round + 270) as u32
                } else {
                    (round * 13) as u32
                };
                let value = vec![round as u8; 19];
                model.insert(page, value.clone());
                let changed = volume::update_block(
                    &mut b,
                    &old,
                    vec![(page.into(), Some(value))],
                    budget,
                    algorithm,
                )?;
                let full = volume::build_block_with_algorithm(
                    &mut b,
                    model
                        .iter()
                        .map(|(p, v)| ((*p).into(), v.clone()))
                        .collect(),
                    budget,
                    algorithm,
                )?;
                assert_eq!(
                    changed.edge, full.edge,
                    "{algorithm:?},budget={budget},round={round}"
                );
                assert_eq!(
                    changed.digest,
                    algorithm.hash(&model.values().flatten().copied().collect::<Vec<_>>())
                );
                old = changed;
            }
            let changed = volume::update_block_truncated(
                &mut b,
                &old,
                vec![],
                Some(4.into()),
                budget,
                algorithm,
            )?;
            model.retain(|p, _| *p < 4);
            let full = volume::build_block_with_algorithm(
                &mut b,
                model.into_iter().map(|(p, v)| (p.into(), v)).collect(),
                budget,
                algorithm,
            )?;
            assert_eq!(changed.edge, full.edge);
        }
    }
    Ok(())
}
