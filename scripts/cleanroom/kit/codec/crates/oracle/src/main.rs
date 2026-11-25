//! `basinsync-oracle`: reads one JSON request per line on stdin and writes
//! exactly one JSON response per line on stdout (see ORACLE-INTERFACE.md).

use std::io::{self, BufRead, Write};

use basinsync_codec::{diffuse16, envbuf, flexbuffers, json0, keys, lexidecimal, BigInt, Error};
use serde_json::{json, Map, Value};

/// Largest envelope the oracle will materialize (alignment powers up to 31
/// would otherwise demand gigabyte responses).
const MAX_ORACLE_ENVELOPE: usize = 1 << 24;

enum Outcome {
    Ok(Value),
    Err(String),
    Unsupported,
}

fn err<T>(msg: impl Into<String>) -> Result<T, String> {
    Err(msg.into())
}

fn codec<T>(r: Result<T, Error>) -> Result<T, String> {
    r.map_err(|e| e.message().to_string())
}

fn field<'a>(req: &'a Map<String, Value>, name: &str) -> Result<&'a Value, String> {
    req.get(name).ok_or_else(|| format!("missing field `{name}`"))
}

/// Integers travel as decimal strings; integral JSON numbers are tolerated.
fn integer(req: &Map<String, Value>, name: &str) -> Result<BigInt, String> {
    match field(req, name)? {
        Value::String(s) => codec(BigInt::parse_decimal(s)),
        Value::Number(n) if n.is_i64() || n.is_u64() => codec(BigInt::parse_decimal(&n.to_string())),
        _ => err(format!("`{name}` must be a decimal string")),
    }
}

fn string<'a>(req: &'a Map<String, Value>, name: &str) -> Result<&'a str, String> {
    field(req, name)?.as_str().ok_or_else(|| format!("`{name}` must be a string"))
}

fn small_number(req: &Map<String, Value>, name: &str) -> Result<u64, String> {
    match field(req, name)? {
        Value::Number(n) => n.as_u64().ok_or_else(|| format!("`{name}` must be a nonnegative integer")),
        Value::String(s) => codec(BigInt::parse_decimal(s))?
            .to_u64()
            .ok_or_else(|| format!("`{name}` out of range")),
        _ => err(format!("`{name}` must be a number")),
    }
}

fn bytes(req: &Map<String, Value>, name: &str) -> Result<Vec<u8>, String> {
    let arr = field(req, name)?.as_array().ok_or_else(|| format!("`{name}` must be a byte array"))?;
    arr.iter()
        .map(|v| v.as_u64().filter(|&b| b <= 255).map(|b| b as u8))
        .collect::<Option<Vec<u8>>>()
        .ok_or_else(|| format!("`{name}` must contain integers 0-255"))
}

fn byte_array(b: &[u8]) -> Value {
    Value::Array(b.iter().map(|&x| Value::from(x)).collect())
}

