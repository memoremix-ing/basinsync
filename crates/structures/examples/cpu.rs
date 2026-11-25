//! Same stored-reader workload in native Rust and WASI; no network.
use anyhow::{Result, ensure};
use basinsync_structures::{
    Value,
    basin::{Basin, MemoryStorage},
    btree,
    trie::{self, Count},
    vector,
};
use std::time::Instant;
fn key(i: usize) -> Vec<u8> {
    (i as u32).to_be_bytes().to_vec()
}
fn main() -> Result<()> {
    let n = 20000usize;
    let lookups = 20000usize;
    let mut samples = vec![];
    for trial in 0..5 {
        let order = if trial % 2 == 0 {
            ["trie", "vector", "btree"]
        } else {
            ["btree", "vector", "trie"]
        };
        for kind in order {
            let mut b = Basin::new(MemoryStorage::default(), vec![42; 32])?;
            let c = Count(0);
            let rows = (0..n)
                .map(|i| (key(i), Value::Int(i as i64)))
                .collect::<Vec<_>>();
            let values = rows.iter().map(|(_, v)| v.clone()).collect();
            let at = Instant::now();
            let root = match kind {
                "trie" => trie::build(&mut b, rows, &c)?,
                "btree" => btree::build(&mut b, rows, &c)?,
                _ => vector::build(&mut b, values, &c)?,
            };
            let build_ms = at.elapsed().as_secs_f64() * 1000.;
            for i in 0..2048 {
                let at = (i * 7919) % n;
                let got = match kind {
                    "trie" => trie::get(&mut b, &root, &key(at), 0)?,
                    "btree" => btree::get(&mut b, &root, &key(at), 0)?,
                    _ => vector::get(&mut b, &root, &at.into(), 0)?,
                };
                ensure!(got == Some(Value::Int(at as i64)));
            }
            let start = Instant::now();
            let mut sum = 0i64;
            for i in 0..lookups {
                let at = (i * 7919) % n;
                let got = match kind {
                    "trie" => trie::get(&mut b, &root, &key(at), 0)?,
                    "btree" => btree::get(&mut b, &root, &key(at), 0)?,
                    _ => vector::get(&mut b, &root, &at.into(), 0)?,
                };
                if let Some(Value::Int(v)) = got {
                    sum += v;
                } else {
                    anyhow::bail!("wrong result");
                }
            }
            ensure!(sum == (n * (n - 1) / 2) as i64);
            samples.push(serde_json::json!({"trial":trial,"kind":kind,"build_ms":build_ms,"reads_ms":start.elapsed().as_secs_f64()*1000.}));
        }
    }
    println!(
        "{}",
        serde_json::json!({"n":n,"lookups":lookups,"method":"5 alternating trials; synchronous null-free count aggregation, memory storage, build includes packing+crypto+puts, warmed stored readers, returned values owned; no logical edits", "samples":samples})
    );
    Ok(())
}
