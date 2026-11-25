use Value::*;
use anyhow::Result;
use basinsync_structures::{
    Value,
    basin::{self, Basin, MemoryStorage},
    trie::{self, Count, Plain},
    volume,
};
fn shared_vectors() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../tests/vectors/structures.json")).unwrap()
}
fn basin() -> Basin<MemoryStorage> {
    Basin::new(MemoryStorage::default(), vec![42; 32]).unwrap()
}
fn rows(n: usize) -> Vec<(Vec<u8>, Value)> {
    (0..n)
        .map(|i| {
            (
                vec![(i >> 8) as u8, i as u8],
                if i % 7 == 0 {
                    Null
                } else {
                    Value::map([("n", Big(i.into())), ("data", Blob(vec![i as u8]))])
                },
            )
        })
        .collect()
}
#[test]
fn published_crc64nvme_vectors_and_composition() -> Result<()> {
    use volume::Algorithm;
    for v in shared_vectors()["crc64nvme"].as_array().unwrap() {
        let bytes = v["message"].as_str().unwrap().as_bytes();
        assert_eq!(
            basin::hex(&Algorithm::Crc64Nvme.hash(bytes)),
            v["digest"].as_str().unwrap()
        );
    }
    Ok(())
}
#[test]
fn canonical_boundaries_and_lazy_reads() -> Result<()> {
    for count in shared_vectors()["trieCounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_u64().unwrap() as usize)
    {
        let mut b = basin();
        let data = rows(count);
        let a = trie::build(&mut b, data.clone(), &Count(7))?;
        let mut reversed = data.clone();
        reversed.reverse();
        let same = trie::build(&mut b, reversed, &Count(7))?;
        assert_eq!(a, same);
        for i in [0, 62, 63, 254, 255, 1279, count.saturating_sub(1)]
            .into_iter()
            .filter(|i| *i < count)
        {
            assert_eq!(
                trie::get(&mut b, &a, &data[i].0, 7)?,
                Some(data[i].1.clone())
            );
        }
        assert_eq!(trie::get(&mut b, &a, &[255; 3], 7)?, None);
        assert_eq!(trie::entries(&mut b, &a, &[], 7)?, data);
        b.clear_cache();
        b.storage.reads = 0;
        trie::visit(&mut b, &a, &[], 7, &mut |_, _| false, &mut |_, _| {
            panic!("pruned")
        })?;
        assert_eq!(b.storage.reads, 0);
    }
    Ok(())
}
#[test]
fn canonical_collapse_and_empty_null_key() -> Result<()> {
    let mut b = basin();
    let t = trie::build(
        &mut b,
        vec![
            (vec![], Null),
            (vec![0xab], Big(1.into())),
            (vec![0xab, 0xcd], Big(2.into())),
        ],
        &Count(7),
    )?;
    assert_eq!(trie::get(&mut b, &t, &[], 7)?, Some(Null));
    let empty = trie::update(
        &mut b,
        &t,
        vec![(vec![], None), (vec![0xab], None), (vec![0xab, 0xcd], None)],
        &Count(7),
    )?;
    assert_eq!(empty, trie::build(&mut b, vec![], &Count(7))?);
    let a = trie::build(&mut b, rows(2000), &Count(7))?;
    let removed = trie::update(&mut b, &a, vec![(vec![7, 207], None)], &Count(7))?;
    assert_eq!(removed, trie::build(&mut b, rows(1999), &Count(7))?);
    Ok(())
}
#[test]
fn approximate_breadth_and_validation() -> Result<()> {
    let mut b = basin();
    let leaf = trie::build(&mut b, rows(1), &Plain)?;
    assert_eq!(leaf.at(3)?.field("height")?.number()?, 1);
    assert!(basin::query(&[], 320, 0).is_err());
    assert!(basin::query(std::slice::from_ref(&leaf), 320, 1).is_err());
    let node = |path: &str| {
        Value::map([
            ("0", Symbol("species".into())),
            ("1", basin::DOMAIN.into()),
            ("2", path.into()),
            ("3", basin::empty_query()),
            ("4", 0u32.into()),
            ("5", Null),
            ("6", Array(vec![0u32.into(), Null])),
        ])
    };
    let l = b.seal(node("left"), std::slice::from_ref(&leaf))?;
    let r = b.seal(node("right"), std::slice::from_ref(&leaf))?;
    assert_eq!(
        basin::query(&[l, r], 320, 128)?.field("breadth")?,
        &Big(4.into())
    );
    let mut bad = leaf.clone();
    if let Array(a) = &mut bad {
        a[5].set("count", Big(999.into()))?;
    }
    assert!(b.load(&bad).is_err());
    assert!(trie::build(&mut b, vec![(vec![1], Null), (vec![1], Null)], &Plain).is_err());
    Ok(())
}
#[test]
fn filesystem_snapshots_unicode_shortcuts_and_names() -> Result<()> {
    let mut b = basin();
    let large = (0..8195).map(|i| i as u8).collect::<Vec<_>>();
    let files = vec![
        ("/a".into(), large.clone()),
        ("/dir/empty".into(), vec![]),
        ("/dir/__proto__".into(), b"safe".to_vec()),
        ("/\u{ffff}".into(), b"bmp".to_vec()),
        ("/\u{10000}".into(), b"astral".to_vec()),
    ];
    let v = volume::build(&mut b, files.clone())?;
    for (name, bytes) in files {
        assert_eq!(volume::read(&mut b, &v, &name, true)?, bytes);
        assert_eq!(volume::read(&mut b, &v, &name, false)?, bytes);
    }
    assert_eq!(volume::list(&mut b, &v, "/dir")?, ["__proto__", "empty"]);
    b.storage.capabilities.clear();
    assert_eq!(volume::read(&mut b, &v, "/a", true)?, large);
    let other = volume::update(
        &mut b,
        &v,
        vec![("/a".into(), None), ("/b".into(), Some(large.clone()))],
    )?;
    assert_ne!(v, other);
    assert_eq!(volume::read(&mut b, &v, "/a", true)?, large);
    assert_eq!(volume::read(&mut b, &other, "/b", true)?, large);
    Ok(())
}
#[test]
fn partial_reads_and_consumer_migrations() -> Result<()> {
    let mut b = basin();
    let data = (0..volume::PAGE_SIZE * 1281 + 13)
        .map(|i| i as u8)
        .collect::<Vec<_>>();
    let root = volume::build(&mut b, vec![("/large".into(), data.clone())])?;
    b.clear_cache();
    b.storage.reads = 0;
    assert_eq!(
        volume::read_range(&mut b, &root, "/large", 3, 17, true)?,
        data[3..20]
    );
    assert!(b.storage.reads <= 3);
    assert_eq!(
        volume::read_range(&mut b, &root, "/large", (data.len() - 5) as u64, 40, true)?,
        data[data.len() - 5..]
    );
    assert!(
        volume::read_range(&mut b, &root, "/large", (data.len() + 10) as u64, 4, true)?.is_empty()
    );
    b.storage.capabilities.clear();
    assert_eq!(
        volume::read_range(&mut b, &root, "/large", 3, 17, true)?,
        data[3..20]
    );
    let old = trie::build(&mut b, rows(1400), &Count(7))?;
    let entries = trie::entries(&mut b, &old, &[], 7)?
        .into_iter()
        .map(|(k, v)| (k, Value::map([("old", v)])))
        .collect();
    let new = trie::build(&mut b, entries, &Count(8))?;
    assert_eq!(new.at(4)?, &Int(0));
    assert_eq!(new.at(6)?.field("version")?, &Int(0));
    assert_eq!(new.at(6)?.field("0")?, &Int(8));
    assert!(trie::get(&mut b, &new, &[0, 1], 7).is_err());
    assert_eq!(
        trie::get(&mut b, &new, &[0, 1], 8)?,
        Some(Value::map([("old", rows(2)[1].1.clone())]))
    );
    assert_eq!(
        trie::get(&mut b, &old, &[0, 1], 7)?,
        Some(rows(2)[1].1.clone())
    );
    Ok(())
}
#[test]
fn empty_directories_survive_file_updates() -> Result<()> {
    let mut b = basin();
    let root = volume::build_with_directories(
        &mut b,
        vec![("/kept/file".into(), b"x".to_vec())],
        vec!["/empty".into(), "/deep/empty".into()],
    )?;
    assert!(volume::list(&mut b, &root, "/empty")?.is_empty());
    let next = volume::update(&mut b, &root, vec![("/kept/file".into(), None)])?;
    assert!(volume::list(&mut b, &next, "/kept")?.is_empty());
    Ok(())
}

#[test]
fn revisions_pin_allocations_and_shared_heap_addresses() -> Result<()> {
    let mut b = basin();
    let first = trie::build(&mut b, rows(1), &Plain)?;
    let pointer = basin::weak(&first)?;
    assert_eq!(pointer.field("revision")?, first.at(6)?.field("revision")?);
    let (token, _, _) = basin::derive(&first)?;
    assert_eq!(
        basin::node_key(&pointer, "old")?,
        format!(
            "{}old/n-0yve/v.0zg0/t.0zh20/d_{}/{}",
            serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../tests/vectors/object-keys.json"
            ))?["userHeap"]
                .as_str()
                .unwrap(),
            basin::hex(&basin::sha384(&token)),
            pointer.field("revision")?.text()?
        )
    );
    b.storage.objects.remove(&basin::capability(&first)?);
    let second = trie::build(&mut b, rows(1), &Plain)?;
    assert_eq!(
        first.at(6)?.field("sha384")?,
        second.at(6)?.field("sha384")?
    );
    assert_ne!(
        first.at(6)?.field("revision")?,
        second.at(6)?.field("revision")?
    );
    b.clear_cache();
    assert!(b.load(&first).is_err());
    assert!(b.load(&second).is_ok());
    assert!(basin::distinct(&[first, second]).is_err());
    Ok(())
}

