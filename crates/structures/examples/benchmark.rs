use anyhow::{Result, ensure};
use basinsync_structures::{
    Value,
    basin::{self, Basin, Edge, MemoryStorage, PendingEdge, Storage},
    trie::{self, Count},
};
use std::{
    io::{self, Read},
    time::Instant,
};
#[derive(Default)]
struct Store {
    inner: MemoryStorage,
    reads: u64,
    bytes: u64,
}
impl Storage for Store {
    fn put(&mut self, e: &PendingEdge, b: &[u8], refs: &[Edge]) -> Result<String> {
        self.inner.put(e, b, refs)
    }
    fn get(&mut self, e: &Edge) -> Result<Vec<u8>> {
        let b = self.inner.get(e)?;
        self.reads += 1;
        self.bytes += b.len() as u64;
        Ok(b)
    }
}
fn phase<F: FnOnce(&mut Basin<Store>) -> Result<()>>(
    b: &mut Basin<Store>,
    out: &mut serde_json::Map<String, serde_json::Value>,
    name: &str,
    f: F,
) -> Result<()> {
    let (r, n) = (b.storage.reads, b.storage.bytes);
    let start = Instant::now();
    f(b)?;
    out.insert(
        format!("{name}_ms"),
        (start.elapsed().as_secs_f64() * 1000.).into(),
    );
    out.insert(format!("{name}_reads"), (b.storage.reads - r).into());
    out.insert(format!("{name}_bytes"), (b.storage.bytes - n).into());
    Ok(())
}
fn main() -> Result<()> {
    let mut text = String::new();
    io::stdin().read_to_string(&mut text)?;
    let req: serde_json::Value = serde_json::from_str(&text)?;
    let rows = req["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            Ok((
                basin::key(r[0].as_str().unwrap())?,
                Value::Int(r[1].as_i64().unwrap()),
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let queries = req["queries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_u64().unwrap() as usize)
        .collect::<Vec<_>>();
    let prefix = basin::key(req["prefix"].as_str().unwrap())?;
    let hot = req["hot"].as_u64().unwrap() as usize;
    let cold = req["cold"].as_u64().unwrap() as usize;
    let c = Count(7);
    let mut warm = Basin::new(Store::default(), vec![42; 32])?;
    let root = trie::build(&mut warm, rows[..256.min(rows.len())].to_vec(), &c)?;
    for i in 0..256 {
        let i = i % 256.min(rows.len());
        ensure!(trie::get(&mut warm, &root, &rows[i].0, 7)? == Some(rows[i].1.clone()));
    }
    drop(warm);
    let mut b = Basin::new(Store::default(), vec![42; 32])?;
    let mut out = serde_json::Map::new();
    let mut root = Value::Null;
    phase(&mut b, &mut out, "build", |b| {
        root = trie::build(b, rows.clone(), &c)?;
        Ok(())
    })?;
    out.insert("objects".into(), b.storage.inner.objects.len().into());
    out.insert(
        "stored_bytes".into(),
        b.storage
            .inner
            .objects
            .values()
            .map(|(_, v)| v.len())
            .sum::<usize>()
            .into(),
    );
    out.insert(
        "height".into(),
        root.at(3)?.field("height")?.number()?.into(),
    );
    for i in queries.iter().take(64) {
        ensure!(trie::get(&mut b, &root, &rows[*i].0, 7)? == Some(rows[*i].1.clone()));
    }
    phase(&mut b, &mut out, "hot", |b| {
        for j in 0..hot {
            let i = queries[j % 64];
            ensure!(trie::get(b, &root, &rows[i].0, 7)? == Some(rows[i].1.clone()));
        }
        Ok(())
    })?;
    phase(&mut b, &mut out, "mixed", |b| {
        for i in &queries {
            ensure!(trie::get(b, &root, &rows[*i].0, 7)? == Some(rows[*i].1.clone()));
        }
        Ok(())
    })?;
    phase(&mut b, &mut out, "miss", |b| {
        for i in &queries {
            let mut key = rows[*i].0.clone();
            key.push(255);
            ensure!(trie::get(b, &root, &key, 7)?.is_none());
        }
        Ok(())
    })?;
    phase(&mut b, &mut out, "cold", |b| {
        for i in queries.iter().take(cold) {
            b.clear_cache();
            ensure!(trie::get(b, &root, &rows[*i].0, 7)? == Some(rows[*i].1.clone()));
        }
        Ok(())
    })?;
    phase(&mut b, &mut out, "scan", |b| {
        let mut count = 0usize;
        let mut sum = 0u64;
        trie::visit(b, &root, &[], 7, &mut |_, _| true, &mut |_, v| {
            count += 1;
            sum += v.owned()?.number()? as u64;
            Ok(true)
        })?;
        ensure!(count == rows.len() && sum == (count as u64) * (count as u64 - 1) / 2);
        Ok(())
    })?;
    let mut prefix_count = 0usize;
    phase(&mut b, &mut out, "prefix", |b| {
        trie::visit(b, &root, &prefix, 7, &mut |_, _| true, &mut |_, _| {
            prefix_count += 1;
            Ok(true)
        })?;
        ensure!(prefix_count == req["prefix_count"].as_u64().unwrap() as usize);
        Ok(())
    })?;
    phase(&mut b, &mut out, "pruned", |b| {
        for _ in 0..1000 {
            trie::visit(b, &root, &prefix, 7, &mut |_, _| false, &mut |_, _| {
                anyhow::bail!("unpruned")
            })?;
        }
        Ok(())
    })?;
    for count in [1, 100] {
        phase(&mut b, &mut out, &format!("update{count}"), |b| {
            let changes = queries
                .iter()
                .take(count)
                .map(|i| {
                    Ok((
                        rows[*i].0.clone(),
                        Some(Value::Int(
                            i64::from(rows[*i].1.number()?) + rows.len() as i64,
                        )),
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            let next = trie::update(b, &root, changes, &c)?;
            ensure!(
                trie::get(b, &next, &rows[queries[0]].0, 7)?
                    .unwrap()
                    .number()?
                    == rows[queries[0]].1.number()? + rows.len() as u32
            );
            Ok(())
        })?;
    }
    out.insert("implementation".into(), "rust".into());
    out.insert("prefix_count".into(), prefix_count.into());
    out.insert("hot_ops".into(), hot.into());
    out.insert("mixed_ops".into(), queries.len().into());
    out.insert("cold_ops".into(), cold.into());
    println!("{}", serde_json::Value::Object(out));
    Ok(())
}
