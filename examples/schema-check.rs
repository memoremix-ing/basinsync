//! Validate stored messages against the CDDL schemas in docs/.
//!
//!   cargo run --example schema-check -- DOCS_DIR OBJECT_DIR...
//!
//! OBJECT_DIRs are S3-compatible bucket directories (or any parents of them),
//! such as VersityGW POSIX backends. Timeline events, BulkOrders, and Basin root
//! markers are decoded; every FlexBuffers command tuple is validated against
//! `<path's last segment>-command`, every root marker and commitkernel blob
//! against `basin-root`.
//! Prints per-rule counts and the first failures; exits 1 on any failure.
use anyhow::{Context, Result, bail, ensure};
use basinsync::{envbuf, flexbuffer};
use ciborium::value::Value;
use flexbuffers::{FlexBufferType, Reader};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn schema(docs: &Path) -> Result<String> {
    let mut files = vec![];
    let mut stack = vec![docs.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "md") {
                files.push(path);
            }
        }
    }
    files.sort();
    let mut out = String::new();
    for file in files {
        let text = std::fs::read_to_string(&file)?;
        let mut inside = false;
        for line in text.lines() {
            if line.trim_start() == "```cddl" {
                inside = true;
            } else if inside && line.trim_start() == "```" {
                inside = false;
                out.push('\n');
            } else if inside {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    ensure!(!out.is_empty(), "no cddl blocks under {}", docs.display());
    // cddl 0.10.7 rejects every value against a one-element array such as
    // `[bstr]`; validate `[+ bstr]` and check the count in `exactly_one_frame`.
    ensure!(
        out.contains(ONE_FRAME),
        "docs no longer specify `{ONE_FRAME}`"
    );
    Ok(out.replace(ONE_FRAME, "frames: [+ bstr]"))
}

const ONE_FRAME: &str = "frames: [bstr]";

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value
        .as_map()?
        .iter()
        .find(|(k, _)| k.as_text() == Some(key))
        .map(|(_, v)| v)
}

/// Each Turso delta holds exactly one logical frame (docs/turso-state.md).
fn exactly_one_frame(command: &Value) -> Result<()> {
    let deltas = command
        .as_array()
        .and_then(|a| a.get(3))
        .and_then(|q| field(q, "turso"))
        .and_then(Value::as_map);
    for (database, delta) in deltas.into_iter().flatten() {
        let frames = field(delta, "logical")
            .and_then(|l| field(l, "frames"))
            .and_then(Value::as_array);
        if let Some(frames) = frames {
            ensure!(
                frames.len() == 1,
                "{} delta holds {} logical frames, not one",
                database.as_text().unwrap_or("?"),
                frames.len()
            );
        }
    }
    Ok(())
}

/// FlexBuffers to CBOR's data model, per docs/message-schemas.md.
fn cbor(reader: Reader<&[u8]>) -> Result<Value> {
    use FlexBufferType::*;
    Ok(match reader.flexbuffer_type() {
        Null => Value::Null,
        Bool => Value::Bool(reader.get_bool()?),
        Int | IndirectInt => Value::Integer(reader.get_i64()?.into()),
        UInt | IndirectUInt => Value::Integer(reader.get_u64()?.into()),
        Float | IndirectFloat => Value::Float(reader.get_f64()?),
        Key | String => Value::Text(reader.get_str()?.to_owned()),
        Blob => Value::Bytes(reader.get_blob()?.0.to_vec()),
        VectorUInt => match flexbuffer::read(reader)? {
            flexbuffer::Extension::BigInt(n) => {
                let negative = n.sign() == num_bigint::Sign::Minus;
                let magnitude = if negative { -n - 1 } else { n };
                let (_, bytes) = magnitude.to_bytes_be();
                Value::Tag(if negative { 3 } else { 2 }, Box::new(Value::Bytes(bytes)))
            }
            flexbuffer::Extension::WellKnownSymbol(s) => {
                Value::Tag(60000, Box::new(Value::Text(s)))
            }
            flexbuffer::Extension::GlobalSymbol(s) => Value::Tag(60001, Box::new(Value::Text(s))),
        },
        Map => {
            let map = reader.get_map()?;
            let mut entries = vec![];
            for (key, value) in map.iter_keys().zip(map.iter_values()) {
                entries.push((Value::Text(key.to_owned()), cbor(value)?));
            }
            Value::Map(entries)
        }
        t if t.is_vector() => {
            let vector = reader.as_vector();
            Value::Array(vector.iter().map(cbor).collect::<Result<_>>()?)
        }
        t => bail!("unsupported FlexBuffers type {t:?}"),
    })
}

struct Checker {
    schema: String,
    counts: BTreeMap<String, (usize, usize)>,
    failures: Vec<String>,
}

impl Checker {
    fn check(&mut self, rule: &str, value: &Value, origin: &str) {
        let mut bytes = vec![];
        let outcome = ciborium::into_writer(value, &mut bytes)
            .map_err(anyhow::Error::from)
            .and_then(|()| {
                cddl::validate_cbor_from_slice(
                    &format!("root = {rule}\n{}", self.schema),
                    &bytes,
                    None,
                )
                .map_err(|e| anyhow::anyhow!("{e}"))
            })
            .and_then(|()| {
                if rule == "ingestturso-command" {
                    exactly_one_frame(value)
                } else {
                    Ok(())
                }
            });
        let entry = self.counts.entry(rule.to_owned()).or_default();
        match outcome {
            Ok(()) => entry.0 += 1,
            Err(error) => {
                entry.1 += 1;
                if self.failures.len() < 20 {
                    let first = error
                        .to_string()
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .chars()
                        .take(300)
                        .collect::<std::string::String>();
                    self.failures.push(format!("{rule} in {origin}: {first}"));
                }
            }
        }
    }
    fn command(&mut self, flex: &[u8], origin: &str) {
        let result = flexbuffer::root(flex).and_then(|r| {
            let value = cbor(r)?;
            let path = match &value {
                Value::Array(items) if items.len() == 4 => items[2].as_text().map(str::to_owned),
                _ => None,
            }
            .context("not a command tuple")?;
            Ok((
                format!("{}-command", path.rsplit('/').next().unwrap_or(&path)),
                value,
            ))
        });
        match result {
            Ok((rule, value)) => {
                self.check(&rule, &value, origin);
                if rule == "commitkernel-command" {
                    self.kernel_root(&value, origin);
                }
            }
            Err(error) => self.undecodable("command", origin, error),
        }
    }
    /// A commitkernel's blob is a root message in its own right.
    fn kernel_root(&mut self, command: &Value, origin: &str) {
        let blob = match command {
            Value::Array(items) => items[3].as_map().and_then(|m| {
                m.iter()
                    .find(|(k, _)| k.as_text() == Some("blob"))
                    .and_then(|(_, v)| v.as_bytes())
            }),
            _ => None,
        };
        let Some(blob) = blob else {
            return; // the command schema already reports a missing blob
        };
        match flexbuffer::root(blob).and_then(cbor) {
            Ok(value) => self.check("basin-root", &value, origin),
            Err(error) => self.undecodable("basin-root", origin, error),
        }
    }
    fn undecodable(&mut self, rule: &str, origin: &str, error: anyhow::Error) {
        self.counts.entry(rule.to_owned()).or_default().1 += 1;
        if self.failures.len() < 20 {
            self.failures
                .push(format!("{rule} in {origin}: undecodable: {error:#}"));
        }
    }
    /// A feed of envelopes: nested events recurse, FlexBuffers are commands.
    fn feed(&mut self, bytes: &[u8], origin: &str) -> Result<()> {
        for envelope in envbuf::all(bytes)? {
            match envelope.format {
                envbuf::NESTED => self.feed(envelope.content, origin)?,
                envbuf::FLEXBUFFERS => self.command(envelope.content, origin),
                _ => {}
            }
        }
        Ok(())
    }
    fn object(&mut self, key: &str, bytes: &[u8], origin: &str) {
        if bytes.is_empty() || !bytes.starts_with(b"enV") {
            return; // sentinels, tombstones, and probes carry no message
        }
        let result = if key.starts_with("kernelspace/basin/timeline/")
            || key.starts_with("kernelspace/basin/analogue/")
        {
            self.feed(bytes, origin)
        } else if let Some(position) = key.strip_prefix("kernelspace/basin/epilogue/") {
            if !position.starts_with("0y") {
                return; // PromotionSigns use uncomplemented positions
            }
            match envbuf::message(bytes).and_then(|m| cbor(flexbuffer::root(m)?)) {
                Ok(value) => {
                    self.check("basin-root", &value, origin);
                    Ok(())
                }
                Err(error) => {
                    self.undecodable("basin-root", origin, error);
                    Ok(())
                }
            }
        } else {
            return;
        };
        if let Err(error) = result {
            self.undecodable("envelope", origin, error);
        }
    }
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            walk(&path, out)?;
        } else if !path.to_string_lossy().contains(".sgwtmp") {
            out.push(path);
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    ensure!(
        args.len() >= 2,
        "usage: schema-check DOCS_DIR OBJECT_DIR..."
    );
    let mut checker = Checker {
        schema: schema(&args[0])?,
        counts: Default::default(),
        failures: vec![],
    };
    for root in &args[1..] {
        let mut files = vec![];
        walk(root, &mut files)?;
        for file in files {
            let text = file.to_string_lossy();
            let Some(at) = text.find("/kernelspace/") else {
                continue;
            };
            let key = &text[at + 1..];
            let bytes = std::fs::read(&file)?;
            checker.object(key, &bytes, &text);
        }
    }
    for (rule, (ok, bad)) in &checker.counts {
        println!("{rule:24} {ok:6} valid {bad:6} invalid");
    }
    for failure in &checker.failures {
        println!("  {failure}");
    }
    if checker.counts.is_empty() {
        println!("no stored messages found");
    }
    std::process::exit(i32::from(checker.counts.values().any(|(_, bad)| *bad > 0)));
}
