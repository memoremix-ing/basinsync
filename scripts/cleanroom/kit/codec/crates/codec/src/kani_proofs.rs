//! Kani harnesses. Run one at a time with `scripts/kani-all.sh`; results are
//! recorded in `crates/codec/KANI.md`.
//!
//! Bounds are the `N`/`MAX_*` constants named in each harness; inputs are
//! symbolic byte arrays with a symbolic length up to that bound.

use crate::{crc32c, diffuse16, envbuf, flexbuffers, hex, json0, keys, lexidecimal, sha384};

/// A symbolic byte string of length `0..=N`.
fn any_bytes<const N: usize>() -> ([u8; N], usize) {
    let bytes: [u8; N] = kani::any();
    let len: usize = kani::any();
    kani::assume(len <= N);
    (bytes, len)
}

// ------------------------------------------------------------ Lexidecimal

/// Parsing and decoding arbitrary text up to 10 bytes never panics.
#[kani::proof]
#[kani::unwind(12)]
fn lex_decode_no_panic() {
    let (b, len) = any_bytes::<10>();
    let t = &b[..len];
    let _ = lexidecimal::parse(t);
    let _ = lexidecimal::decode_i128(t);
}

/// Writing any size prefix succeeds, has the predicted length, and uses
/// only the sign's alphabet.
#[kani::proof]
#[kani::unwind(18)]
fn lex_size_prefix_any_u64() {
    let s: u64 = kani::any();
    let negative: bool = kani::any();
    let mut out = [0u8; lexidecimal::MAX_SIZE_PREFIX_LEN];
    let n = lexidecimal::write_size_prefix(s, negative, &mut out).unwrap();
    assert!(n == lexidecimal::size_prefix_len(s));
    let digits_start = if n == 1 { 0 } else { 1 };
    if n > 1 {
        let m = out[0];
        assert!(if negative { (b'W'..=b'Z').contains(&m) } else { (b'w'..=b'z').contains(&m) });
    }
    let mut i = digits_start;
    while i < n {
        assert!((b'g'..=b'v').contains(&out[i]));
        i += 1;
    }
}

/// decode(encode(v)) == v for every i64.
#[kani::proof]
#[kani::unwind(34)]
fn lex_roundtrip_i64() {
    let v: i64 = kani::any();
    let mut buf = [0u8; lexidecimal::MAX_I128_LEN];
    let n = lexidecimal::encode_i128(v as i128, &mut buf);
    assert!(lexidecimal::decode_i128(&buf[..n]) == Ok(v as i128));
}

/// decode(encode(v)) == v for every i128.
#[kani::proof]
#[kani::unwind(34)]
fn lex_roundtrip_i128() {
    let v: i128 = kani::any();
    let mut buf = [0u8; lexidecimal::MAX_I128_LEN];
    let n = lexidecimal::encode_i128(v, &mut buf);
    assert!(lexidecimal::decode_i128(&buf[..n]) == Ok(v));
}

/// Every accepted string up to 8 bytes re-encodes to itself: noncanonical
/// spellings are rejected.
#[kani::proof]
#[kani::unwind(36)]
fn lex_accepted_is_canonical() {
    let (b, len) = any_bytes::<8>();
    let t = &b[..len];
    if let Ok(v) = lexidecimal::decode_i128(t) {
        let mut buf = [0u8; lexidecimal::MAX_I128_LEN];
        let n = lexidecimal::encode_i128(v, &mut buf);
        assert!(n == len);
        assert!(&buf[..n] == t);
    }
}

/// Structural canonicity independent of integer width: any parsed string up
/// to 12 bytes is reproduced by encoding its uncomplemented payload digits.
#[kani::proof]
#[kani::unwind(14)]
fn lex_parse_reencode_structural() {
    let (b, len) = any_bytes::<12>();
    let t = &b[..len];
    if let Ok(p) = lexidecimal::parse(t) {
        let mut digits = [0u8; 12];
        let pl = len - p.payload_start;
        let mut i = 0;
        while i < pl {
            let c = t[p.payload_start + i];
            digits[i] = if p.negative { hex::complement_digit(c) } else { c };
            i += 1;
        }
        let mut out = [0u8; 12];
        let n = lexidecimal::encode_hex_into(p.negative, &digits[..pl], &mut out).unwrap();
        assert!(n == len);
        assert!(&out[..n] == t);
    }
}

/// Lexicographic order of encodings follows numeric order (i16).
#[kani::proof]
#[kani::unwind(34)]
fn lex_order_i16() {
    let a: i16 = kani::any();
    let b: i16 = kani::any();
    let mut ba = [0u8; lexidecimal::MAX_I128_LEN];
    let mut bb = [0u8; lexidecimal::MAX_I128_LEN];
    let na = lexidecimal::encode_i128(a as i128, &mut ba);
    let nb = lexidecimal::encode_i128(b as i128, &mut bb);
    assert!(ba[..na].cmp(&bb[..nb]) == a.cmp(&b));
}

// -------------------------------------------------------------- Diffuse16

