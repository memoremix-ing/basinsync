# Kani proofs for `basinsync-codec`

Harnesses live in `src/kani_proofs.rs`, compiled only under `cfg(kani)`. They
target the allocation-free cores (`lexidecimal::{parse, encode_hex_into,
encode_i128, decode_i128, write_size_prefix}`, the same for `diffuse16`,
`envbuf::{encode_into, parse_at, parse_ending_at, decode_envelope,
validate_feed}`, `flexbuffers::{parse_root, element, validate, encode_into}`,
`keys::normalize_flow_id_into`, `crc32c::append`, `sha384::digest`, and
`json0::{is_json_number, base64_*_into}`). The allocating public API wraps
these cores.

Environment: Kani 0.68.0, CBMC 6.11.0, Rust 1.99.1. Every harness ran alone
through `scripts/kani-all.sh` with `timeout 900` and `ulimit -v 16000000`
(16 GB). **Time** is wall clock, including compilation. **Peak** is the
maximum RSS reported by `/usr/bin/time`. "Bytes ≤ N" means a symbolic byte
array of length N with a symbolic length 0..=N; every byte value is covered.

## Results (final code; all 23 harnesses PASS, 0 failed checks)

| Harness | Property | Bound | Result | Time | Peak |
| --- | --- | --- | --- | --- | --- |
| `lex_decode_no_panic` | `parse`/`decode_i128` never panic | bytes ≤ 10 | PASS | 8.0 s | 0.30 GB |
| `lex_size_prefix_any_u64` | size prefix for any `u64` and sign: predicted length, correct alphabets | all `u64` × sign | PASS | 4.7 s | 0.32 GB |
| `lex_roundtrip_i64` | `decode(encode(v)) == v` | all `i64` | PASS | 64.9 s | 1.48 GB |
| `lex_roundtrip_i128` | `decode(encode(v)) == v` | all `i128` | PASS | 81.1 s | 1.49 GB |
| `lex_accepted_is_canonical` | any accepted string re-encodes to itself (noncanonical rejected) | bytes ≤ 8 | PASS | 63.7 s | 1.65 GB |
| `lex_parse_reencode_structural` | the same, width-independent: `encode_hex_into(parse(s)) == s` | bytes ≤ 12 | PASS | 14.0 s | 0.35 GB |
| `lex_order_i16` | `cmp(enc(a), enc(b)) == cmp(a, b)` | all `i16` pairs | PASS | 48.8 s | 1.54 GB |
| `d16_decode_no_panic` | `decode_i128` never panics | bytes ≤ 10 | PASS | 4.3 s | 0.27 GB |
| `d16_roundtrip_i128` | `decode(encode(v)) == v` | all `i128` | PASS | 67.1 s | 1.11 GB |
| `d16_accepted_is_canonical` | accepted strings re-encode to themselves | bytes ≤ 10 | PASS | 28.7 s | 1.16 GB |
| `envbuf_decode_no_panic` | framing decode, forward and backward, never panics (any declared length or power) | bytes ≤ 40 | PASS | 15.7 s | 0.39 GB |
| `envbuf_validate_feed_no_panic` | feed validation, including nested feeds, never panics | bytes ≤ 32 | PASS | 288.3 s | 7.49 GB |
| `envbuf_nested_shell` | a nested envelope is accepted iff its 16-byte symbolic inner feed is one valid envelope | 16 symbolic inner bytes | PASS | 382.8 s | 8.51 GB |
| `envbuf_roundtrip` | encode→decode returns format, power and message; length aligned; backward parse agrees | message ≤ 8, power ≤ 4, formats 000/101/110 | PASS | 28.2 s | 0.75 GB |
| `envbuf_accepted_is_canonical` | any accepted envelope equals the encoder's output for its fields (padding, footer, length canonical) | bytes ≤ 32 | PASS | 17.3 s | 0.54 GB |
| `envbuf_counter_margin_any_u64` | the counter margin is 24 bytes and decodes to its counter | all `u64` | PASS | 4.6 s | 0.34 GB |
| `fb_validate_no_panic` | extension validation never panics; accepted bigints have minimal magnitudes | bytes ≤ 10 | PASS | 586.8 s | 9.38 GB |
| `fb_roundtrip` | `x`/`~` minimal magnitudes and ASCII `$` names round-trip through encode/validate | payload ≤ 4 | PASS | 197.4 s | 5.10 GB |
| `flow_normalize` | never panics; accepted ids keep their length, become lowercase, and normalize idempotently | bytes ≤ 8 | PASS | 3.6 s | 0.32 GB |
| `crc32c_table_matches_bitwise` | table CRC equals the bitwise definition for any seed; split/append is associative | bytes ≤ 4, any seed and split | PASS | 54.6 s | 0.36 GB |
| `sha384_abc_and_no_panic` | FIPS "abc" vector (first, second and last bytes); no panic | any 1-byte input | PASS | 45.7 s | 2.43 GB |
| `json0_number_grammar_no_panic` | JSON number grammar check never panics | bytes ≤ 8 | PASS | 2.8 s | 0.26 GB |
| `json0_base64_canonical` | base64/base64url decode never panics; accepted canonical text re-encodes to itself | text ≤ 8, either alphabet | PASS | 15.2 s | 0.35 GB |

