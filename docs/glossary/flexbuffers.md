[flexbuffers-format]: <https://flatbuffers.dev/flexbuffers/>
[json0]: <json0.md>

# FlexBuffers

A *schemaless binary format*[^][flexbuffers-format] supporting vectors, maps,
and binary blobs.

Reserve `VT_VECTOR_UINT` for extensions: its first element is one ASCII prefix
byte, followed by the payload below. Ordinary unsigned arrays use other vector
types; binary data uses `VT_BLOB`.

Note that length of a `VT_VECTOR_UINT` can widen every element: byte-valued elements
need at least two bytes each at 256 total elements, or four at 65,536, counting
the tag (in contrast to `VT_BLOB`, which keeps payload bytes packed as its length grows).

| Prefix | Payload |
| --- | --- |
| `x` | Nonnegative bigint magnitude, big-endian bytes |
| `~` | Magnitude of `~n` for negative bigint `n`, big-endian bytes |
| `#` | UTF-8 well-known symbol name |
| `$` | UTF-8 global symbol name |

Magnitudes are minimal, with zero represented by one zero byte. Symbol names
follow *JSON0*[^][json0].