fn handle(req: &Map<String, Value>) -> Result<Outcome, String> {
    let op = string(req, "op")?;
    let ok = |v: Value| Ok(Outcome::Ok(v));
    match op {
        "lexidecimal.encode" => ok(Value::from(lexidecimal::encode(&integer(req, "value")?))),
        "lexidecimal.decode" => ok(Value::from(codec(lexidecimal::decode(string(req, "text")?))?.to_decimal())),
        "lexidecimal.sizePrefix" => {
            let size = small_number(req, "size")?;
            let negative = field(req, "negative")?.as_bool().ok_or("`negative` must be a boolean")?;
            ok(Value::from(lexidecimal::size_prefix(size, negative)))
        }
        "diffuse16.encode" => ok(Value::from(diffuse16::encode(&integer(req, "value")?))),
        "diffuse16.decode" => ok(Value::from(codec(diffuse16::decode(string(req, "text")?))?.to_decimal())),
        "envbuf.encode" => {
            let format = small_number(req, "format")?;
            let power = small_number(req, "alignmentPower")?;
            if format > 7 || power > 31 {
                return err("format or alignmentPower out of range");
            }
            let content = bytes(req, "content")?;
            let total = codec(envbuf::envelope_len(content.len(), power as u8))?;
            if total > MAX_ORACLE_ENVELOPE {
                return err("envelope too large for the oracle");
            }
            ok(byte_array(&codec(envbuf::encode(format as u8, power as u8, &content))?))
        }
        "envbuf.decode" => {
            let wire = bytes(req, "wire")?;
            let env = codec(envbuf::decode_one(&wire))?;
            ok(json!({"format": env.format, "content": byte_array(env.message(&wire))}))
        }
        "flexbuffers.encodeExtension" => {
            let present: Vec<&str> =
                ["bigint", "wellKnownSymbol", "globalSymbol"].into_iter().filter(|k| req.contains_key(*k)).collect();
            if present.len() != 1 {
                return err("exactly one of bigint, wellKnownSymbol, globalSymbol is required");
            }
            let ext = match present[0] {
                "bigint" => flexbuffers::Extension::BigInt(integer(req, "bigint")?),
                "wellKnownSymbol" => flexbuffers::Extension::WellKnownSymbol(string(req, "wellKnownSymbol")?.to_string()),
                _ => flexbuffers::Extension::GlobalSymbol(string(req, "globalSymbol")?.to_string()),
            };
            ok(byte_array(&codec(flexbuffers::encode_extension(&ext))?))
        }
        "flexbuffers.decodeExtension" => {
            let wire = bytes(req, "wire")?;
            ok(match codec(flexbuffers::decode_extension(&wire))? {
                flexbuffers::Extension::BigInt(v) => json!({"bigint": v.to_decimal()}),
                flexbuffers::Extension::WellKnownSymbol(s) => json!({"wellKnownSymbol": s}),
                flexbuffers::Extension::GlobalSymbol(s) => json!({"globalSymbol": s}),
            })
        }
        "json0.encode" => {
            let present: Vec<&str> = ["text", "bigint", "bytes", "wellKnownSymbol", "globalSymbol"]
                .into_iter()
                .filter(|k| req.contains_key(*k))
                .collect();
            if present.len() != 1 {
                return err("exactly one of text, bigint, bytes, wellKnownSymbol, globalSymbol is required");
            }
            let value = match present[0] {
                "text" => json0::Value::String(string(req, "text")?.to_string()),
                "bigint" => json0::Value::BigInt(integer(req, "bigint")?),
                "bytes" => json0::Value::Bytes(bytes(req, "bytes")?),
                "wellKnownSymbol" => json0::Value::WellKnownSymbol(string(req, "wellKnownSymbol")?.to_string()),
                _ => json0::Value::GlobalSymbol(string(req, "globalSymbol")?.to_string()),
            };
            match codec(json0::string_spelling(&value))? {
                Some(wire) => ok(Value::from(wire)),
                None => err("not a JSON0 string value"),
            }
        }
        "json0.decode" => ok(match codec(json0::interpret_string(string(req, "wire")?, json0::Options::default()))? {
            json0::Value::String(t) => json!({"text": t}),
            json0::Value::BigInt(n) => json!({"bigint": n.to_decimal()}),
            json0::Value::Bytes(b) => json!({"bytes": byte_array(&b)}),
            json0::Value::WellKnownSymbol(s) => json!({"wellKnownSymbol": s}),
            json0::Value::GlobalSymbol(s) => json!({"globalSymbol": s}),
            other => return err(format!("unsupported JSON0 value {other:?}")),
        }),
        "timeline.key" => ok(Value::from(codec(keys::timeline_key(&integer(req, "milestone")?))?)),
        "timeline.milestone" => ok(Value::from(codec(keys::timeline_milestone(string(req, "key")?))?.to_decimal())),
        "flow.normalize" => ok(Value::from(codec(keys::normalize_flow_id(string(req, "id")?))?)),
        "keys.prefixes" => ok(json!({
            "timeline": keys::TIMELINE,
            "basinEpilogue": keys::BASIN_EPILOGUE,
            "analogue": keys::ANALOGUE,
            "kernelHeap": keys::KERNEL_HEAP,
            "userHeap": keys::USER_HEAP,
            "userFlows": keys::USER_FLOWS,
            "emptySentinel": keys::EMPTY_SENTINEL,
        })),
        _ => Ok(Outcome::Unsupported),
    }
}

