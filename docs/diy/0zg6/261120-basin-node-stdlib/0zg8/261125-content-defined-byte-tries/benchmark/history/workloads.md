[experiment]: <experiment.md>

# Workload parameters

The *comparison*[~][experiment] uses four-mebibyte files. Generate random bytes with
unsigned xorshift32, initial state `0x13579bdf`, shifts `13, -17, 5`, taking the high
byte after each update. Page runs contain byte `floor(offset / 16384) % 251`; the
uniform file contains zeros. Concatenate UTF-8 JSON records, then truncate to size:

```js
JSON.stringify({
  id: i,
  path: `/home/project/${i % 197}/item-${i}.txt`,
  enabled: !!(i % 3),
  value: `record ${i} with repeated field names and different values`
}) + "\n"
```

Main edit offset is `floor(size / 2) + 37`. Overwrites XOR the existing byte with
255. Inserts use 97 random bytes with seed 12987; deletions remove 97 bytes.
Append 16 KiB from the initial random seed; replace 64 KiB using seed 89123.
Nearby overwrites are 997 bytes apart; dispersed overwrites use
`floor(size * (i + 1) / 10) + 37`, for `i = 0..7`. Move 64 KiB from the quarter to
the three-quarter offset. Apply multi-edits in descending source-offset order.
Each case starts from the original root; prior immutable candidates remain in storage.

The large-edit control substitutes 128 KiB for insert/delete length. The location
sweep uses twelve offsets `floor(size * (sample + 0.37) / 12)`, without timing repeats.
All variants use the same bytes and edits. Storage counts include encoded envelopes
and object integrity, not HTTP overhead. Bandwidth-limited GETs wait 25 ms, then
join one shared 20 MiB/s transfer queue; at most four requests are active.
