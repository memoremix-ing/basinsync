# JSON0

A JSON dialect interpreting value strings of two or more characters beginning
with `0`. Literal strings of that form (i.e. strings already prefixed with `0`)
gain another `0`; object keys are unchanged.

| Prefix | Value |
| --- | --- |
| `0x` | Nonnegative `bigint`, hexadecimal |
| `0~` | Complement of a hexadecimal `bigint` |
| `0*` | `Uint8Array`, base64url; writers omit padding |
| `0%` | `Uint8Array`, standard base64 |
| `0#` | Well-known symbol name, excluding `dispose` and `asyncDispose` |
| `0$` | Global symbol name |

Other `0` prefixes are invalid/reserved. Other JSON values retain their usual meaning.
