use super::Consumer;
use crate::{Value, profile};
use anyhow::{Result, ensure};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algorithm {
    Crc64Nvme,
}
impl Algorithm {
    pub fn migration(self) -> u32 {
        match self {
            Self::Crc64Nvme => 1,
        }
    }
    pub fn from_migration(n: u32) -> Result<Self> {
        match n {
            1 => Ok(Self::Crc64Nvme),
            _ => anyhow::bail!("unsupported page checksum migration"),
        }
    }
    pub fn digest(self, summary: &Value) -> Result<Vec<u8>> {
        Ok(summary
            .field(match self {
                Self::Crc64Nvme => "crc64nvme",
            })?
            .blob()?
            .to_vec())
    }
    pub fn hash(self, bytes: &[u8]) -> Vec<u8> {
        match self {
            Self::Crc64Nvme => {
                let _profile = profile::span("crc64nvme.hash");
                crc_fast::crc64_nvme(bytes).to_be_bytes().to_vec()
            }
        }
    }
}
pub(super) struct Pages {
    pub algorithm: Algorithm,
    pub inline: usize,
}
fn crc(summary: &Value) -> Result<u64> {
    let b = summary.field("crc64nvme")?.blob()?;
    ensure!(b.len() == 8, "invalid CRC64NVME length");
    Ok(u64::from_be_bytes(b.try_into()?))
}
fn apply(columns: &[u64; 64], mut value: u64) -> u64 {
    let mut out = 0;
    while value != 0 {
        out ^= columns[value.trailing_zeros() as usize];
        value &= value - 1;
    }
    out
}
// The linear zero-byte shift depends only on the NVME polynomial and byte count,
// not on data. Prepare powers once instead of squaring 64x64 matrices per merge.
static SHIFTS: std::sync::LazyLock<[[u64; 64]; 64]> = std::sync::LazyLock::new(|| {
    let mut powers = [[0u64; 64]; 64];
    for (bit, column) in powers[0].iter_mut().enumerate() {
        let mut v = 1u64 << bit;
        for _ in 0..8 {
            v = (v >> 1) ^ if v & 1 == 1 { 0x9a6c9329ac4bc9b5 } else { 0 };
        }
        *column = v;
    }
    for power in 1..64 {
        let previous = powers[power - 1];
        powers[power] = std::array::from_fn(|bit| apply(&previous, previous[bit]));
    }
    powers
});
pub fn combine_crc(mut left: u64, right: u64, mut length: u64) -> u64 {
    while length != 0 {
        left = apply(&SHIFTS[length.trailing_zeros() as usize], left);
        length &= length - 1;
    }
    left ^ right
}
impl Consumer for Pages {
    fn migration(&self) -> u32 {
        self.algorithm.migration()
    }
    fn trie_inline_limit(&self) -> usize {
        self.inline
    }
    fn empty(&self) -> Value {
        match self.algorithm {
            Algorithm::Crc64Nvme => Value::map([
                ("crc64nvme", Value::Blob(vec![0; 8])),
                ("size", Value::Big(0.into())),
            ]),
        }
    }
    fn entry(&self, _k: &[u8], v: &Value) -> Result<Value> {
        match self.algorithm {
            Algorithm::Crc64Nvme => {
                ensure!(v.array()?.len() == 1, "invalid page");
                let bytes = v.at(0)?.blob()?;
                Ok(Value::map([
                    ("crc64nvme", Value::Blob(self.algorithm.hash(bytes))),
                    ("size", Value::Big(bytes.len().into())),
                ]))
            }
        }
    }
    fn combine(&self, parts: &[Value]) -> Result<Value> {
        match self.algorithm {
            Algorithm::Crc64Nvme => {
                let _profile = profile::span("crc64nvme.combine");
                let mut sum = 0;
                let mut length = num_bigint::BigInt::from(0);
                for p in parts {
                    let n = p.field("size")?.big()?;
                    sum = combine_crc(sum, crc(p)?, u64::try_from(&n)?);
                    length += n;
                }
                Ok(Value::map([
                    ("crc64nvme", Value::Blob(sum.to_be_bytes().to_vec())),
                    ("size", Value::Big(length)),
                ]))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepared_nvme_shifts_match_reference_at_all_length_powers() {
        for n in [0, 1, 17, 16384, 65536, u32::MAX as u64, u64::MAX] {
            for (a, b) in [
                (0, 0),
                (0x123456789abcdef0, 0xfedcba9876543210),
                (u64::MAX, u64::MAX),
            ] {
                assert_eq!(
                    combine_crc(a, b, n),
                    crc_fast::checksum_combine(crc_fast::CrcAlgorithm::Crc64Nvme, a, b, n)
                );
            }
        }
        for bit in 0..64 {
            let n = 1u64 << bit;
            assert_eq!(
                combine_crc(0x9abcdef012345678, 0x0123456789abcdef, n),
                crc_fast::checksum_combine(
                    crc_fast::CrcAlgorithm::Crc64Nvme,
                    0x9abcdef012345678,
                    0x0123456789abcdef,
                    n
                )
            );
        }
    }
}
