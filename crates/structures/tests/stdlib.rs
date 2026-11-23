use Value::*;
use anyhow::Result;
use basinsync_structures::{
    Value,
    basin::{self, Basin, MemoryStorage},
    btree,
    trie::Count,
    vector,
};
use num_bigint::BigInt;
fn basin() -> Basin<MemoryStorage> {
    Basin::new(MemoryStorage::default(), vec![42; 32]).unwrap()
}
fn rows(n: usize) -> Vec<(Vec<u8>, Value)> {
    (0..n)
        .map(|i| {
            (
                (i as u32).to_be_bytes().to_vec(),
                if i % 7 == 0 { Null } else { Big(i.into()) },
            )
        })
        .collect()
}
fn check_btree(b: &mut Basin<MemoryStorage>, node: Value, root: bool) -> Result<usize> {
    let h = node.index(5)?;
    let depth = h.field("depth")?.number()?;
    let f = node.index(6)?;
    let keys = f.at(2)?.array()?;
    assert!(keys.len() <= 31 && (root || keys.len() >= 15));
    assert!(
        keys.windows(2)
            .all(|k| k[0].blob().unwrap() < k[1].blob().unwrap())
    );
    let mut count = keys.len();
    let mut inline = keys.len();
    if depth > 0 {
        let children = f.at(4)?.array()?;
        assert_eq!(children.len(), keys.len() + 1);
        for child in children {
            let (edge, n) = if matches!(child, Array(_)) {
                (
                    true,
                    basin::node_reader(&b.load(child)?)
                        .and_then(basinsync_structures::value::read)?,
                )
            } else {
                (false, child.clone())
            };
            assert_eq!(n.index(5)?.field("depth")?.number()?, depth - 1);
            if !edge {
                inline += n.index(5)?.field("inlined")?.number()? as usize;
            }
            count += check_btree(b, n, false)?;
        }
    } else {
        assert!(f.at(4)?.is_null());
    }
    assert_eq!(h.field("count")?.big()?, BigInt::from(count));
    assert_eq!(h.field("inlined")?.number()? as usize, inline);
    Ok(count)
}
#[test]
fn packed_btree_balances_and_retains_separator_values() -> Result<()> {
    for n in [0, 1, 31, 32, 33, 1023, 1024, 1280, 1281, 32768] {
        let mut b = basin();
        let input = rows(n);
        let root = btree::build(&mut b, input.clone(), &Count(7))?;
        let decoded = basinsync_structures::value::read(basin::node_reader(&b.load(&root)?)?)?;
        assert_eq!(check_btree(&mut b, decoded.clone(), true)?, n);
        assert_eq!(btree::entries(&mut b, &root, 7)?, input);
        if n > 31 {
            let k = decoded.index(6)?.at(2)?.at(0)?.blob()?;
            let expected = decoded.index(6)?.at(3)?.at(0)?.clone();
            b.clear_cache();
            b.storage.reads = 0;
            assert_eq!(btree::get(&mut b, &root, k, 7)?, Some(expected));
            assert_eq!(b.storage.reads, 1);
        }
        if n > 0 {
            let next = btree::update(&mut b, &root, vec![(input[0].0.clone(), None)], &Count(7))?;
            let fresh = btree::build(&mut b, input[1..].to_vec(), &Count(7))?;
            assert_eq!(next, fresh);
            assert_eq!(
                btree::get(&mut b, &root, &input[0].0, 7)?,
                Some(input[0].1.clone())
            );
        }
        b.clear_cache();
        b.storage.reads = 0;
        btree::visit(
            &mut b,
            &root,
            (&[], None),
            7,
            &mut |_, _| false,
            &mut |_, _| panic!("pruned"),
        )?;
        assert_eq!(b.storage.reads, 0);
    }
    Ok(())
}
#[test]
fn packed_vector_bitmaps_sparse_indices_and_snapshot_updates() -> Result<()> {
    for n in [0, 1, 31, 32, 33, 1023, 1024, 1280, 1281, 32768] {
        let mut b = basin();
        let input = rows(n).into_iter().map(|(_, v)| v).collect::<Vec<_>>();
        let root = vector::build(&mut b, input.clone(), &Count(7))?;
        let entries = vector::entries(&mut b, &root, 7)?;
        assert_eq!(
            entries,
            input
                .iter()
                .enumerate()
                .map(|(i, v)| (i.into(), v.clone()))
                .collect::<Vec<_>>()
        );
        let mut reverse = entries.clone();
        reverse.reverse();
        assert_eq!(
            vector::build_entries(&mut b, n.into(), reverse, &Count(7))?,
            root
        );
        for i in [0, 31, 32, 1023].into_iter().filter(|i| *i < n) {
            assert_eq!(
                vector::get(&mut b, &root, &i.into(), 7)?,
                Some(input[i].clone())
            );
        }
        assert!(vector::get(&mut b, &root, &n.into(), 7)?.is_none());
        if n > 0 {
            let next = vector::update(
                &mut b,
                &root,
                vec![(0.into(), Some("changed".into()))],
                n.into(),
                &Count(7),
            )?;
            assert_eq!(
                vector::get(&mut b, &next, &0.into(), 7)?,
                Some("changed".into())
            );
            assert_eq!(
                vector::get(&mut b, &root, &0.into(), 7)?,
                Some(input[0].clone())
            );
        }
    }
    let mut b = basin();
    let far: BigInt = (BigInt::from(1) << 200usize) + 31;
    let length = &far + 1;
    let root = vector::build_entries(
        &mut b,
        length,
        vec![
            (0.into(), Null),
            (31.into(), "slot31".into()),
            (far.clone(), "far".into()),
        ],
        &Count(7),
    )?;
    assert_eq!(vector::get(&mut b, &root, &far, 7)?, Some("far".into()));
    assert!(vector::get(&mut b, &root, &1.into(), 7)?.is_none());
    let next = vector::update(&mut b, &root, vec![], 32.into(), &Count(7))?;
    assert_eq!(
        vector::get(&mut b, &next, &31.into(), 7)?,
        Some("slot31".into())
    );
    b.clear_cache();
    b.storage.reads = 0;
    vector::visit(
        &mut b,
        &root,
        (&0.into(), &(&far + 1)),
        7,
        &mut |_, _| false,
        &mut |_, _| panic!("pruned"),
    )?;
    assert_eq!(b.storage.reads, 0);
    Ok(())
}

