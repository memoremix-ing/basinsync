[milestone]: <milestone.md>
[twos-complement]: <twos-complement.md>
[viewpoint]: <viewpoint.md>

# Lexidecimal

A doubly size-prefixed, big-endian radix-16 text encoding of integers.
Lexicographic order follows numeric order, from lowest negative to highest positive.

Retain sign prefixes `0z` for nonnegative integers and `0y` for negatives.
For `n < 0`, encode `~n` and complement its hexadecimal payload digits.

```text
h = minimal lowercase hex(n < 0 ? ~n : n)   // zero is "0"
s = hex(length(h) - 1)
width = smallest of 1, 2, 4, 8, 16 that can hold s
s = left-pad s with zeroes to width
```

Encode size digits `0..f` as anti-hex `g..v` on the positive side,
or `v..g` on the negative side. Size is always present. Omit magnitude when
`width == 1`; otherwise prefix the size with magnitude `m`, where
`1 << (1 + m) == width`. Magnitudes `0..3` use `wxyz` for positives and
`ZYXW` for negatives, in that order (`m = 0` is `w` or `Z`), so wider
negatives sort first. Append `h`, complementing its digits for negatives:
2^64 is `0zwhg10000000000000000` and −2^64 − 1 is `0yZuveffffffffffffffff`.

Decode the optional magnitude, fixed-width size, then hexadecimal payload.
Require minimal uncomplemented payload digits and the smallest permitted size width;
canonical spellings reproduce themselves when re-encoded.

Examples: `0 → 0zg0`, `16 → 0zh10`, `-1 → 0yvf`, `-17 → 0yuef`.
`2^64 → 0zwhg10000000000000000`; a size of `0x100` uses `xghgg`.

Encoding *complemented*[~][twos-complement] *Viewpoints*[~][viewpoint] or
*Milestones*[~][milestone] reverses sequence order, so the minimum published
object key identifies the latest position.
