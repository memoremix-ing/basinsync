use Value::*;
use anyhow::{Context, Result};
use basinsync_structures::{
    Value,
    basin::{self, Basin, MemoryStorage},
    btree, trie, vector, volume,
};
use std::io::{Read, Write};
fn main() -> Result<()> {
    let mode = std::env::args()
        .nth(1)
        .context("expected build or verify")?;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let req = Value::from_json(&serde_json::from_str(&input)?)?;
    let result = if mode == "build" {
        let kind = req.field("kind")?.text()?;
        let seed = req.field("seed")?.blob()?.to_vec();
        let mut basin = Basin::new(MemoryStorage::default(), seed)?;
        let root = if kind == "vector" {
            let rows = req
                .field("items")?
                .array()?
                .iter()
                .map(|v| Ok((v.at(0)?.big()?, v.at(1)?.clone())))
                .collect::<Result<Vec<_>>>()?;
            vector::build_entries_with_bits(
                &mut basin,
                req.field("length")?.big()?,
                rows,
                &trie::Count(7),
                req.map_ref()?
                    .get("bits")
                    .map(Value::number)
                    .transpose()?
                    .unwrap_or(5),
            )?
        } else if kind == "btree" {
            let rows = req
                .field("entries")?
                .array()?
                .iter()
                .map(|v| Ok((basin::key(v.at(0)?.text()?)?, v.at(1)?.clone())))
                .collect::<Result<Vec<_>>>()?;
            btree::build(&mut basin, rows, &trie::Count(7))?
        } else if kind == "trie" {
            let rows = req
                .field("entries")?
                .array()?
                .iter()
                .map(|r| {
                    Ok((
                        basinsync_structures::basin::key(r.at(0)?.text()?)?,
                        r.at(1)?.clone(),
                    ))
                })
                .collect::<Result<_>>()?;
            trie::build(&mut basin, rows, &trie::Count(7))?
        } else if kind == "pages" {
            let pages = req
                .field("pages")?
                .array()?
                .iter()
                .map(|v| Ok((v.at(0)?.big()?, v.at(1)?.blob()?.to_vec())))
                .collect::<Result<_>>()?;
            let block = volume::build_block(&mut basin, pages)?;
            volume::from_blocks(&mut basin, vec![("/sparse".into(), block)], vec![])?
        } else {
            let files = req
                .field("files")?
                .array()?
                .iter()
                .map(|r| Ok((r.at(0)?.text()?.to_string(), r.at(1)?.blob()?.to_vec())))
                .collect::<Result<_>>()?;
            volume::build_with_directories(
                &mut basin,
                files,
                req.map_ref()?
                    .get("directories")
                    .map(|v| {
                        v.array()?
                            .iter()
                            .map(|v| Ok(v.text()?.to_string()))
                            .collect::<Result<Vec<_>>>()
                    })
                    .transpose()?
                    .unwrap_or_default(),
            )?
        };
        let objects = basin
            .storage
            .objects
            .into_values()
            .map(|(e, b)| Array(vec![e, Blob(b)]))
            .collect();
        Value::map([
            ("kind", kind.into()),
            ("root", root),
            ("objects", Array(objects)),
            (
                "queries",
                req.map_ref()?.get("queries").cloned().unwrap_or(Null),
            ),
        ])
    } else {
        let kind = req.field("kind")?.text()?;
        let mut storage = MemoryStorage::default();
        for v in req.field("objects")?.array()? {
            storage.restore(v.at(0)?, v.at(1)?.blob()?, &[])?;
        }
        let mut basin = Basin::new(storage, vec![42; 32])?;
        let root = req.field("root")?;
        let rows = if kind == "vector" {
            vector::entries(&mut basin, root, 7)?
                .into_iter()
                .map(|(i, v)| Array(vec![Big(i), v]))
                .collect()
        } else if kind == "btree" {
            btree::entries(&mut basin, root, 7)?
                .into_iter()
                .map(|(k, v)| Array(vec![basin::hex(&k).as_str().into(), v]))
                .collect()
        } else if kind == "trie" {
            trie::entries(&mut basin, root, &[], 7)?
                .into_iter()
                .map(|(k, v)| {
                    Array(vec![
                        basinsync_structures::basin::hex(&k).as_str().into(),
                        v,
                    ])
                })
                .collect()
        } else if kind == "pages" {
            req.field("queries")?
                .array()?
                .iter()
                .map(|q| {
                    Ok(Array(vec![
                        q.clone(),
                        volume::page(&mut basin, root, "/sparse", &q.big()?, true)?
                            .map(Blob)
                            .unwrap_or(Null),
                    ]))
                })
                .collect::<Result<_>>()?
        } else {
            fn walk(
                b: &mut Basin<MemoryStorage>,
                root: &Value,
                p: &str,
                out: &mut Vec<Value>,
            ) -> Result<()> {
                for name in volume::list(b, root, p)? {
                    let path = if p == "/" {
                        format!("/{name}")
                    } else {
                        format!("{p}/{name}")
                    };
                    if volume::list(b, root, &path).is_ok() {
                        out.push(Array(vec![path.as_str().into(), Null]));
                        walk(b, root, &path, out)?
                    } else {
                        let bytes = volume::read(b, root, &path, true)?;
                        let strong = volume::read(b, root, &path, false)?;
                        anyhow::ensure!(bytes == strong, "shortcut mismatch");
                        out.push(Array(vec![path.as_str().into(), Blob(bytes)]));
                    }
                }
                Ok(())
            }
            let mut files = vec![];
            walk(&mut basin, root, "/", &mut files)?;
            files
        };
        let mut keys = req
            .field("objects")?
            .array()?
            .iter()
            .map(|v| basin::node_key(&basin::weak(v.at(0)?)?, "old"))
            .collect::<Result<Vec<_>>>()?;
        keys.sort();
        let mut output = Value::map([
            ("keys", Array(keys.into_iter().map(Text).collect())),
            ("kind", kind.into()),
            ("rows", Array(rows)),
            ("query", root.at(3)?.clone()),
            ("header", root.at(5)?.clone()),
        ]);
        if kind == "vector" {
            let mut probes = vec![];
            if let Some(Array(queries)) = req.map_ref()?.get("queries") {
                for i in queries {
                    let v = vector::get(&mut basin, root, &i.big()?, 7)?;
                    probes.push(Array(vec![i.clone(), Bool(v.is_some()), v.unwrap_or(Null)]));
                }
            }
            output.set("probes", Array(probes))?;
        }
        output
    };
    let json = serde_json::to_vec(&result.json())?;
    std::io::stdout().write_all(&json)?;
    Ok(())
}