The property tests in `cargo test` extend these bounds (arbitrary-precision
values, long inputs), and cross-check against the `sha2`, `crc32c` and
`flexbuffers` crates.

## What Kani found

No property violations were found: every failing run came from resource
limits. Those runs exposed shapes in the code that CBMC handles badly, and
the fixes changed production code:

1. **Recursive nested-feed validation exhausted memory.** In the first run,
   `envbuf_decode_no_panic` (bytes ≤ 40), `envbuf_validate_feed_no_panic`
   (bytes ≤ 32) and `envbuf_roundtrip` were all killed at about 15.9 GB. CBMC
   unwinds recursion to the harness's unwind bound, and each level inlines
   the padding loop. It even encoded the nested branch in `envbuf_roundtrip`,
   where the format was constrained to be non-nested. **Fix:**
   `validate_feed` is now iterative, with a fixed `[usize; 33]` stack
   (`MAX_NESTING = 32`, same limit and semantics), and `decode_envelope` is
   exposed as the framing-only core that `decode_one` wraps.
2. **Symbolic division in `envelope_len`.** `ceil(x / 2^p) * 2^p` with
   symbolic `p` produced a 64-bit divider circuit. Even after (1),
   `envbuf_decode_no_panic` still ran out of memory (14.9 GB). **Fix:**
   rounding up by a mask, `(x + 2^p − 1) & !(2^p − 1)`. The harness then
   passed in 15.7 s with 0.39 GB.
3. **Symbolic division and multiplication by the FlexBuffers element
   width.** At bytes ≤ 12, `fb_validate_no_panic` passed once in 803 s with
   13.9 GB, too close to both caps. Replacing `/ width` and `* width` with
   shifts by `width_code` cut `fb_roundtrip` from 6.6 to 5.1 GB. The 12-byte
   validation run then exceeded the 900 s timeout, so the **bound was reduced
   to 10 bytes** (587 s, 9.4 GB).
4. **Allocation in base64.** The original `json0_base64url_canonical`
   harness, which went through `Vec`/`String`, timed out at 900 s with only
   6 symbolic bytes. **Fix:** allocation-free `base64_encode_into` /
   `base64_decode_into` cores, which the public API now wraps. The new
   harness covers both alphabets at 8 bytes in 15 s.
5. **Script classification.** After running out of memory CBMC prints
   `VERIFICATION:- FAILED`, so the first version of `kani-all.sh` reported
   those runs as FAIL. The script now checks for out-of-memory first.

## Bounds settled on, and why

- Lexidecimal/Diffuse16 round trips cover the whole `i128` domain. The
  arbitrary-precision API shares `parse`/`encode_hex_into` with the `i128`
  path, so `lex_parse_reencode_structural` proves canonicity for any width
  up to a 12-byte string.
- EnvBuf: 40 bytes covers headers that declare every length and power. 32
  bytes is the smallest feed that can hold one nested envelope with one
  inner envelope.
- FlexBuffers: 10 bytes covers 1-, 2- and 4-byte element widths with short
  payloads and every root width that fits. Wider layouts are covered by
  property tests and the reference-crate interop tests.
- SHA-384: a symbolic 1-byte input exercises the full compression function
  (80 rounds) under CBMC; longer symbolic inputs only repeat it.

## Changes on import into the codec kit

Re-verified after the kit v2 patches (Kani 0.68, 16 GB limit):

| Harness | Change | Result |
| --- | --- | --- |
| `fb_validate_no_panic` | the extension decoder bounds elements by the root slot and rejects fixed-length vectors | PASS, 464 s |
| `fb_roundtrip` | same | PASS, 287 s |
| `json0_literal_round_trip` | new: proves the allocation-free leading-`0` core (`literal_offset`, `literal_needs_zero`), strings up to 4 bytes | PASS, 3 s |
| `sha384_abc_and_no_panic` | removed: SHA-384 now comes from the `sha2` crate | — |
