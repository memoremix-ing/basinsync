[milestone]: <milestone.md>
[twos-complement]: <twos-complement.md>

# Diffuse16

A bucket-safe, filesystem-friendly, little-endian radix-16 integer encoding.
Reverse the nibbles of minimal lowercase hexadecimal, prefix `0w`, and suffix `z`.
For negatives, take minimal `hex(~n)`, complement each nibble, reverse, and suffix
`y` instead. This uses the *two's-complement*[^][twos-complement] representation.

Examples: `0 → 0w0z`, `16 → 0w01z`, `27 → 0wb1z`, `-1 → 0wfy`, `-16 → 0w0y`.
Decode by reversing these operations. Sequential values scatter rather than
follow lexicographic order, avoiding hot key ranges. *Milestones*[^][milestone] use
only the positive encodings.