fn respond(line: &str) -> Value {
    let outcome = match serde_json::from_str::<Value>(line) {
        Ok(Value::Object(req)) => {
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle(&req))) {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => Outcome::Err(e),
                Err(_) => Outcome::Err("internal error".into()),
            }
        }
        Ok(_) => Outcome::Err("request must be a JSON object".into()),
        Err(e) => Outcome::Err(format!("invalid JSON: {e}")),
    };
    match outcome {
        Outcome::Ok(v) => json!({ "ok": v }),
        Outcome::Err(e) => json!({ "error": e }),
        Outcome::Unsupported => json!({ "unsupported": true }),
    }
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let mut reader = stdin.lock();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        if buf.last() == Some(&b'\n') {
            buf.pop();
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
        }
        let resp = match std::str::from_utf8(&buf) {
            Ok(line) => respond(line),
            Err(_) => json!({"error": "request line is not UTF-8"}),
        };
        if writeln!(out, "{resp}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(line: &str) -> String {
        respond(line).to_string()
    }

    #[test]
    fn ops() {
        assert_eq!(r(r#"{"op":"lexidecimal.encode","value":"-17"}"#), r#"{"ok":"0yuef"}"#);
        assert_eq!(r(r#"{"op":"lexidecimal.decode","text":"0zwhg10000000000000000"}"#), r#"{"ok":"18446744073709551616"}"#);
        assert_eq!(r(r#"{"op":"lexidecimal.sizePrefix","size":256,"negative":false}"#), r#"{"ok":"xghgg"}"#);
        assert_eq!(r(r#"{"op":"diffuse16.encode","value":"27"}"#), r#"{"ok":"0wb1z"}"#);
        assert_eq!(r(r#"{"op":"diffuse16.decode","text":"0w0y"}"#), r#"{"ok":"-16"}"#);
        assert_eq!(r(r#"{"op":"timeline.key","milestone":"1"}"#), r#"{"ok":"kernelspace/basin/timeline/0yve"}"#);
        assert_eq!(r(r#"{"op":"timeline.milestone","key":"kernelspace/basin/timeline/0yve"}"#), r#"{"ok":"1"}"#);
        assert_eq!(r(r#"{"op":"flow.normalize","id":"AbC"}"#), r#"{"ok":"abc"}"#);
        assert_eq!(r(r#"{"op":"flexbuffers.encodeExtension","bigint":"0"}"#), r#"{"ok":[2,120,0,2,48,1]}"#);
        assert_eq!(r(r#"{"op":"flexbuffers.decodeExtension","wire":[2,126,0,2,48,1]}"#), r#"{"ok":{"bigint":"-1"}}"#);
        assert_eq!(
            r(r#"{"op":"envbuf.decode","wire":[101,110,86,163,1,0,0,0,7,238,238,238,238,238,238,238,1,0,0,0,163,118,78,69]}"#),
            r#"{"ok":{"content":[7],"format":5}}"#
        );
        assert!(r(r#"{"op":"keys.prefixes"}"#).contains(r#""emptySentinel":"kernelspace/sentinel/empty""#));
    }

    #[test]
    fn failures() {
        assert_eq!(r(r#"{"op":"nope"}"#), r#"{"unsupported":true}"#);
        assert!(r("not json").starts_with(r#"{"error""#));
        assert!(r(r#"{"op":"lexidecimal.decode","text":"0zg00"}"#).starts_with(r#"{"error""#));
        assert!(r(r#"{"op":"flexbuffers.encodeExtension","bigint":"1","globalSymbol":"a"}"#).starts_with(r#"{"error""#));
        assert!(r(r#"{"op":"envbuf.encode","format":0,"alignmentPower":31,"content":[]}"#).starts_with(r#"{"error""#));
        assert!(r(r#"{"op":"envbuf.encode","format":0,"alignmentPower":3,"content":[256]}"#).starts_with(r#"{"error""#));
        assert!(r(r#"{"op":"timeline.key","milestone":"0"}"#).starts_with(r#"{"error""#));
        assert!(r("").starts_with(r#"{"error""#));
    }
}