/// Parsing and decoding arbitrary text up to 10 bytes never panics.
#[kani::proof]
#[kani::unwind(12)]
fn d16_decode_no_panic() {
    let (b, len) = any_bytes::<10>();
    let _ = diffuse16::decode_i128(&b[..len]);
}

/// decode(encode(v)) == v for every i128.
#[kani::proof]
#[kani::unwind(34)]
fn d16_roundtrip_i128() {
    let v: i128 = kani::any();
    let mut buf = [0u8; diffuse16::MAX_I128_LEN];
    let n = diffuse16::encode_i128(v, &mut buf);
    assert!(diffuse16::decode_i128(&buf[..n]) == Ok(v));
}

/// Every accepted string up to 10 bytes re-encodes to itself.
#[kani::proof]
#[kani::unwind(34)]
fn d16_accepted_is_canonical() {
    let (b, len) = any_bytes::<10>();
    let t = &b[..len];
    if let Ok(v) = diffuse16::decode_i128(t) {
        let mut buf = [0u8; diffuse16::MAX_I128_LEN];
        let n = diffuse16::encode_i128(v, &mut buf);
        assert!(n == len);
        assert!(&buf[..n] == t);
    }
}

// ----------------------------------------------------------------- EnvBuf

/// Framing-level decoding (forward and backward) never panics on arbitrary
/// bytes up to 40, covering huge declared lengths and alignment powers.
#[kani::proof]
#[kani::unwind(42)]
fn envbuf_decode_no_panic() {
    let (b, len) = any_bytes::<40>();
    let w = &b[..len];
    let _ = envbuf::decode_envelope(w);
    let _ = envbuf::parse_ending_at(w, len);
}

/// Feed validation, including nested feeds, never panics on arbitrary bytes
/// up to `N` (a single nested envelope holding one inner envelope needs 32).
#[kani::proof]
#[kani::unwind(34)]
fn envbuf_validate_feed_no_panic() {
    let (b, len) = any_bytes::<32>();
    let _ = envbuf::validate_feed(&b[..len]);
}

/// Nested validation over a concrete outer nested header/footer with a
/// symbolic 16-byte inner region: accepted iff the inner region is one
/// valid zero-length envelope.
#[kani::proof]
#[kani::unwind(34)]
fn envbuf_nested_shell() {
    let inner: [u8; 16] = kani::any();
    let mut w = [0u8; 32];
    envbuf::encode_into(envbuf::format::NESTED, 3, &inner, &mut w).unwrap();
    let ok = envbuf::decode_one(&w).is_ok();
    assert!(ok == envbuf::decode_envelope(&inner).is_ok());
}

/// Round trip: any supported non-nested format, alignment power <= 4,
/// message <= 8 bytes encodes to an aligned envelope that decodes to the
/// same fields, forward and backward.
#[kani::proof]
#[kani::unwind(34)]
fn envbuf_roundtrip() {
    let (msg, len) = any_bytes::<8>();
    let format: u8 = kani::any();
    let power: u8 = kani::any();
    kani::assume(power <= 4);
    kani::assume(envbuf::is_supported_format(format) && format != envbuf::format::NESTED);
    let mut out = [0u8; 32];
    let n = envbuf::encode_into(format, power, &msg[..len], &mut out).unwrap();
    assert!(n % (1usize << power) == 0);
    assert!(n >= len + envbuf::FRAMING_LEN);
    let env = envbuf::decode_envelope(&out[..n]).unwrap();
    assert!(env.format == format && env.alignment_power == power && env.message_len == len);
    assert!(env.message(&out[..n]) == &msg[..len]);
    assert!(envbuf::parse_ending_at(&out[..n], n) == Ok(env));
}

/// Every accepted single envelope up to 32 bytes is exactly what the
/// encoder produces for its fields (padding, footer and length are
/// canonical, so altered encodings are rejected).
#[kani::proof]
#[kani::unwind(34)]
fn envbuf_accepted_is_canonical() {
    let (b, len) = any_bytes::<32>();
    let w = &b[..len];
    if let Ok(env) = envbuf::decode_envelope(w) {
        let mut out = [0u8; 32];
        let n = envbuf::encode_into(env.format, env.alignment_power, env.message(w), &mut out).unwrap();
        assert!(n == len);
        assert!(&out[..n] == w);
    }
}

/// Counter margins are 24 bytes and carry any u64.
#[kani::proof]
#[kani::unwind(26)]
fn envbuf_counter_margin_any_u64() {
    let c: u64 = kani::any();
    let m = envbuf::counter_margin(c);
    assert!(m.len() == 24);
    assert!(envbuf::counter_margin_value(&m) == Ok(c));
}

// ------------------------------------------------------------ FlexBuffers

/// Validating arbitrary bytes up to 10 never panics, and every accepted
/// bigint has a minimal magnitude. (12 bytes ran 803 s / 13.9 GB, then
/// exceeded the 900 s timeout, so the bound was reduced to 10.)
#[kani::proof]
#[kani::unwind(12)]
fn fb_validate_no_panic() {
    let (b, len) = any_bytes::<10>();
    let w = &b[..len];
    if let Ok((p, v)) = flexbuffers::validate(w) {
        if p == flexbuffers::prefix::BIGINT || p == flexbuffers::prefix::NEGATIVE_BIGINT {
            assert!(v.len >= 2);
            assert!(v.len == 2 || flexbuffers::element(w, &v, 1).unwrap() != 0);
        }
    }
}

