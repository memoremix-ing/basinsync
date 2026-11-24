import { test, expect } from "bun:test";
import { TrieEditor, plain } from "./structures/trie";
import { Basin, MemoryStorage, utf8 } from "./structures/core";
import { produceTrie, type TrieDraft } from "./structures/cow";
import {
  produceTrieProxy,
  ReadonlyCowBytes,
  type ProxyTrieDraft,
} from "./structures/cow-proxy";
import { cowMetrics } from "./structures/cow-values";
const base = (
  value: any = {
    meta: { n: 1 },
    items: [{ n: 2 }, 3],
    bytes: new Uint8Array([1, 2]),
  },
) =>
  TrieEditor.from(
    new Basin(new MemoryStorage()),
    [[utf8("file"), value]],
    plain,
  );
const opts = { keyEncoding: "utf8" as const };
test("explicit and Proxy scopes preserve snapshots, escaped drafts and assigned values", async () => {
  const initial = base(),
    input = { meta: { n: 9 }, items: [4], bytes: new Uint8Array([5]) };
  let explicit: any, proxy: any, bytes: ReadonlyCowBytes | undefined;
  const a = await produceTrie(
    initial,
    (d) => {
      explicit = d.edit("file");
      explicit.meta.n++;
      explicit.items.push(5);
      explicit.bytes[0] = 7;
      d.set("second", input);
    },
    opts,
  );
  const b = await produceTrieProxy(
    initial,
    (d) => {
      proxy = d.file;
      d.file.meta.n++;
      d.file.items.push(5);
      bytes = d.file.bytes;
      d.file.bytes = new Uint8Array([7, 2]) as any;
      d.second = input as any;
    },
    opts,
  );
  expect(a.get(utf8("file"))).toEqual(b.get(utf8("file")));
  expect((initial.get(utf8("file")) as any).meta.n).toBe(1);
  explicit.meta.n = 88;
  explicit.bytes[0] = 88;
  input.meta.n = 88;
  input.bytes[0] = 88;
  expect((a.get(utf8("file")) as any).meta.n).toBe(2);
  expect((b.get(utf8("second")) as any).meta.n).toBe(9);
  expect(() => proxy.meta.n).toThrow(/closed|revoked/);
  expect(() => bytes!.at(0)).toThrow(/closed|revoked/);
  let scope: TrieDraft<any, null> | undefined;
  produceTrie(
    initial,
    (d) => {
      scope = d;
    },
    opts,
  );
  expect(() => scope!.set("x", 0)).toThrow(/closed|revoked/);
});
test("no-op and aborted recipes preserve identity and support async scopes", async () => {
  const initial = base();
  expect(
    produceTrie(
      initial,
      (d) => {
        d.edit("file");
      },
      opts,
    ),
  ).toBe(initial);
  expect(
    produceTrieProxy(
      initial,
      (d) => {
        const n = d.file.meta.n;
        expect(n).toBe(1);
      },
      opts,
    ),
  ).toBe(initial);
  for (const proxy of [false, true]) {
    let escaped: any;
    expect(() =>
      proxy
        ? produceTrieProxy(
            initial,
            (d) => {
              escaped = d;
              d.file.meta.n = 3;
              throw Error("abort");
            },
            opts,
          )
        : produceTrie(
            initial,
            (d) => {
              escaped = d;
              d.edit("file").meta.n = 3;
              throw Error("abort");
            },
            opts,
          ),
    ).toThrow("abort");
    expect((initial.get(utf8("file")) as any).meta.n).toBe(1);
    if (proxy) expect(() => escaped.file).toThrow(/closed|revoked/);
    else expect(() => escaped.get("file")).toThrow(/closed|revoked/);
  }
  const a = await produceTrieProxy(
    initial,
    async (d) => {
      await Promise.resolve();
      d.file.meta.n = 8;
    },
    opts,
  );
  expect((a.get(utf8("file")) as any).meta.n).toBe(8);
  await expect(
    produceTrie(
      initial,
      async (d) => {
        d.edit("file").meta.n = 4;
        await Promise.resolve();
        throw Error("async abort");
      },
      opts,
    ) as Promise<any>,
  ).rejects.toThrow("async abort");
});
test("Proxy descriptors, array operations, atomic bytes and draft assignment cannot leak writable internals", () => {
  const initial = base();
  let desc: any, child: any;
  const next = produceTrieProxy(
    initial,
    (d) => {
      expect(Object.keys(d)).toEqual(["file"]);
      expect(Object.keys(d.file)).toEqual(["meta", "items", "bytes"]);
      desc = Object.getOwnPropertyDescriptor(d.file, "meta")!.value;
      desc.n = 4;
      child = d.file.meta;
      d.file.meta = { n: 5 };
      child.n = 99;
      d.file.items.splice(0, 1, { n: 8 });
      d.file.items.push(12);
      expect(Array.isArray(d.file.items)).toBe(true);
      d.copy = d.file;
      d.file.meta.n = 6;
      expect(d.file.bytes.at(0)).toBe(1);
      const owned = d.file.bytes.slice();
      owned[0] = 99;
      expect(d.file.bytes.at(0)).toBe(1);
      expect(() => {
        (d.file.bytes as any)[0] = 99;
      }).toThrow();
    },
    opts,
  ) as TrieEditor<any, null>;
  expect((next.get(utf8("file")) as any).meta.n).toBe(6);
  expect((next.get(utf8("copy")) as any).meta.n).toBe(5);
  expect(() => desc.n).toThrow(/closed|revoked/);
  expect((initial.get(utf8("file")) as any).items).toEqual([{ n: 2 }, 3]);
});
test("COW map keys avoid prototype/method collisions and unsupported mutations abort", () => {
  const b = base(1);
  const next = produceTrieProxy(
    b,
    (d) => {
      d.__proto__ = 2;
      d.constructor = 3;
      d.then = 4;
      delete d.file;
      expect("then" in d).toBe(true);
      expect(Object.keys(d).sort()).toEqual([
        "__proto__",
        "constructor",
        "then",
      ]);
    },
    opts,
  ) as TrieEditor<any, null>;
  expect(next.get(utf8("__proto__"))).toBe(2);
  expect(next.get(utf8("constructor"))).toBe(3);
  expect(next.get(utf8("then"))).toBe(4);
  expect(() =>
    produceTrieProxy(
      base(),
      (d) => {
        Object.defineProperty(d.file, "x", { value: 1 });
      },
      opts,
    ),
  ).toThrow("defineProperty");
  expect(() =>
    produceTrieProxy(
      base(),
      (d) => {
        delete d.file.items[0];
      },
      opts,
    ),
  ).toThrow("dense");
  const getter = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      throw Error("should not execute");
    },
  });
  expect(() =>
    produceTrie(
      base(),
      (d) => {
        d.set("x", getter);
      },
      opts,
    ),
  ).toThrow("accessor");
  const cycle: any = {};
  cycle.x = cycle;
  expect(() =>
    produceTrie(
      base(),
      (d) => {
        d.set("x", cycle);
      },
      opts,
    ),
  ).toThrow("cyclic");
  expect(() =>
    produceTrieProxy(
      base(),
      (d) => {
        d.file = new Map() as any;
      },
      opts,
    ),
  ).toThrow("plain");
});
test("separate instrumentation verifies deep-copy versus path-copy costs", () => {
  const initial = base(),
    explicit = cowMetrics(),
    proxy = cowMetrics();
  produceTrie(
    initial,
    (d) => {
      d.edit("file").meta.n++;
    },
    { ...opts, metrics: explicit },
  );
  produceTrieProxy(
    initial,
    (d) => {
      d.file.meta.n++;
    },
    { ...opts, metrics: proxy },
  );
  expect(explicit.copiedBytes).toBe(4);
  expect(proxy.copiedBytes).toBe(0);
  expect(proxy.proxies).toBeGreaterThan(0);
  expect(proxy.clonedObjects).toBeLessThan(explicit.clonedObjects);
});

