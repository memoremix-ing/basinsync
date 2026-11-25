//! JSON0: a JSON dialect interpreting value strings that begin with `0`
//! (`docs/glossary/json0.md`).
//!
//! | Prefix | Value |
//! | --- | --- |
//! | `00` | literal string: remove the first `0` |
//! | `0x` | nonnegative bigint, hexadecimal |
//! | `0~` | complement of a hexadecimal bigint |
//! | `0.` | arbitrary-precision decimal real (`e` exponent) |
//! | `0*` | bytes, base64url (writers omit padding) |
//! | `0%` | bytes, standard base64 |
//! | `0#` | well-known symbol |
//! | `0$` | global symbol name |
//! | `0w`, `0y`, `0z`, `0[A-Z]` | reserved |
//! | `0_` | application extension (needs agreement) |
//!
//! Object keys are never interpreted. A lone `"0"` is invalid.

use crate::bigint::BigInt;
use crate::error::{Error, Result};
use crate::flexbuffers::WELL_KNOWN_SYMBOLS;

/// A JSON0 value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    /// `null`
    Null,
    /// `true` / `false`
    Bool(bool),
    /// An ordinary JSON number, kept as its validated source text.
    Number(String),
    /// A literal string (already unescaped; `00` prefix removed).
    String(String),
    /// `0x` / `0~` bigint.
    BigInt(BigInt),
    /// `0.` decimal real: the validated text after the prefix.
    Decimal(String),
    /// `0*` / `0%` bytes.
    Bytes(Vec<u8>),
    /// `0#` well-known symbol name.
    WellKnownSymbol(String),
    /// `0$` global symbol name.
    GlobalSymbol(String),
    /// `0_` application extension: the text after `0_`.
    Extension(String),
    /// Array.
    Array(Vec<Value>),
    /// Object with unique keys, in source order.
    Object(Vec<(String, Value)>),
}

/// Parsing options.
#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// Accept `0_` application extensions (as [`Value::Extension`]).
    pub allow_extensions: bool,
}

/// Maximum nesting depth accepted by the parser.
pub const MAX_DEPTH: usize = 512;

// ---------------------------------------------------------------- base64

const STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64_value(c: u8, url: bool) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' if !url => Some(62),
        b'/' if !url => Some(63),
        b'-' if url => Some(62),
        b'_' if url => Some(63),
        _ => None,
    }
}

/// Length of [`base64_encode_into`] output.
pub const fn base64_encoded_len(n: usize, url: bool) -> usize {
    if url {
        n / 3 * 4 + [0, 2, 3][n % 3]
    } else {
        n.div_ceil(3) * 4
    }
}

/// Allocation-free base64 encoder (`url` alphabet without padding, or the
/// standard alphabet with padding). Returns the length written.
pub fn base64_encode_into(bytes: &[u8], url: bool, out: &mut [u8]) -> Result<usize> {
    let alpha = if url { URL } else { STD };
    let total = base64_encoded_len(bytes.len(), url);
    if out.len() < total {
        return Err(Error::BufferTooSmall);
    }
    let mut i = 0;
    let mut o = 0;
    while i < bytes.len() {
        let n = if bytes.len() - i >= 3 { 3 } else { bytes.len() - i };
        let b1 = if n > 1 { bytes[i + 1] } else { 0 };
        let b2 = if n > 2 { bytes[i + 2] } else { 0 };
        let v = (bytes[i] as u32) << 16 | (b1 as u32) << 8 | b2 as u32;
        let mut k = 0;
        while k < 4 {
            if k <= n {
                out[o] = alpha[((v >> (18 - 6 * k)) & 63) as usize];
                o += 1;
            } else if !url {
                out[o] = b'=';
                o += 1;
            }
            k += 1;
        }
        i += 3;
    }
    Ok(o)
}

/// Encode base64 (`url` alphabet without padding, or standard with padding).
pub fn base64_encode(bytes: &[u8], url: bool) -> String {
    let mut out = vec![0u8; base64_encoded_len(bytes.len(), url)];
    let n = base64_encode_into(bytes, url, &mut out).expect("sized");
    out.truncate(n);
    String::from_utf8(out).expect("ascii")
}

