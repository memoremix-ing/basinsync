import { test, expect } from "bun:test";
import { Basin, MemoryStorage, type Edge, type Storage } from "./structures/core";
import { Trie, plain } from "./structures/trie";
import { vectors } from "./vectors";
const cases = vectors<{
  scenarios: {
    name: string;
    capacity: number;
    extraBytes: number;
    steps: [action: string, node: number, reads: number, hit?: boolean][];
  }[];
}>("cache");
async function roots(count = 3) {
  const storage = new MemoryStorage();
  const writer = new Basin(storage, { seed: new Uint8Array(32).fill(42) });
  const edges: Edge[] = [];
  for (let i = 0; i < count; i++)
    edges.push((await Trie.build(writer, [[new Uint8Array([0]), new Uint8Array(32).fill(i)]], plain)).root);
  return { storage, edges };
}
test("shared LRU traces cover hit/peek recency, budgets, clear and rejected descriptors", async () => {
  for (const scenario of cases.scenarios)
    for (let rotate = 0; rotate < 3; rotate++) {
      const { storage, edges } = await roots(), length = edges[0][6].length;
      const b = new Basin(storage, { cacheBytes: scenario.capacity * length + scenario.extraBytes });
      for (const [op, index, reads, present] of scenario.steps) {
        const edge = edges[(index + rotate) % 3];
        if (op === "load")
          await b.load(edge);
        else if (op === "peek")
          expect(b.peek(edge) !== undefined).toBe(present!);
        else if (op === "clear")
          b.clearCache();
        else if (op === "badLength") {
          const bad = [...edge] as Edge;
          bad[6] = { ...edge[6], length: edge[6].length + 1 };
          await expect(b.load(bad)).rejects.toThrow();
        }
        expect(storage.reads).toBe(reads);
      }
    }
});
test("the count cap evicts cold nodes while ready peeks protect a hot node", async () => {
  const { storage, edges } = await roots(129), b = new Basin(storage);
  await b.load(edges[0]);
  for (const edge of edges.slice(1)) {
    await b.load(edge);
    expect(b.peek(edges[0])).toBeDefined();
  }
  expect(b.peek(edges[1])).toBeUndefined();
  expect(storage.reads).toBe(129);
});
test("pending hits coalesce, refresh recency, and cannot resurrect cleared or evicted nodes", async () => {
  const { storage, edges } = await roots();
  let gates: Array<ReturnType<typeof Promise.withResolvers<Uint8Array>>> = [];
  const gated: Storage = {
    put: (...args) => storage.put(...args),
    get: edge => {
      if (edge === edges[0]) {
        const gate = Promise.withResolvers<Uint8Array>();
        gates.push(gate);
        return gate.promise;
      }
      return storage.get(edge);
    },
  };
  const b = new Basin(gated, { cacheBytes: edges[0][6].length * 2 });
  const first = b.load(edges[0]);
  await b.load(edges[1]);
  const joined = b.load(edges[0]);
  expect(gates.length).toBe(1);
  await b.load(edges[2]);
  gates[0].resolve(await storage.get(edges[0]));
  await Promise.all([first, joined]);
  expect(b.peek(edges[0])).toBeDefined();
  expect(b.peek(edges[1])).toBeUndefined();
  b.clearCache();
  gates = [];
  const stale = b.load(edges[0]);
  const staleCheck = stale.then(() => undefined, error => error);
  b.clearCache();
  const fresh = b.load(edges[0]);
  expect(gates.length).toBe(2);
  gates[0].reject(Error("old request failed"));
  expect(await staleCheck).toBeInstanceOf(Error);
  gates[1].resolve(await storage.get(edges[0]));
  await fresh;
  expect(b.peek(edges[0])).toBeDefined();
  b.clearCache();
  gates = [];
  const evicted = b.load(edges[0]);
  await b.load(edges[1]);
  await b.load(edges[2]);
  gates[0].resolve(await storage.get(edges[0]));
  await evicted;
  expect(b.peek(edges[0])).toBeUndefined();
  expect(b.peek(edges[1])).toBeDefined();
  expect(b.peek(edges[2])).toBeDefined();
});

test("rejected pending descriptors do not promote a coalesced request", async () => {
  for (const field of ["length", "header", "query", "summary"] as const) {
    const { storage, edges } = await roots();
    const gate = Promise.withResolvers<Uint8Array>();
    const gated: Storage = {
      put: (...args) => storage.put(...args),
      get: edge => edge === edges[0] ? gate.promise : storage.get(edge),
    };
    const b = new Basin(gated, { cacheBytes: edges[0][6].length * 2 });
    const first = b.load(edges[0]);
    await b.load(edges[1]);
    const bad = [...edges[0]] as Edge;
    bad[6] = { ...bad[6] };
    if (field === "length") bad[6].length++;
    if (field === "header") bad[5] = { ...(bad[5] as Record<string, unknown>), prefix: new Uint8Array([99]) };
    if (field === "query") bad[3] = { ...bad[3], degree: 1 };
    if (field === "summary") bad[6][1] = "different summary";
    const rejected = b.load(bad).then(() => false, () => true);
    await b.load(edges[2]);
    gate.resolve(await storage.get(edges[0]));
    await first;
    expect(await rejected).toBe(true);
    expect(b.peek(edges[0])).toBeUndefined();
    expect(b.peek(edges[1])).toBeDefined();
    expect(b.peek(edges[2])).toBeDefined();
  }
});

test("pending descriptors own their metadata instead of borrowing the initiating edge", async () => {
  const { storage, edges } = await roots();
  const gate = Promise.withResolvers<Uint8Array>();
  let reads = 0;
  const b = new Basin({
    put: (...args) => storage.put(...args),
    get: () => { reads++; return gate.promise; },
  });
  const request = [...edges[0]] as Edge;
  request[3] = { ...request[3] };
  const first = b.load(request).then(() => false, () => true);
  request[3].degree = 99;
  const valid = b.load(edges[0]);
  gate.resolve(await storage.get(edges[0]));
  await valid;
  expect(await first).toBe(true);
  expect(reads).toBe(1);
  expect(b.peek(edges[0])).toBeDefined();
});
