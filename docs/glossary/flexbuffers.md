[flexbuffers-format]: <https://flatbuffers.dev/flexbuffers/>
[json0]: <json0.md>

# FlexBuffers

A *schemaless binary format*[~][flexbuffers-format] supporting vectors, maps,
and binary blobs.

Reserve `VT_VECTOR_UINT` for extensions: its first element is one ASCII prefix
byte, followed by the payload below. Ordinary unsigned arrays use other vector
types; binary data uses `VT_BLOB`. Fixed-length unsigned vectors
(`VT_VECTOR_UINT2`–`4`) are never extensions; some builders emit them for two
to four elements, so writers must produce a length-prefixed `VT_VECTOR_UINT`.

Note that length of a `VT_VECTOR_UINT` can widen every element: byte-valued elements
need at least two bytes each at 256 total elements, or four at 65,536, counting
the tag (in contrast to `VT_BLOB`, which keeps payload bytes packed as its length grows).

| Prefix | Payload |
| --- | --- |
| `x` | Nonnegative bigint magnitude, big-endian bytes |
| `~` | Magnitude of `~n` for negative bigint `n`, big-endian bytes |
| `#` | UTF-8 well-known symbol name |
| `$` | UTF-8 global symbol name |

Magnitudes are minimal, with zero represented by one zero byte; readers reject
empty or zero-led magnitudes, since layout freedom covers bytes, not values.
Symbol names are bare (`species`, not `Symbol.species`); global names may be
empty. Symbol names
follow *JSON0*[~][json0].

Writers may choose different widths, ordering, sharing, and unreferenced
padding for the same value. Every value an offset refers to, including its
length prefix or map header, must end at or before the slot holding that
offset, so offsets point backward and no value overlaps a slot that refers to
it or the root trailer (root value, type byte, width byte). Empty values may
sit at their slot. Readers reject layouts that break this rule, accept every
other valid layout, and never require a canonical re-encoding; digests cover
the stored bytes. Readers do not require alignment.