/// Allocation-free strict base64 decoder: the given alphabet, optional but
/// then exact `=` padding, no whitespace, and zero unused trailing bits.
/// `out` needs `text.len() / 4 * 3 + 2` bytes; returns the length written.
pub fn base64_decode_into(text: &[u8], url: bool, out: &mut [u8]) -> Result<usize> {
    let mut body_len = text.len();
    if text.len() % 4 == 0 && !text.is_empty() {
        let mut pad = 0;
        while pad < 3 && pad < text.len() && text[text.len() - 1 - pad] == b'=' {
            pad += 1;
        }
        if pad > 2 {
            return Err(Error::BadBase64);
        }
        body_len -= pad;
    }
    if body_len % 4 == 1 {
        return Err(Error::BadBase64);
    }
    let mut i = 0;
    let mut o = 0;
    while i < body_len {
        let chunk = if body_len - i >= 4 { 4 } else { body_len - i };
        let mut v: u32 = 0;
        let mut k = 0;
        while k < chunk {
            let d = match b64_value(text[i + k], url) {
                Some(d) => d,
                None => return Err(Error::BadBase64),
            };
            v |= (d as u32) << (18 - 6 * k);
            k += 1;
        }
        let bytes = chunk - 1;
        let unused_mask = match bytes {
            1 => 0xffff,
            2 => 0xff,
            _ => 0,
        };
        if v & unused_mask != 0 {
            return Err(Error::BadBase64);
        }
        if out.len() < o + bytes {
            return Err(Error::BufferTooSmall);
        }
        let mut k = 0;
        while k < bytes {
            out[o] = (v >> (16 - 8 * k)) as u8;
            o += 1;
            k += 1;
        }
        i += 4;
    }
    Ok(o)
}

/// Decode base64 strictly (see [`base64_decode_into`]).
pub fn base64_decode(text: &[u8], url: bool) -> Result<Vec<u8>> {
    let mut out = vec![0u8; text.len() / 4 * 3 + 2];
    let n = base64_decode_into(text, url, &mut out)?;
    out.truncate(n);
    Ok(out)
}

// ------------------------------------------------------- string decoding

/// Validate the JSON number grammar: `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`.
pub fn is_json_number(t: &[u8]) -> bool {
    let mut i = 0;
    if t.get(i) == Some(&b'-') {
        i += 1;
    }
    match t.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => {
            while matches!(t.get(i), Some(b'0'..=b'9')) {
                i += 1;
            }
        }
        _ => return false,
    }
    if t.get(i) == Some(&b'.') {
        i += 1;
        let s = i;
        while matches!(t.get(i), Some(b'0'..=b'9')) {
            i += 1;
        }
        if i == s {
            return false;
        }
    }
    if matches!(t.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(t.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let s = i;
        while matches!(t.get(i), Some(b'0'..=b'9')) {
            i += 1;
        }
        if i == s {
            return false;
        }
    }
    i == t.len()
}

/// Allocation-free core of the leading-`0` rule: where a literal string's
/// text starts within its spelling (0, or 1 after an added `0`), or `None`
/// when the spelling encodes another kind of value. A lone `0` is invalid.
pub fn literal_offset(spelling: &[u8]) -> Result<Option<usize>> {
    match (spelling.first(), spelling.get(1)) {
        (Some(b'0'), None) => Err(Error::ReservedPrefix),
        (Some(b'0'), Some(b'0')) => Ok(Some(1)),
        (Some(b'0'), Some(_)) => Ok(None),
        _ => Ok(Some(0)),
    }
}

/// Whether a literal string gains a `0` when spelled: every string beginning
/// with `0`, including "0" itself.
pub fn literal_needs_zero(text: &[u8]) -> bool {
    text.first() == Some(&b'0')
}

