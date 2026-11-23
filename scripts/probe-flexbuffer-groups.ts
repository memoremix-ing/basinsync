import assert from "node:assert/strict";
import { encode, toReference } from "../clients/flexbuffer";
const results = [];
for (const n of [63, 255, 256]) {
  const zeros = encode(Array(n).fill(0)),
    z = toReference(zeros);
  const keys = Array.from({ length: n }, (_, i) =>
    new TextEncoder().encode(i.toString(16).padStart(2, "0")),
  );
  const bytes = encode({
      keys,
      values: Array.from({ length: n }, (_, i) => 100000 + i),
    }),
    r = toReference(bytes);
  const row = {
    entries: n,
    zero_vector: { encoded_bytes: zeros.length, width: (z as any).byteWidth },
    trie_group: {
      encoded_bytes: bytes.length,
      keys_width: (r.get("keys") as any).byteWidth,
      values_width: (r.get("values") as any).byteWidth,
    },
  };
  assert.equal(z.length(), n);
  assert.equal(r.get("keys").length(), n);
  results.push(row);
}
console.log(JSON.stringify(results, null, 2));