#[test]
fn malformed_structural_maps_are_not_vectors() -> Result<()> {
    let mut b = basin();
    let root = vector::build(&mut b, vec![Blob(vec![1, 2, 3])], &Count(7))?;
    let view = vector::get_view(&mut b, &root, &0.into(), 7)?.unwrap();
    b.clear_cache();
    assert_eq!(view.owned()?, Blob(vec![1, 2, 3]));
    let mut n = basinsync_structures::value::read(basin::node_reader(&b.load(&root)?)?)?;
    let mut f = n.index(6)?.array()?.to_vec();
    f[3] = Value::map([("slot", Blob(vec![1, 2, 3]))]);
    n.set("6", Array(f))?;
    let bad = b.seal(n, &[])?;
    assert!(vector::get(&mut b, &bad, &0.into(), 7).is_err());
    let root = btree::build(&mut b, vec![(vec![0xaa], Null)], &Count(7))?;
    let mut n = basinsync_structures::value::read(basin::node_reader(&b.load(&root)?)?)?;
    let mut f = n.index(6)?.array()?.to_vec();
    f[2] = Value::map([("key", Blob(vec![0xaa]))]);
    n.set("6", Array(f))?;
    let bad = b.seal(n, &[])?;
    assert!(btree::get(&mut b, &bad, &[0xaa], 7).is_err());
    Ok(())
}