/// Interpret a JSON string *value* (not an object key) under JSON0.
pub fn interpret_string(s: &str, opts: Options) -> Result<Value> {
    let b = s.as_bytes();
    if let Some(start) = literal_offset(b)? {
        return Ok(Value::String(s[start..].to_string()));
    }
    let tag = b[1];
    let rest = &s[2..];
    match tag {
        b'x' => Ok(Value::BigInt(BigInt::from_hex_digits(rest.as_bytes()).map_err(|_| Error::BadNumber)?)),
        b'~' => Ok(Value::BigInt(BigInt::from_hex_digits(rest.as_bytes()).map_err(|_| Error::BadNumber)?.not())),
        b'.' => {
            if is_json_number(rest.as_bytes()) {
                Ok(Value::Decimal(rest.to_string()))
            } else {
                Err(Error::BadNumber)
            }
        }
        b'*' => Ok(Value::Bytes(base64_decode(rest.as_bytes(), true)?)),
        b'%' => Ok(Value::Bytes(base64_decode(rest.as_bytes(), false)?)),
        b'#' => {
            if WELL_KNOWN_SYMBOLS.contains(&rest) {
                Ok(Value::WellKnownSymbol(rest.to_string()))
            } else {
                Err(Error::UnknownSymbol)
            }
        }
        b'$' => Ok(Value::GlobalSymbol(rest.to_string())),
        b'_' if opts.allow_extensions => Ok(Value::Extension(rest.to_string())),
        _ => Err(Error::ReservedPrefix),
    }
}

// ----------------------------------------------------------------- parser

struct Parser<'a> {
    t: &'a [u8],
    i: usize,
    opts: Options,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while matches!(self.t.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, lit: &[u8]) -> Result<()> {
        if self.t[self.i..].starts_with(lit) {
            self.i += lit.len();
            Ok(())
        } else {
            Err(Error::BadJson)
        }
    }

    fn hex4(&mut self) -> Result<u32> {
        let mut v = 0u32;
        for _ in 0..4 {
            let c = *self.t.get(self.i).ok_or(Error::BadJson)?;
            v = v << 4 | crate::hex::any_digit_value(c).ok_or(Error::BadJson)? as u32;
            self.i += 1;
        }
        Ok(v)
    }

    fn string(&mut self) -> Result<String> {
        self.eat(b"\"")?;
        let mut out = String::new();
        loop {
            let start = self.i;
            while let Some(&c) = self.t.get(self.i) {
                if c == b'"' || c == b'\\' || c < 0x20 {
                    break;
                }
                self.i += 1;
            }
            // The input is &str, so this slice is valid UTF-8 at ASCII boundaries.
            out.push_str(core::str::from_utf8(&self.t[start..self.i]).map_err(|_| Error::BadUtf8)?);
            match self.t.get(self.i) {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = *self.t.get(self.i).ok_or(Error::BadJson)?;
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xd800..0xdc00).contains(&hi) {
                                self.eat(b"\\u").map_err(|_| Error::BadUtf8)?;
                                let lo = self.hex4()?;
                                if !(0xdc00..0xe000).contains(&lo) {
                                    return Err(Error::BadUtf8);
                                }
                                0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
                            } else if (0xdc00..0xe000).contains(&hi) {
                                return Err(Error::BadUtf8);
                            } else {
                                hi
                            };
                            out.push(char::from_u32(cp).ok_or(Error::BadUtf8)?);
                        }
                        _ => return Err(Error::BadJson),
                    }
                }
                _ => return Err(Error::BadJson),
            }
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value> {
        if depth > MAX_DEPTH {
            return Err(Error::TooDeep);
        }
        self.ws();
        match self.t.get(self.i) {
            None => Err(Error::BadJson),
            Some(b'n') => self.eat(b"null").map(|_| Value::Null),
            Some(b't') => self.eat(b"true").map(|_| Value::Bool(true)),
            Some(b'f') => self.eat(b"false").map(|_| Value::Bool(false)),
            Some(b'"') => {
                let s = self.string()?;
                interpret_string(&s, self.opts)
            }
            Some(b'[') => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.t.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Value::Array(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.t.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Array(items));
                        }
                        _ => return Err(Error::BadJson),
                    }
                }
            }
            Some(b'{') => {
                self.i += 1;
                let mut entries: Vec<(String, Value)> = Vec::new();
                let mut seen = std::collections::HashSet::new();
                self.ws();
                if self.t.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Value::Object(entries));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    if !seen.insert(k.clone()) {
                        return Err(Error::DuplicateKey);
                    }
                    self.ws();
                    self.eat(b":")?;
                    let v = self.value(depth + 1)?;
                    entries.push((k, v));
                    self.ws();
                    match self.t.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Object(entries));
                        }
                        _ => return Err(Error::BadJson),
                    }
                }
            }
            Some(_) => {
                let start = self.i;
                while matches!(self.t.get(self.i), Some(b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')) {
                    self.i += 1;
                }
                let num = &self.t[start..self.i];
                if !is_json_number(num) {
                    return Err(Error::BadJson);
                }
                Ok(Value::Number(core::str::from_utf8(num).expect("ascii").to_string()))
            }
        }
    }
}

