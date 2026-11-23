//! Owned interchange values; lazy trie readers retain upstream FlexBuffers Readers.
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use flexbuffers::{FlexBufferType as T, Reader};
use num_bigint::BigInt;
use serde::{
    Serialize, Serializer,
    ser::{SerializeMap, SerializeSeq},
};
use std::collections::BTreeMap;
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Blob(Vec<u8>),
    Big(BigInt),
    Symbol(String),
    Global(String),
    Array(Vec<Value>),
    Map(BTreeMap<String, Value>),
}
use Value::*;
impl Value {
    pub fn map<const N: usize>(items: [(&str, Value); N]) -> Self {
        Map(items.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }
    pub fn field(&self, k: &str) -> Result<&Value> {
        self.map_ref()?
            .get(k)
            .with_context(|| format!("missing field {k}"))
    }
    pub fn at(&self, n: usize) -> Result<&Value> {
        self.array()?.get(n).context("missing vector field")
    }
    pub fn map_ref(&self) -> Result<&BTreeMap<String, Value>> {
        if let Map(v) = self {
            Ok(v)
        } else {
            bail!("expected map")
        }
    }
    pub fn array(&self) -> Result<&[Value]> {
        if let Array(v) = self {
            Ok(v)
        } else {
            bail!("expected vector")
        }
    }
    pub fn blob(&self) -> Result<&[u8]> {
        if let Blob(v) = self {
            Ok(v)
        } else {
            bail!("expected blob")
        }
    }
    pub fn text(&self) -> Result<&str> {
        if let Text(v) = self {
            Ok(v)
        } else {
            bail!("expected string")
        }
    }
    pub fn number(&self) -> Result<u32> {
        if let Int(v) = self {
            Ok(u32::try_from(*v)?)
        } else {
            bail!("expected u32")
        }
    }
    pub fn big(&self) -> Result<BigInt> {
        if let Big(v) = self {
            Ok(v.clone())
        } else {
            bail!("expected bigint")
        }
    }
    pub fn boolean(&self) -> Result<bool> {
        if let Bool(v) = self {
            Ok(*v)
        } else {
            bail!("expected bool")
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Null)
    }
    pub fn index(&self, n: usize) -> Result<&Value> {
        self.field(&n.to_string())
    }
    pub fn set(&mut self, k: &str, v: Value) -> Result<()> {
        if let Map(m) = self {
            m.insert(k.into(), v);
            Ok(())
        } else {
            bail!("expected map")
        }
    }
    pub fn extension(&self) -> Result<Option<Vec<u8>>> {
        Ok(match self {
            Big(v) => Some({
                let negative = v.sign() == num_bigint::Sign::Minus;
                let n = if negative { !v } else { v.clone() };
                let (_, mut b) = n.to_bytes_be();
                if b.is_empty() {
                    b.push(0);
                }
                let mut p = vec![if negative { b'~' } else { b'x' }];
                p.extend(b);
                p
            }),
            Symbol(s) => Some({
                ensure!(well_known(s), "unsupported symbol");
                [b"#", s.as_bytes()].concat()
            }),
            Global(s) => Some([b"$", s.as_bytes()].concat()),
            _ => None,
        })
    }
    pub fn from_json(v: &serde_json::Value) -> Result<Self> {
        Ok(match v {
            serde_json::Value::Null => Null,
            serde_json::Value::Bool(b) => Bool(*b),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    ensure!(i.unsigned_abs() <= 9007199254740991, "unsafe JSON integer");
                    Int(i)
                } else {
                    Float(n.as_f64().context("invalid number")?)
                }
            }
            serde_json::Value::String(s) => {
                if let Some(t) = s.strip_prefix("00") {
                    Text(format!("0{t}"))
                } else if s.len() > 1 && s.starts_with('0') {
                    match s.as_bytes()[1] {
                        b'*' => Blob(URL_SAFE_NO_PAD.decode(&s[2..])?),
                        b'x' | b'~' => {
                            let n = BigInt::parse_bytes(&s.as_bytes()[2..], 16)
                                .context("invalid bigint")?;
                            Big(if s.starts_with("0~") { !n } else { n })
                        }
                        b'#' => {
                            ensure!(well_known(&s[2..]), "unsupported symbol");
                            Symbol(s[2..].into())
                        }
                        b'$' => Global(s[2..].into()),
                        _ => bail!("unsupported JSON0 prefix"),
                    }
                } else {
                    Text(s.clone())
                }
            }
            serde_json::Value::Array(a) => {
                Array(a.iter().map(Self::from_json).collect::<Result<_>>()?)
            }
            serde_json::Value::Object(m) => Map(m
                .iter()
                .map(|(k, v)| Ok((k.clone(), Self::from_json(v)?)))
                .collect::<Result<_>>()?),
        })
    }
    pub fn json(&self) -> serde_json::Value {
        use serde_json::{Value as J, json};
        match self {
            Null => J::Null,
            Bool(b) => J::Bool(*b),
            Int(n) => json!(n),
            Float(f) => json!(f),
            Text(s) => json!(if s.len() > 1 && s.starts_with('0') {
                format!("0{s}")
            } else {
                s.clone()
            }),
            Blob(b) => json!(format!("0*{}", URL_SAFE_NO_PAD.encode(b))),
            Big(n) => json!(if n.sign() == num_bigint::Sign::Minus {
                format!("0~{:x}", !n)
            } else {
                format!("0x{n:x}")
            }),
            Symbol(s) => json!(format!("0#{s}")),
            Global(s) => json!(format!("0${s}")),
            Array(a) => J::Array(a.iter().map(Self::json).collect()),
            Map(m) => J::Object(m.iter().map(|(k, v)| (k.clone(), v.json())).collect()),
        }
    }
}
impl From<u32> for Value {
    fn from(n: u32) -> Self {
        Int(n.into())
    }
}
impl From<usize> for Value {
    fn from(n: usize) -> Self {
        Int(n.try_into().expect("bounded length"))
    }
}
impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Text(s.into())
    }
}
impl Serialize for Value {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::Error;
        if let Some(mut p) = self.extension().map_err(S::Error::custom)? {
            p.resize(p.len().max(5), 0);
            return p.serialize(s);
        }
        match self {
            Null => s.serialize_unit(),
            Bool(b) => s.serialize_bool(*b),
            Int(n) => s.serialize_i64(*n),
            Float(n) => s.serialize_f64(*n),
            Text(t) => s.serialize_str(t),
            Blob(b) => s.serialize_bytes(b),
            Array(a) => {
                let mut seq = s.serialize_seq(Some(a.len()))?;
                for v in a {
                    seq.serialize_element(v)?;
                }
                seq.end()
            }
            Map(m) => {
                let mut map = s.serialize_map(Some(m.len()))?;
                for (k, v) in m {
                    if k.contains('\0') {
                        return Err(S::Error::custom("NUL in map key"));
                    }
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
            _ => unreachable!(),
        }
    }
}
pub fn encode(value: &Value) -> Result<Vec<u8>> {
    let mut bytes = flexbuffers::to_vec(value)?;
    let base = bytes.as_ptr() as usize;
    let mut patches = Vec::new();
    // Only our own serializer output: short UInt extensions have byte-width one.
    #[allow(deprecated)]
    fn walk(v: &Value, r: Reader<&[u8]>, base: usize, out: &mut Vec<(usize, u8)>) -> Result<()> {
        if let Some(p) = v.extension()? {
            if p.len() < 5 {
                let data = r.get_slice::<u8>()?;
                out.push((data.as_ptr() as usize - base - 1, p.len() as u8));
            }
            return Ok(());
        }
        match v {
            Array(a) => {
                let rr = r.get_vector()?;
                for (i, v) in a.iter().enumerate() {
                    walk(v, rr.index(i)?, base, out)?;
                }
            }
            Map(m) => {
                let rr = r.get_map()?;
                for (k, v) in m {
                    walk(v, rr.index(k.as_str())?, base, out)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(
        value,
        Reader::get_root(bytes.as_slice())?,
        base,
        &mut patches,
    )?;
    for (i, n) in patches {
        bytes[i] = n;
    }
    Ok(bytes)
}
pub fn read(r: Reader<&[u8]>) -> Result<Value> {
    fn inner(r: Reader<&[u8]>, depth: usize) -> Result<Value> {
        ensure!(depth < 1024, "value nesting limit");
        Ok(match r.flexbuffer_type() {
            T::Null => Null,
            T::Bool => Bool(r.get_bool()?),
            T::Int | T::UInt | T::IndirectInt | T::IndirectUInt => Int(r.get_i64()?),
            T::Float | T::IndirectFloat => Float(r.get_f64()?),
            T::String | T::Key => Text(r.get_str()?.into()),
            T::Blob => Blob(r.get_blob()?.0.to_vec()),
            T::VectorUInt => read_extension(r)?,
            T::Map => {
                let m = r.get_map()?;
                Map(m
                    .iter_keys()
                    .zip(m.iter_values())
                    .map(|(k, v)| Ok((k.into(), inner(v, depth + 1)?)))
                    .collect::<Result<_>>()?)
            }
            _ => Array(
                r.get_vector()?
                    .iter()
                    .map(|v| inner(v, depth + 1))
                    .collect::<Result<_>>()?,
            ),
        })
    }
    inner(r, 0)
}
pub fn field<'a>(r: Reader<&'a [u8]>, k: &str) -> Result<Reader<&'a [u8]>> {
    Ok(r.get_map()?.index(k)?)
}
pub fn item(r: Reader<&[u8]>, n: usize) -> Result<Reader<&[u8]>> {
    Ok(r.get_vector()?.index(n)?)
}

pub fn well_known(s: &str) -> bool {
    matches!(
        s,
        "asyncIterator" | "iterator" | "match" | "species" | "unscopables"
    )
}
fn read_extension(r: Reader<&[u8]>) -> Result<Value> {
    let p = r
        .get_vector()?
        .iter()
        .map(|v| Ok(u8::try_from(v.get_u64()?)?))
        .collect::<Result<Vec<_>>>()?;
    let (tag, data) = p.split_first().context("empty extension")?;
    Ok(match tag {
        b'x' | b'~' => {
            ensure!(
                !data.is_empty() && (data.len() == 1 || data[0] != 0),
                "noncanonical bigint"
            );
            let n = BigInt::from_bytes_be(num_bigint::Sign::Plus, data);
            Big(if *tag == b'~' { !n } else { n })
        }
        b'#' => {
            let s = std::str::from_utf8(data)?;
            ensure!(well_known(s), "unsupported symbol");
            Symbol(s.into())
        }
        b'$' => Global(std::str::from_utf8(data)?.into()),
        _ => bail!("unsupported extension"),
    })
}
