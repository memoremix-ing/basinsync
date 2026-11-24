//! SL2(F_(2^127-1)), compatible with Bromberg/Shpilrain/Vdovina A(2)/B(2).
use anyhow::{Result, ensure};
use num_bigint::BigUint;
pub type Matrix = [u128; 4];
pub const P: u128 = (1u128 << 127) - 1;
pub const IDENTITY: Matrix = [1, 0, 0, 1];
pub fn bytes(m: Matrix) -> Vec<u8> {
    m.into_iter().flat_map(u128::to_be_bytes).collect()
}
pub fn matrix(bytes: &[u8]) -> Result<Matrix> {
    ensure!(bytes.len() == 64, "invalid SL2 length");
    let m =
        [0, 1, 2, 3].map(|i| u128::from_be_bytes(bytes[i * 16..i * 16 + 16].try_into().unwrap()));
    ensure!(m.iter().all(|n| *n < P), "noncanonical SL2 field");
    let p = BigUint::from(P);
    ensure!(
        (BigUint::from(m[0]) * BigUint::from(m[3]) + &p * &p
            - BigUint::from(m[1]) * BigUint::from(m[2]))
            % &p
            == 1u32.into(),
        "invalid SL2 determinant"
    );
    Ok(m)
}
pub fn multiply(a: Matrix, b: Matrix) -> Matrix {
    let p = BigUint::from(P);
    let dot = |x: u128, y: u128, z: u128, w: u128| {
        let n = (BigUint::from(x) * BigUint::from(y) + BigUint::from(z) * BigUint::from(w)) % &p;
        let mut bytes = [0u8; 16];
        let value = n.to_bytes_be();
        bytes[16 - value.len()..].copy_from_slice(&value);
        u128::from_be_bytes(bytes)
    };
    [
        dot(a[0], b[0], a[1], b[2]),
        dot(a[0], b[1], a[1], b[3]),
        dot(a[2], b[0], a[3], b[2]),
        dot(a[2], b[1], a[3], b[3]),
    ]
}
pub fn hash(input: &[u8]) -> Vec<u8> {
    let _profile = crate::profile::span("sl2.hash");
    let [mut a, mut b, mut c, mut d] = IDENTITY;
    for byte in input {
        for bit in (0..8).rev() {
            if (byte >> bit) & 1 == 1 {
                b = (b + (a * 2) % P) % P;
                d = (d + (c * 2) % P) % P;
            } else {
                a = (a + (b * 2) % P) % P;
                c = (c + (d * 2) % P) % P;
            }
        }
    }
    bytes([a, b, c, d])
}
pub fn combine(parts: &[Vec<u8>]) -> Result<Vec<u8>> {
    let _profile = crate::profile::span("sl2.combine");
    let mut out = IDENTITY;
    for p in parts {
        out = multiply(out, matrix(p)?);
    }
    Ok(bytes(out))
}
