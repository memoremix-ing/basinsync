[implementation]: <https://github.com/zed-industries/bromberg_sl2>
[sha384]: <sha384.md>

# BrombergSL2

A composable *matrix checksum*[~][implementation] in SL₂ over the prime field
`2^127 − 1`, using generators A(2)/B(2). Encode four row-major field elements as
16-byte big-endian integers. Concatenation corresponds to matrix multiplication;
empty input gives the identity. Stored objects use *SHA-384*[~][sha384] for integrity.
