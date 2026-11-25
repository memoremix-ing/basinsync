/** Bounded Myers insert/delete script over already-fetched bytes. */
import type { ByteEdit } from "./byte-diff";
export function localByteDiff(a: Uint8Array, b: Uint8Array, limit = 256): ByteEdit[] | null {
  const offset = limit + 1, v = new Int32Array(2 * limit + 3).fill(-1), trace: Int32Array[] = [];
  v[offset + 1] = 0;
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x < a.length || y < b.length) continue;
      const edits: ByteEdit[] = [];
      for (let step = d; step > 0; step--) {
        const prev = trace[step], diag = x - y;
        const prior = diag === -step || (diag !== step && prev[offset + diag - 1] < prev[offset + diag + 1]) ? diag + 1 : diag - 1;
        const px = prev[offset + prior], py = px - prior, equal = Math.min(x - px, y - py);
        x -= equal; y -= equal;
        if (x === px) edits.push({ before: { start: BigInt(x), length: 0n }, after: { start: BigInt(y - 1), length: 1n } });
        else edits.push({ before: { start: BigInt(x - 1), length: 1n }, after: { start: BigInt(y), length: 0n } });
        x = px; y = py;
      }
      const out: ByteEdit[] = [];
      for (const e of edits.reverse()) {
        const last = out.at(-1);
        if (last && last.before.start + last.before.length === e.before.start && last.after.start + last.after.length === e.after.start) { last.before.length += e.before.length; last.after.length += e.after.length; }
        else out.push(e);
      }
      return out;
    }
  }
  return null;
}
