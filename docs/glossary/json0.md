[diffuse16]: <diffuse16.md>
[lexidecimal]: <lexidecimal.md>

# JSON0

A JSON dialect interpreting value strings of two or more characters beginning
with `0`. Literal strings of that form (i.e. strings already prefixed with `0`)
gain another `0`; object keys are unchanged.

| Prefix | Value |
| --- | --- |
| `00` | Literal string: remove the first `0` |
| `0x` | Nonnegative `bigint`, hexadecimal |
| `0~` | Complement of a hexadecimal `bigint` |
| `0.` | Arbitrary-precision decimal real, supporting an `e` exponent |
| `0*` | `Uint8Array`, base64url; writers omit padding |
| `0%` | `Uint8Array`, standard base64 |
| `0#` | Well-known symbol: `asyncIterator`, `iterator`, `species`, or `unscopables` |
| `0$` | Global symbol name |
| `0w` | Reserved to avoid confusion with *Diffuse16*[^][diffuse16] |
| `0y`, `0z` | Reserved to avoid confusion with *Lexidecimal*[^][lexidecimal] |
| `0[A-Z]` | All uppercase letters reserved to avoid case-insensitive filesystem clashes |
| `0_` | Application-specific extensions/interpretations |

Other `0` prefixes are invalid/reserved. Reject reserved or unsupported encodings;
`0_` interpretations require application agreement. Decode decimal reals without
rounding through binary floating point. Other JSON values retain their usual meaning.

For cross-language interchange, ordinary integer numbers should stay within
`±(2^53 − 1)`; use bigints beyond that. Byte strings preserve bytes, not a typed
array's element type or endianness. Use unique object keys and Unicode scalar
text. JSON0 is not (yet) a canonical serialization nor are all encodings safe for
use in filesystem paths; the uppercase reservation protects prefixes, not
case-sensitive payloads such as `0*AA` and `0*aA`.
