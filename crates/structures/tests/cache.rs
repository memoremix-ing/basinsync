use anyhow::Result;
use basinsync_structures::{
    Value,
    basin::{self, Basin, MemoryStorage},
    trie::{self, Plain},
};
fn roots() -> Result<(Basin<MemoryStorage>, Vec<Value>)> {
    let mut b = Basin::new(MemoryStorage::default(), vec![42; 32])?;
    let mut roots = vec![];
    for i in 0..129 {
        roots.push(trie::build(
            &mut b,
            vec![(vec![0], Value::Blob(vec![i as u8; 32]))],
            &Plain,
        )?);
    }
    b.clear_cache();
    Ok((b, roots))
}
#[test]
fn shared_lru_traces_cover_recency_budgets_clear_and_descriptor_checks() -> Result<()> {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/vectors/cache.json"))?;
    for case in cases["scenarios"].as_array().unwrap() {
        for rotate in 0..3 {
            let (mut b, roots) = roots()?;
            let length = basin::footer(&roots[0])?.field("length")?.number()? as i64;
            b.max_cache_bytes = (case["capacity"].as_i64().unwrap() * length
                + case["extraBytes"].as_i64().unwrap()) as usize;
            for step in case["steps"].as_array().unwrap() {
                let edge = &roots[(step[1].as_u64().unwrap() as usize + rotate) % 3];
                match step[0].as_str().unwrap() {
                    "load" => {
                        b.load(edge)?;
                    }
                    "peek" => assert_eq!(
                        b.peek(edge)?.is_some(),
                        step[3].as_bool().unwrap(),
                        "{case}"
                    ),
                    "clear" => b.clear_cache(),
                    "badLength" => {
                        let mut bad = edge.clone();
                        if let Value::Array(parts) = &mut bad {
                            parts[6].set("length", ((length + 1) as usize).into())?;
                        }
                        assert!(b.load(&bad).is_err());
                    }
                    _ => unreachable!(),
                }
                assert_eq!(
                    b.storage.reads,
                    step[2].as_u64().unwrap() as usize,
                    "{case}"
                );
            }
        }
    }
    Ok(())
}
#[test]
fn count_limit_evicts_a_cold_node_while_peeks_protect_the_hot_node() -> Result<()> {
    let (mut b, roots) = roots()?;
    b.load(&roots[0])?;
    for root in &roots[1..] {
        b.load(root)?;
        assert!(b.peek(&roots[0])?.is_some());
    }
    assert!(b.peek(&roots[1])?.is_none());
    assert_eq!(b.storage.reads, 129);
    Ok(())
}