test("explicit path copies match Proxy updates without copying untouched bytes", () => {
  const initial = base(),
    aMetrics = cowMetrics(),
    bMetrics = cowMetrics();
  const a = produceTrie(
    initial,
    (d) => {
      d.updateIn("file", ["meta", "n"], (n) => Number(n) + 1);
    },
    { ...opts, metrics: aMetrics },
  ) as TrieEditor<any, null>;
  const b = produceTrieProxy(
    initial,
    (d) => {
      d.file.meta.n++;
    },
    { ...opts, metrics: bMetrics },
  ) as TrieEditor<any, null>;
  expect(a.get(utf8("file"))).toEqual(b.get(utf8("file")));
  expect(aMetrics.copiedBytes).toBe(0);
  expect(bMetrics.copiedBytes).toBe(0);
  expect(aMetrics.clonedObjects).toBe(bMetrics.clonedObjects);
  expect(() =>
    produceTrie(
      initial,
      (d) => {
        d.updateIn("file", ["bytes", 0], () => 7);
      },
      opts,
    ),
  ).toThrow("atomically");
  expect(() =>
    produceTrie(
      initial,
      (d) => {
        d.set("\ud800", 1);
      },
      opts,
    ),
  ).toThrow("UTF-8");
});
test("Proxy prefix operations, default hex introspection and concurrent async recipes", async () => {
  const initial = base(),
    subtree = initial.subtree(utf8("file"));
  const next = produceTrieProxy(
    initial,
    (d, ops) => {
      d.file.meta.n = 7;
      ops.graftPrefix("copy", subtree);
      ops.deletePrefix("file");
    },
    opts,
  ) as TrieEditor<any, null>;
  expect(next.has(utf8("file"))).toBe(false);
  expect((next.get(utf8("copy")) as any).meta.n).toBe(1);
  const hexBase = TrieEditor.from(initial.basin, [["aa", 1]], plain);
  produceTrieProxy(hexBase, (d) => {
    expect(JSON.stringify(d)).toBe('{"aa":1}');
  });
  const [a, b] = await Promise.all([
    produceTrieProxy(
      initial,
      async (d) => {
        d.file.meta.n = 4;
        await Promise.resolve();
      },
      opts,
    ),
    produceTrie(
      initial,
      async (d) => {
        d.edit("file").meta.n = 5;
        await Promise.resolve();
      },
      opts,
    ),
  ]);
  expect((a.get(utf8("file")) as any).meta.n).toBe(4);
  expect((b.get(utf8("file")) as any).meta.n).toBe(5);
  expect((initial.get(utf8("file")) as any).meta.n).toBe(1);
});

