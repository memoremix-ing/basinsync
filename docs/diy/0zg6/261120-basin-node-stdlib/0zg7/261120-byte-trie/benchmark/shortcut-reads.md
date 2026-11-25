[diy/0zg6/261120-basin-node-stdlib/0zg7/261120-byte-trie]: <../README.md>
[node]: <../../../../../../glossary/node.md>
[page-spines]: <page-spines.md>
[shortcut-reads]: <shortcut-reads.json>
[weak-link]: <../../../../../../glossary/weak-link.md>

# Shortcut request traces

Historical measurements of the prior device/leaf-index layout; see the current
*page-spine measurements*[~][page-spines].

Bun 1.4.5; fresh read cache for each case, one-byte sparse pages, and an in-memory
resolver doing no I/O. These are request/byte counts, not network timing or
realistic file-transfer benchmarks. All reads were checked; repeating the same
read with a warm cache required zero object GETs. *Raw traces and source
fingerprints*[~][shortcut-reads]. Reproduce with `bun tests/clients/volume-shortcut-trace.ts`.

| Fixture / selected index | Direct GETs | Shortcut GETs |
| --- | ---: | ---: |
| 20,000 pages / 0, 10,000, 19,999 | 2, 3, 3 | 2, 3, 3 |
| 350,000 pages / 0, 175,000, 349,999 | 2, 3, 3 | 6, 6, 7 |
| 5,000 files / 0, 2,500, 4,999 | 3, 3, 2 | 2, 2, 2 |

The large leaf-shortcut vector adds three or four vector-object GETs during binary
search. The direct sector trie needs at most one descendant GET in these fixtures;
its first page is inline. Logical branching factors alone do not predict physical
*basin-node*[~][node] fetch depth: compression and packing dominate.

File *weak links*[~][weak-link] bypass the device trie and save one GET where its
path crosses an object boundary. Their resolver was free here; an additional
resolver round trip can change the result. The inline directory alone makes the
5,000-file read transfer about 1 MiB, so those saved requests do not solve directory
scaling.

Recommendation: prefer direct sector traversal for point reads until the leaf
index demonstrates a request advantage. The vector remains a bounded representation
for ordered shortcuts; per-child page-range summaries could support one-path
predecessor searches instead of repeated binary-search probes. Existing boundary
stacks are not used by point reads. File links remain useful adjacent hints for
selective opens; complete-volume recovery need not benefit similarly. Measure
spilled directory tries separately before choosing their inline budget.