#[test]
fn borrowed_metadata_matches_owned_comparisons() -> Result<()> {
    use basinsync_structures::value;
    let mut values = vec![
        Null,
        Bool(true),
        Int(1),
        Float(1.5),
        Float(-0.0),
        Text("0literal".into()),
        Blob(vec![]),
        Blob(vec![1, 2]),
        Big(num_bigint::BigInt::from(1) << 200),
        Symbol("match".into()),
        Global("shared".into()),
    ];
    values.push(Array(values.clone()));
    values.push(Value::map([
        ("__proto__", Text("safe".into())),
        ("values", Array(values.clone())),
    ]));
    for actual in &values {
        let bytes = value::encode(actual)?;
        let reader = flexbuffers::Reader::get_root(bytes.as_slice())?;
        for expected in &values {
            assert_eq!(
                value::matches(reader.clone(), expected)?,
                value::read(reader.clone())? == *expected
            );
        }
    }
    let mut b = basin();
    let summary = values.last().unwrap().clone();
    let e = b.seal(
        Value::map([
            ("0", Symbol("species".into())),
            ("1", basin::DOMAIN.into()),
            ("2", "metadata".into()),
            ("3", basin::empty_query()),
            ("4", 0u32.into()),
            ("5", summary.clone()),
            ("6", Array(vec![7u32.into(), summary])),
        ]),
        &[],
    )?;
    b.load(&e)?;
    b.load(&e)?;
    let mut wrong = e.clone();
    if let Array(a) = &mut wrong {
        a[6].set("1", Null)?;
    }
    assert!(b.load(&wrong).is_err());
    b.load(&e)?;
    Ok(())
}

