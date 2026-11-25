//! This implementation's side of scripts/cleanroom/oracle-interface.md: the
//! reference the clean-room oracles are calibrated against.
use anyhow::{Context, Result, bail};
use basinsync::{envbuf, epilogue, event, flexbuffer, lexidecimal, timeline};
use num_bigint::{BigInt, BigUint};
use serde_json::{Value, json};
use std::io::{BufRead, Write};

fn text<'a>(request: &'a Value, field: &str) -> Result<&'a str> {
    request[field]
        .as_str()
        .with_context(|| format!("missing {field}"))
}
fn bytes(request: &Value, field: &str) -> Result<Vec<u8>> {
    Ok(serde_json::from_value(request[field].clone())?)
}

fn answer(request: &Value) -> Result<Value> {
    Ok(match text(request, "op")? {
        "lexidecimal.encode" => json!(lexidecimal::encode(
            &text(request, "value")?.parse::<BigInt>()?
        )),
        "lexidecimal.decode" => json!(lexidecimal::decode(text(request, "text")?)?.to_string()),
        "lexidecimal.sizePrefix" => json!(lexidecimal::size_prefix(
            usize::try_from(request["size"].as_u64().context("missing size")?)?,
            request["negative"].as_bool().unwrap_or(false),
        )),
        "diffuse16.encode" => json!(basinsync::diffuse16::encode(
            &text(request, "value")?.parse::<BigInt>()?
        )),
        "diffuse16.decode" => {
            json!(basinsync::diffuse16::decode(text(request, "text")?)?.to_string())
        }
        "envbuf.encode" => {
            let mut out = vec![];
            envbuf::append_with_alignment(
                &mut out,
                &bytes(request, "content")?,
                u8::try_from(request["format"].as_u64().context("missing format")?)?,
                u8::try_from(
                    request["alignmentPower"]
                        .as_u64()
                        .context("missing alignmentPower")?,
                )?,
            )?;
            json!(out)
        }
        "envbuf.decode" => {
            let wire = bytes(request, "wire")?;
            let envelope = envbuf::at(&wire, 0)?;
            if envelope.end != wire.len() {
                bail!("trailing bytes after the envelope");
            }
            json!({"format": envelope.format, "content": envelope.content})
        }
        "flexbuffers.encodeExtension" => {
            let extension = if let Some(n) = request["bigint"].as_str() {
                flexbuffer::Extension::BigInt(n.parse()?)
            } else if let Some(name) = request["wellKnownSymbol"].as_str() {
                flexbuffer::Extension::WellKnownSymbol(name.into())
            } else {
                flexbuffer::Extension::GlobalSymbol(text(request, "globalSymbol")?.into())
            };
            json!(flexbuffer::encode(&extension)?)
        }
        "flexbuffers.decodeExtension" => {
            let wire = bytes(request, "wire")?;
            match flexbuffer::read(flexbuffer::root(wire.as_slice())?)? {
                flexbuffer::Extension::BigInt(n) => json!({"bigint": n.to_string()}),
                flexbuffer::Extension::WellKnownSymbol(name) => json!({"wellKnownSymbol": name}),
                flexbuffer::Extension::GlobalSymbol(name) => json!({"globalSymbol": name}),
            }
        }
        "timeline.key" => json!(timeline::key(
            &text(request, "milestone")?.parse::<BigUint>()?
        )?),
        "timeline.milestone" => json!(timeline::from_key(text(request, "key")?)?.to_string()),
        "flow.normalize" => json!(event::normalize_flow(text(request, "id")?)?),
        "json0.encode" => {
            use basinsync::json0::Scalar;
            let value = if let Some(t) = request["text"].as_str() {
                Scalar::Text(t.into())
            } else if let Some(n) = request["bigint"].as_str() {
                Scalar::BigInt(n.parse()?)
            } else if request.get("bytes").is_some() {
                Scalar::Bytes(bytes(request, "bytes")?)
            } else if let Some(name) = request["wellKnownSymbol"].as_str() {
                Scalar::WellKnownSymbol(name.into())
            } else {
                Scalar::GlobalSymbol(text(request, "globalSymbol")?.into())
            };
            json!(basinsync::json0::encode_scalar(&value)?)
        }
        "json0.decode" => {
            use basinsync::json0::Scalar;
            match basinsync::json0::decode_scalar(text(request, "wire")?)? {
                Scalar::Text(t) => json!({"text": t}),
                Scalar::BigInt(n) => json!({"bigint": n.to_string()}),
                Scalar::Bytes(b) => json!({"bytes": b}),
                Scalar::WellKnownSymbol(s) => json!({"wellKnownSymbol": s}),
                Scalar::GlobalSymbol(s) => json!({"globalSymbol": s}),
            }
        }
        "keys.prefixes" => {
            let flows = epilogue::flow_prefix("x", &uuid::Uuid::nil());
            json!({
                "timeline": timeline::PREFIX,
                "basinEpilogue": epilogue::BASIN_PREFIX,
                "analogue": basinsync::analogue::PREFIX,
                "kernelHeap": basinsync::kernel::YOUNG.trim_end_matches("young/"),
                "userHeap": basinsync::heap::YOUNG.trim_end_matches("young/"),
                "userFlows": &flows[..flows.find("x/").context("flow prefix")?],
                "emptySentinel": basinsync::sequence::REFERENCE_KEY,
            })
        }
        _ => return Ok(json!({"unsupported": true})),
    })
}

fn main() -> Result<()> {
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let response = match answer(&request) {
            Ok(value) if value.get("unsupported").is_some() => value,
            Ok(value) => json!({"ok": value}),
            Err(problem) => json!({"error": format!("{problem:#}")}),
        };
        writeln!(out, "{response}")?;
    }
    Ok(())
}
