# Codec kit

Kit v2, from codec-only clean room `261123-claude-codec1` (workspace commit
`b4213a2`, docs from basinsync `073c6c5`): its `crates/codec`, `crates/oracle`,
and `scripts/kani-all.sh`. Its Kani bounds are much stronger than kit v1's
(full `i64`/`i128` round trips; 10–40-byte inputs), and all its harnesses
completed. See `crates/codec/KANI.md`.

Changed on import:

- **FlexBuffers layout rule** (docs round 5, after the room started): the
  extension decoder bounds elements by the root slot, and `layout.rs`
  checks whole documents for servers that parse them with a general
  FlexBuffers library (this crate decodes only extensions).
- **SHA-384** comes from the `sha2` crate instead of the room's own
  implementation; its `sha384_abc_and_no_panic` harness was dropped.
- **JSON0**: `json0.encode` and `json0.decode` oracle operations; the
  leading-`0` rule now runs through an allocation-free core
  (`literal_offset`, `literal_needs_zero`) that the `json0_literal_round_trip`
  harness proves.
- **Fixed-length unsigned vectors** (`VT_VECTOR_UINT2`–`4`) are rejected as
  extensions, per docs round 7; the room had accepted them.

Kit v1 (r3's codecs) is in git history. Refresh the kit from a codec-only
clean room with `scripts/cleanroom/kit-import.sh`.
