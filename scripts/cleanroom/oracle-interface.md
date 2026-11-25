# Oracle interface

Provide a command-line program that independent checks can drive. It reads
one JSON request per line on standard input and writes exactly one JSON
response per line on standard output, in order, then exits at end of input.

A response is `{"ok": RESULT}` on success, `{"error": "MESSAGE"}` when the
input is invalid or rejected, or `{"unsupported": true}` for an operation your
build does not implement. Never exit early on bad input.

Integers travel as canonical decimal strings (`-?(0|[1-9][0-9]*)`, never `-0`;
they may exceed 64 bits); bytes travel as arrays of numbers 0–255. Answer a blank
line, a request that is not a JSON object, or a missing or ill-typed field with
an `error`, and an unknown `op` with `{"unsupported": true}`.

| `op` | Request fields | `ok` result |
|---|---|---|
| `lexidecimal.encode` | `value` | encoded text |
| `lexidecimal.decode` | `text` | decimal string |
| `lexidecimal.sizePrefix` | `size` (number: `s`, the payload's hex digit count minus one), `negative` (bool) | the magnitude letter, if any, plus the size digits, without `0z`/`0y` |
| `diffuse16.encode` | `value` | encoded text |
| `diffuse16.decode` | `text` | decimal string |
| `envbuf.encode` | `format`, `alignmentPower` (numbers), `content` (bytes) | envelope bytes |
| `envbuf.decode` | `wire` (bytes: exactly one envelope, nothing after it) | `{"format", "content"}` |
| `flexbuffers.encodeExtension` | exactly one of `bigint`, `wellKnownSymbol`, `globalSymbol` | FlexBuffers bytes in the narrowest layout: length prefix at offset 0 with the elements after it in the narrowest width that holds both, then the root offset in its narrowest width, aligned to it, then the type and width bytes |
| `flexbuffers.decodeExtension` | `wire` (bytes) | object with the one matching field |
| `json0.encode` | exactly one of `text` (string), `bigint`, `bytes`, `wellKnownSymbol`, `globalSymbol` | the JSON0 string value |
| `json0.decode` | `wire` (a JSON0 string value) | object with the one matching field |
| `timeline.key` | `milestone` | object key |
| `timeline.milestone` | `key` | decimal string |
| `flow.normalize` | `id` | canonical Flow ID |
| `keys.prefixes` | none | object naming the longest stem shared by each family's object-key patterns: `timeline`, `basinEpilogue`, `analogue`, `kernelHeap`, `userHeap`, `userFlows` (each ending in `/`), and `emptySentinel` (the full key) |

Name the program in `README.md` and make it buildable with your workspace's
normal build command.
