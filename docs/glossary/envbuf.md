[flexbuffers]: <flexbuffers.md>

# EnvBuf

“Enveloped Buffers” (pronounced “Envy Buff”): concatenable binary envelopes
with matching headers and footers for forward and backward traversal.
Prefer `.nv` filenames.

Each header and footer is eight-byte aligned:

```text
header: "enV" | format:3, alignment_power:5 | content_length:u32le
footer: content_length:u32le | format:3, alignment_power:5 | "vNE"
```

The descriptor's high three bits select the format: `000` unknown/raw,
`100` nested EnvBuf, `101` *FlexBuffers*[^][flexbuffers]; others are reserved.
The low five bits encode the alignment as `1 << alignment_power`, defaulting
to eight bytes (`00011`). Pad between content and footer with `0xee`.
Content length excludes padding and framing. The default descriptor for
*FlexBuffers*[^][flexbuffers] is `0xa3`.