/// Parse JSON0 text with options.
pub fn parse_with(text: &str, opts: Options) -> Result<Value> {
    let mut p = Parser { t: text.as_bytes(), i: 0, opts };
    let v = p.value(0)?;
    p.ws();
    if p.i != p.t.len() {
        return Err(Error::BadJson);
    }
    Ok(v)
}

/// Parse JSON0 text, rejecting `0_` extensions.
pub fn parse(text: &str) -> Result<Value> {
    parse_with(text, Options::default())
}

// ------------------------------------------------------------- serializer

fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The JSON0 string spelling of a non-container value that is carried in a
/// JSON string, or `None` for null/bool/number/containers.
pub fn string_spelling(v: &Value) -> Result<Option<String>> {
    Ok(Some(match v {
        Value::String(s) if literal_needs_zero(s.as_bytes()) => format!("0{s}"),
        Value::String(s) => s.clone(),
        Value::BigInt(n) if n.is_negative() => format!("0~{}", n.not().magnitude_hex()),
        Value::BigInt(n) => format!("0x{}", n.magnitude_hex()),
        Value::Decimal(d) => {
            if !is_json_number(d.as_bytes()) {
                return Err(Error::BadNumber);
            }
            format!("0.{d}")
        }
        Value::Bytes(b) => format!("0*{}", base64_encode(b, true)),
        Value::WellKnownSymbol(s) => {
            if !WELL_KNOWN_SYMBOLS.contains(&s.as_str()) {
                return Err(Error::UnknownSymbol);
            }
            format!("0#{s}")
        }
        Value::GlobalSymbol(s) => format!("0${s}"),
        Value::Extension(s) => format!("0_{s}"),
        _ => return Ok(None),
    }))
}

fn write_value(out: &mut String, v: &Value) -> Result<()> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if !is_json_number(n.as_bytes()) {
                return Err(Error::BadNumber);
            }
            out.push_str(n)
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item)?;
            }
            out.push(']');
        }
        Value::Object(entries) => {
            let mut seen = std::collections::HashSet::new();
            out.push('{');
            for (i, (k, item)) in entries.iter().enumerate() {
                if !seen.insert(k) {
                    return Err(Error::DuplicateKey);
                }
                if i > 0 {
                    out.push(',');
                }
                write_json_string(out, k);
                out.push(':');
                write_value(out, item)?;
            }
            out.push('}');
        }
        other => {
            let s = string_spelling(other)?.expect("string-carried value");
            write_json_string(out, &s);
        }
    }
    Ok(())
}