test("held value drafts survive enumeration and unrelated prefix edits", () => {
  const initial = base();
  const a = produceTrie(
    initial,
    (d) => {
      const held = d.edit("file");
      d.deletePrefix("missing");
      held.meta.n = 8;
    },
    opts,
  ) as TrieEditor<any, null>;
  const b = produceTrieProxy(
    initial,
    (d, ops) => {
      const held = d.file;
      Object.keys(d);
      ops.deletePrefix("missing");
      held.meta.n = 8;
    },
    opts,
  ) as TrieEditor<any, null>;
  expect((a.get(utf8("file")) as any).meta.n).toBe(8);
  expect(a.get(utf8("file"))).toEqual(b.get(utf8("file")));
});

test("COW exports preserve symbols, bytes, snapshots and canonical serialization", async () => {
  const initial = base({
    protocol: Symbol.species,
    meta: { n: 1 },
    bytes: new Uint8Array([1, 2]),
  });
  const a = produceTrie(
    initial,
    (d) => {
      d.updateIn("file", ["meta", "n"], () => 3);
    },
    opts,
  ) as TrieEditor<any, null>;
  const b = produceTrieProxy(
    initial,
    (d) => {
      d.file.meta.n = 3;
    },
    opts,
  ) as TrieEditor<any, null>;
  const storedA = await a.store(),
    storedB = await b.store();
  expect(storedA.root[6].sha384).toEqual(storedB.root[6].sha384);
  expect(((await storedB.get(utf8("file"))) as any).protocol).toBe(
    Symbol.species,
  );
  expect((initial.get(utf8("file")) as any).meta.n).toBe(1);
});

test("typed Proxy drafts accept byte replacement while exposing read-only byte access", () => {
  const initial = TrieEditor.from(
    new Basin(new MemoryStorage()),
    [[utf8("entry"), { meta: { n: 1 }, bytes: new Uint8Array([1]) }]],
    plain,
  );
  const result = produceTrieProxy(
    initial,
    (d) => {
      d.entry.meta.n++;
      d.entry.bytes = new Uint8Array([8]);
      expect(d.entry.bytes.at(0)).toBe(8);
    },
    opts,
  );
  expect(result).toBeInstanceOf(TrieEditor);
});

