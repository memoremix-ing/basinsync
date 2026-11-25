[cddl]: <https://www.rfc-editor.org/rfc/rfc8610>
[envbuf]: <glossary/envbuf.md>
[flexbuffers]: <glossary/flexbuffers.md>
[lexidecimal]: <glossary/lexidecimal.md>

# Message schemas

Stored *FlexBuffers*[~][flexbuffers] messages are specified in *CDDL*[~][cddl].
Each message's schema sits beside its prose; together with the definitions
below, every `cddl` block in this documentation forms one schema. Maps are
closed: a key the schema does not name makes a message invalid.

CDDL describes CBOR's data model, which FlexBuffers values map onto directly:

| FlexBuffers | CDDL |
| --- | --- |
| map | map with text keys |
| untyped, typed, or fixed-length vector (except `VT_VECTOR_UINT`) | array |
| string or key | `tstr` |
| `VT_BLOB` | `bstr` |
| integer, unsigned integer, or indirect integer | `int` |
| float or indirect float | `float` |
| boolean, null | `bool`, `null` |
| `VT_VECTOR_UINT` bigint extension `x` / `~` | `#6.2(bstr)` / `#6.3(bstr)`, the extension's big-endian magnitude |
| `VT_VECTOR_UINT` well-known / global symbol | `#6.60000(tstr)` / `#6.60001(tstr)`, the symbol name |

A negative bigint's `~` magnitude is that of `-1 - n`, matching CBOR tag 3.

```cddl
; Shared definitions for stored messages.
big = #6.2(bstr) / #6.3(bstr)
well-known-symbol<name> = #6.60000(name)
global-symbol = #6.60001(tstr)
species = well-known-symbol<"species">
host = "sync.memoremix.com"
command<path, query> = [species, host, path, query]
command-prefix = [species, host, tstr]
decimal = tstr .regexp "0|[1-9][0-9]*"
positive-lexidecimal = tstr .regexp "0z[0-9a-z]+"
hex384 = tstr .regexp "[0-9a-f]{96}"
hex-crc32c = tstr .regexp "[0-9a-f]{8}"
```

Command tuples travel in format `101` *EnvBufs*[~][envbuf]; their `path`
selects the schema (`sts/0/databasin/commitflow` → `commitflow-command`).
Map keys and *Lexidecimal*[~][lexidecimal] positions keep their documented
canonical forms; the patterns above only bound their character sets.