#[test]
fn volume_filesystem_edits_retain_blocks_and_rehash_directory_paths() -> Result<()> {
    let mut b = basin();
    let block = volume::build_block(&mut b, vec![(0.into(), b"one".to_vec())])?;
    let root = volume::from_blocks(
        &mut b,
        vec![
            ("/src/file".into(), block.clone()),
            ("/src2/file".into(), block.clone()),
        ],
        vec!["/src/empty".into(), "/out".into()],
    )?;
    let key = basin::capability(&block.edge)?;
    let saved = b.storage.objects.remove(&key).unwrap();
    b.clear_cache();
    let _updated = volume::update(
        &mut b,
        &root,
        vec![("/src2/file".into(), Some(b"new".to_vec()))],
    )?;
    let moved = volume::move_path(&mut b, &root, "/src", "/out/moved", false)?;
    let copied = volume::copy_path(&mut b, &moved, "/out/moved", "/copy", false)?;
    let final_root = volume::remove_path(&mut b, &copied, "/out/moved", true)?;
    let canonical = volume::from_blocks(
        &mut b,
        vec![
            ("/copy/file".into(), block.clone()),
            ("/src2/file".into(), block.clone()),
        ],
        vec!["/copy/empty".into(), "/out".into()],
    )?;
    assert_eq!(
        final_root.at(6)?.field("sha384")?,
        canonical.at(6)?.field("sha384")?
    );
    assert_eq!(
        volume::list(&mut b, &final_root, "/copy/empty")?,
        Vec::<String>::new()
    );
    assert_eq!(volume::list(&mut b, &root, "/src")?, vec!["empty", "file"]);
    assert!(volume::remove_path(&mut b, &root, "/src", false).is_err());
    assert!(volume::move_path(&mut b, &root, "/src", "/src/child", false).is_err());
    assert!(volume::move_path(&mut b, &root, "/missing", "/missing", false).is_err());
    assert!(volume::copy_path(&mut b, &root, "/src", "/src", true).is_err());
    assert!(volume::move_path(&mut b, &root, "/src", "/src2", true).is_err());
    assert!(volume::move_path(&mut b, &root, "/src/file", "/src2", true).is_err());
    b.storage.objects.insert(key, saved);
    assert_eq!(
        volume::read(&mut b, &final_root, "/copy/file", true)?,
        b"one"
    );
    Ok(())
}