test("scoped COW return types preserve synchronous and async completion", async () => {
  const initial = base();
  const ready: TrieEditor<any, null> = produceTrie(
    initial,
    (d) => {
      d.updateIn("file", ["meta", "n"], () => 2);
    },
    opts,
  );
  const proxyReady: TrieEditor<any, null> = produceTrieProxy(
    initial,
    (d) => {
      d.file.meta.n = 2;
    },
    opts,
  );
  const delayed: Promise<TrieEditor<any, null>> = produceTrieProxy(
    initial,
    async (d) => {
      await Promise.resolve();
      d.file.meta.n = 3;
      return 7;
    },
    opts,
  );
  expect((ready.get(utf8("file")) as any).meta.n).toBe(2);
  expect((proxyReady.get(utf8("file")) as any).meta.n).toBe(2);
  expect(((await delayed).get(utf8("file")) as any).meta.n).toBe(3);
});

test("hex Proxy keys share the explicit API's case-insensitive codec", () => {
  const initial = TrieEditor.from(
    new Basin(new MemoryStorage()),
    [["ab", 1]],
    plain,
  );
  const next = produceTrieProxy(initial, (d) => {
    d.AB = 2;
    expect(d.ab).toBe(2);
    expect(d.AB).toBe(2);
    expect("AB" in d).toBe(true);
    expect(Object.keys(d)).toEqual(["ab"]);
  });
  expect(next.get("ab")).toBe(2);
});

test("Buffer-backed keys, assignments and byte views copy instead of aliasing", () => {
  const b = new Basin(new MemoryStorage()),
    k = Buffer.from("key"),
    input = Buffer.from([1, 2]);
  const initial = TrieEditor.from(
    b,
    [[k, { bytes: input, meta: { n: 1 } }]],
    plain,
  );
  k.fill(0);
  expect(initial.has(utf8("key"))).toBe(true);
  const a = produceTrie(
    initial,
    (d) => {
      d.edit("key").bytes[0] = 9;
    },
    opts,
  );
  expect(input[0]).toBe(1);
  const assigned = Buffer.from([4, 5]);
  const c = produceTrie(
    initial,
    (d) => {
      d.set("new", { bytes: assigned, meta: { n: 2 } });
    },
    opts,
  );
  assigned.fill(8);
  expect(c.get(utf8("new"))!.bytes[0]).toBe(4);
  produceTrieProxy(
    initial,
    (d) => {
      const copy = d.key.bytes.slice();
      copy[0] = 99;
      expect(d.key.bytes.at(0)).toBe(1);
    },
    opts,
  );
  expect(a.get(utf8("key"))!.bytes[0]).toBe(9);
});

test("frozen inputs yield mutable drafts and array subclasses cannot bypass ownership", () => {
  type Data = {
    readonly meta: Readonly<{ n: number }>;
    readonly items: readonly number[];
  };
  const value: Data = Object.freeze({
    meta: Object.freeze({ n: 1 }),
    items: Object.freeze([1, 2]),
  });
  const initial = TrieEditor.from(
    new Basin(new MemoryStorage()),
    [[utf8("file"), value]],
    plain,
  );
  const a = produceTrie(
    initial,
    (d) => {
      const x = d.edit("file");
      x.meta.n = 3;
      x.items.push(4);
    },
    opts,
  );
  const b = produceTrieProxy(
    initial,
    (d) => {
      expect(Object.keys(d.file.meta)).toEqual(["n"]);
      expect(Object.keys(d.file.items)).toEqual(["0", "1"]);
      d.file.meta.n = 3;
      d.file.items.push(4);
    },
    opts,
  );
  expect(a.get(utf8("file"))).toEqual(b.get(utf8("file")));
  expect(value.meta.n).toBe(1);
  expect(value.items).toEqual([1, 2]);
  class AliasingArray extends Array<number> {
    override slice() {
      return this;
    }
  }
  const bad = base({ items: new AliasingArray(1, 2) });
  expect(() =>
    produceTrieProxy(
      bad,
      (d) => {
        d.file.items[0] = 9;
      },
      opts,
    ),
  ).toThrow("plain");
});