/// Round trip: a bigint magnitude of up to 4 bytes (minimal) or a global
/// symbol of up to 4 ASCII bytes encodes and validates back to the same
/// payload.
#[kani::proof]
#[kani::unwind(10)]
fn fb_roundtrip() {
    let (payload, len) = any_bytes::<4>();
    let prefix: u8 = kani::any();
    kani::assume(prefix == b'x' || prefix == b'~' || prefix == b'$');
    if prefix == b'$' {
        let mut i = 0;
        while i < len {
            kani::assume(payload[i] < 0x80);
            i += 1;
        }
    } else {
        kani::assume(len >= 1 && (len == 1 || payload[0] != 0));
    }
    let mut out = [0u8; 16];
    let n = flexbuffers::encode_into(prefix, &payload[..len], &mut out).unwrap();
    let (p, v) = flexbuffers::validate(&out[..n]).unwrap();
    assert!(p == prefix && v.len == len + 1);
    let mut i = 0;
    while i < len {
        assert!(flexbuffers::element(&out[..n], &v, i + 1) == Ok(payload[i]));
        i += 1;
    }
}

// ------------------------------------------------------------------ Flow ids

/// Normalization never panics on arbitrary bytes up to 8; accepted ids are
/// lowercase, keep their length, and normalize idempotently.
#[kani::proof]
#[kani::unwind(10)]
fn flow_normalize() {
    let (b, len) = any_bytes::<8>();
    let mut out = [0u8; 8];
    if let Ok(n) = keys::normalize_flow_id_into(&b[..len], &mut out) {
        assert!(n == len && n >= 1);
        let mut i = 0;
        while i < n {
            assert!(keys::is_flow_id_byte(out[i]) && !out[i].is_ascii_uppercase());
            assert!(out[i] == b[i].to_ascii_lowercase());
            i += 1;
        }
        let mut again = [0u8; 8];
        let m = keys::normalize_flow_id_into(&out[..n], &mut again).unwrap();
        assert!(m == n && again[..m] == out[..n]);
    }
}

// ----------------------------------------------------------------- CRC32C

/// The table-driven CRC32C equals the bitwise definition for any seed and
/// inputs up to 4 bytes, and appending is associative over a split.
#[kani::proof]
#[kani::unwind(10)]
fn crc32c_table_matches_bitwise() {
    let (b, len) = any_bytes::<4>();
    let seed: u32 = kani::any();
    let split: usize = kani::any();
    kani::assume(split <= len);
    let d = &b[..len];
    assert!(crc32c::append(seed, d) == crc32c::append_bitwise(seed, d));
    assert!(crc32c::append(crc32c::append(seed, &d[..split]), &d[split..]) == crc32c::append(seed, d));
}

// ---------------------------------------------------------------- SHA-384


// ------------------------------------------------------------------ JSON0

/// The leading-`0` rule (docs round 5): spelling any literal, by the codec's
/// own core, and reading it back yields the same text, so "0" becomes "00"
/// and a lone "0" never appears. Strings up to 4 bytes.
#[kani::proof]
#[kani::unwind(6)]
fn json0_literal_round_trip() {
    let (t, len) = any_bytes::<4>();
    let text = &t[..len];
    let mut w = [0u8; 5];
    let mut n = 0;
    if json0::literal_needs_zero(text) {
        w[0] = b'0';
        n = 1;
    }
    let mut i = 0;
    while i < len {
        w[n + i] = text[i];
        i += 1;
    }
    match json0::literal_offset(&w[..n + len]) {
        Ok(Some(k)) => assert!(&w[k..n + len] == text),
        _ => panic!("a literal's spelling must read back as that literal"),
    }
}

/// The JSON number grammar check never panics (inputs up to 8 bytes).
#[kani::proof]
#[kani::unwind(10)]
fn json0_number_grammar_no_panic() {
    let (b, len) = any_bytes::<8>();
    let _ = json0::is_json_number(&b[..len]);
}

/// Base64url decoding never panics (text up to 8 bytes), and every
/// accepted unpadded text re-encodes to itself; standard base64 likewise
/// with padding. Exercises the allocation-free cores.
#[kani::proof]
#[kani::unwind(10)]
fn json0_base64_canonical() {
    let (b, len) = any_bytes::<8>();
    let url: bool = kani::any();
    let t = &b[..len];
    let mut bytes = [0u8; 8];
    if let Ok(n) = json0::base64_decode_into(t, url, &mut bytes) {
        let padded = len > 0 && t[len - 1] == b'=';
        if url != padded {
            let mut enc = [0u8; 12];
            let m = json0::base64_encode_into(&bytes[..n], url, &mut enc).unwrap();
            assert!(m == len);
            assert!(&enc[..m] == t);
        }
    }
}