#[test]
fn consumer_packing_hooks_preserve_trait_object_support() {
    let c = basinsync_structures::trie::Plain;
    let dynamic: &dyn basinsync_structures::trie::Consumer = &c;
    assert!(dynamic.trie_inline_cost().is_none());
}

#[test]
fn restored_allocations_are_reused_and_conflicts_preserve_the_first_revision() -> Result<()> {
    let mut writer = basin();
    let original = trie::build(&mut writer, rows(1), &Plain)?;
    let bytes = writer.storage.objects[&basin::capability(&original)?]
        .1
        .clone();
    let mut restored = original.clone();
    if let Array(parts) = &mut restored {
        parts[6].set("revision", "00000000-0000-4000-8000-000000000099".into())?;
    }
    let mut reader = basin();
    reader.storage.restore(&restored, &bytes, &[])?;
    reader.storage.restore(&original, &bytes, &[])?;
    let mut conflict = bytes.clone();
    conflict[0] ^= 1;
    assert!(reader.storage.restore(&restored, &conflict, &[]).is_err());
    assert_eq!(trie::build(&mut reader, rows(1), &Plain)?, restored);
    Ok(())
}

#[test]
fn sector_sizes_aggregate_empty_and_variable_blobs() -> Result<()> {
    use basinsync_structures::trie::Consumer;
    let c = volume::Sectors;
    assert_eq!(c.empty().field("size")?.big()?, 0.into());
    let parts = [0, 3, 9]
        .into_iter()
        .map(|n| c.entry(&[], &Array(vec![Blob(vec![0; n])])))
        .collect::<Result<Vec<_>>>()?;
    assert_eq!(c.combine(&parts)?.field("size")?.big()?, 12.into());
    Ok(())
}
