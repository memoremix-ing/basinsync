[catalogue]: <https://docs.rs/crc-catalog/2.5.0/crc_catalog/algorithm/constant.CRC_64_NVME.html>
[implementation]: <https://docs.rs/crc-fast/1.10.0/crc_fast/>
[sha384]: <sha384.md>

# CRC64NVME

The *CRC-64/NVME checksum*[~][catalogue]: reflected polynomial
`0x9a6c9329ac4bc9b5`, all-one initialization and final XOR. The checksum of
`123456789` is `ae8b14860a799888`; empty input gives zero.

Checksums of consecutive byte ranges compose using their lengths; prepared
zero-byte shift operators avoid repeating the same polynomial calculations.
A *native implementation*[~][implementation] accelerates byte hashing.
This checksum does not replace stored-object *SHA-384*[~][sha384] integrity checks.