/// Serialize compactly. Writers use `0*` (unpadded base64url) for bytes and
/// minimal lowercase hex for bigints.
pub fn to_string(v: &Value) -> Result<String> {
    let mut out = String::new();
    write_value(&mut out, v)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn prefixes() {
        let p = |s: &str| parse(s).unwrap();
        assert_eq!(p(r#""00""#), Value::String("0".into()));
        assert_eq!(p(r#""007""#), Value::String("07".into()));
        assert_eq!(p(r#""0x0""#), Value::BigInt(BigInt::zero()));
        assert_eq!(p(r#""0xff""#), Value::BigInt(BigInt::from_i128(255)));
        assert_eq!(p(r#""0~0""#), Value::BigInt(BigInt::from_i128(-1)));
        assert_eq!(p(r#""0.-1.5e3""#), Value::Decimal("-1.5e3".into()));
        assert_eq!(p(r#""0*AAE""#), Value::Bytes(vec![0, 1]));
        assert_eq!(p(r#""0%AAE=""#), Value::Bytes(vec![0, 1]));
        assert_eq!(p(r#""0*-_8""#), Value::Bytes(vec![0xfb, 0xff]));
        assert_eq!(p(r#""0#species""#), Value::WellKnownSymbol("species".into()));
        assert_eq!(p(r#""0$app""#), Value::GlobalSymbol("app".into()));
        assert_eq!(p(r#""plain""#), Value::String("plain".into()));
        assert_eq!(p(r#""""#), Value::String("".into()));
        assert_eq!(p(r#"{"0x":1}"#), Value::Object(vec![("0x".into(), Value::Number("1".into()))]));
        for bad in [
            r#""0""#, r#""0w1""#, r#""0y""#, r#""0zg0""#, r#""0A""#, r#""0_ext""#, r#""0!""#,
            r#""0#toString""#, r#""0x""#, r#""0xg""#, r#""0.""#, r#""0.1.""#, r#""0*A""#,
            r#""0*AB""#, r#""0%A-==""#, r#""01""#,
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        assert_eq!(
            parse_with(r#""0_ext""#, Options { allow_extensions: true }).unwrap(),
            Value::Extension("ext".into())
        );
    }

    #[test]
    fn documents() {
        let v = parse(r#" {"viewpoint":"0x0","timelines":{"basin":{"milestone":"0x1"}},"a":[1,-2.5e3,true,null]} "#).unwrap();
        assert_eq!(
            to_string(&v).unwrap(),
            r#"{"viewpoint":"0x0","timelines":{"basin":{"milestone":"0x1"}},"a":[1,-2.5e3,true,null]}"#
        );
        assert_eq!(parse(r#"{"a":1,"a":2}"#), Err(Error::DuplicateKey));
        assert_eq!(parse(r#""\ud800""#), Err(Error::BadUtf8));
        assert_eq!(parse(r#""😀""#).unwrap(), Value::String("😀".into()));
        assert!(parse("01").is_err());
        assert!(parse("[1,]").is_err());
        assert!(parse("1 2").is_err());
        assert_eq!(to_string(&Value::String("0".into())).unwrap(), r#""00""#);
        assert_eq!(to_string(&Value::BigInt(BigInt::from_i128(-256))).unwrap(), r#""0~ff""#);
        assert_eq!(to_string(&Value::Bytes(vec![0xfb, 0xff])).unwrap(), r#""0*-_8""#);
        assert_eq!(to_string(&Value::String("a\"\u{1}".into())).unwrap(), r#""a\"\u0001""#);
    }

    #[test]
    fn base64() {
        for len in 0..10 {
            let data: Vec<u8> = (0..len as u8).map(|i| i.wrapping_mul(37)).collect();
            for url in [true, false] {
                assert_eq!(base64_decode(base64_encode(&data, url).as_bytes(), url).unwrap(), data);
            }
        }
        assert_eq!(base64_encode(b"f", false), "Zg==");
        assert_eq!(base64_encode(b"f", true), "Zg");
        assert_eq!(base64_decode(b"Zg==", true).unwrap(), b"f");
        assert!(base64_decode(b"Zh", true).is_err()); // nonzero trailing bits
        assert!(base64_decode(b"Z===", true).is_err());
        assert!(base64_decode(b"Zg=", true).is_err());
    }

    fn leaf() -> impl Strategy<Value = Value> {
        prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            any::<i64>().prop_map(|n| Value::Number(n.to_string())),
            "\\PC{0,8}".prop_map(Value::String),
            any::<i128>().prop_map(|n| Value::BigInt(BigInt::from_i128(n))),
            prop::collection::vec(any::<u8>(), 0..12).prop_map(Value::Bytes),
            prop::sample::select(WELL_KNOWN_SYMBOLS.to_vec()).prop_map(|s| Value::WellKnownSymbol(s.into())),
            "\\PC{0,8}".prop_map(Value::GlobalSymbol),
            "-?[1-9][0-9]{0,5}(\\.[0-9]{1,4})?(e[+-]?[0-9]{1,3})?".prop_map(Value::Decimal),
        ]
    }

    proptest! {
        #[test]
        fn roundtrip(v in leaf().prop_recursive(3, 24, 4, |inner| prop_oneof![
            prop::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
            prop::collection::btree_map("\\PC{0,4}", inner, 0..4).prop_map(|m| Value::Object(m.into_iter().collect())),
        ])) {
            let s = to_string(&v).unwrap();
            prop_assert_eq!(parse(&s).unwrap(), v);
        }

        #[test]
        fn never_panics(s in "\\PC{0,24}") {
            let _ = parse(&s);
        }
    }
}
