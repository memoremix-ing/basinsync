/** Browser-safe basin-node framing, capabilities and consumer-defined aggregation. */
import { encode, toReference, Reference } from "../flexbuffer";
import { encode as lex } from "../lexidecimal";
import type {
  BasinNode_S0,
  BasinEdge_S0,
  BasinQuery_S0,
  Bounds,
} from "./types";
export type Node = BasinNode_S0<
  string,
  string,
  unknown,
  { [index: number]: [unknown, ...unknown[]] }
>;
export type Edge = BasinEdge_S0<Node>;
/** Storage allocates a revision before this descriptor can become a stored edge. */
export type PendingEdge = [
  Edge[0],
  Edge[1],
  Edge[2],
  Edge[3],
  Edge[4],
  Edge[5],
  Omit<Edge[6], "revision">,
];
export const validRevision = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    s,
  );
export function allocated(edge: PendingEdge, revision: string): Edge {
  check(validRevision(revision), "invalid node revision");
  return [...edge.slice(0, 6), { ...edge[6], revision }] as Edge;
}
export const DOMAIN = "sync.memoremix.com";
export function isPromiseLike<T>(
  value: T | PromiseLike<T>,
): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}
export function check(ok: unknown, message = "invalid structure"): asserts ok {
  if (!ok) throw Error(message);
}
export function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export const equal = (a: Uint8Array, b: Uint8Array) => compare(a, b) === 0;
const hexBytes = Array.from({ length: 256 }, (_, v) =>
  v.toString(16).padStart(2, "0"),
);
export function hex(b: Uint8Array): string {
  if (typeof Uint8Array.prototype.toHex === "function")
    return Uint8Array.prototype.toHex.call(b);
  let out = "";
  for (const v of b) out += hexBytes[v];
  return out;
}
export function key(value: Uint8Array | string): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  check(
    value.length % 2 === 0 && /^[0-9a-f]*$/i.test(value),
    "key must be bytes or even-length hexadecimal",
  );
  return Uint8Array.from(value.match(/../g) ?? [], (v) => parseInt(v, 16));
}
export function concat(parts: Uint8Array[]): Uint8Array {
  const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    b.set(p, at);
    at += p.length;
  }
  return b;
}
export const utf8 = (s: string) => new TextEncoder().encode(s);
export function u32(n: number): number {
  check(Number.isInteger(n) && n >= 0 && n <= 0xffffffff, "invalid u32");
  return n;
}
export async function sha384(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-384", bytes as Uint8Array<ArrayBuffer>),
  );
}
export async function hmac(
  secret: Uint8Array,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    secret as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-384" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", k, bytes as Uint8Array<ArrayBuffer>),
  );
}
/** RFC 5869, distinct labels for each capability component. No encryption is applied here. */
export async function derive(
  edge: Edge | PendingEdge,
): Promise<{ token: Uint8Array; secret: Uint8Array; nonce: Uint8Array }> {
  const entropy = edge[6].entropy;
  check(entropy.length === 32, "invalid entropy");
  const prk = await hmac(new Uint8Array(48), entropy);
  const component = async (label: string, n: number) =>
    (
      await hmac(
        prk,
        concat([utf8(`basinsync/basin-node/0/${label}`), new Uint8Array([1])]),
      )
    ).slice(0, n);
  return {
    token: await component("token", 32),
    secret: await component("secret", 32),
    nonce: await component("nonce", 12),
  };
}
export function frame(message: Uint8Array): Uint8Array {
  u32(message.length);
  const end = Math.ceil((message.length + 16) / 8) * 8,
    b = new Uint8Array(end),
    v = new DataView(b.buffer);
  b.set([101, 110, 86, 0xa3]);
  v.setUint32(4, message.length, true);
  b.set(message, 8);
  b.fill(0xee, message.length + 8, end - 8);
  v.setUint32(end - 8, message.length, true);
  b.set([0xa3, 118, 78, 69], end - 4);
  return b;
}
export function unframe(b: Uint8Array): Uint8Array {
  check(b.length >= 16, "truncated node");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength),
    n = v.getUint32(4, true),
    end = Math.ceil((n + 16) / 8) * 8;
  check(
    b[0] === 101 &&
      b[1] === 110 &&
      b[2] === 86 &&
      b[3] === 0xa3 &&
      end === b.length &&
      v.getUint32(end - 8, true) === n &&
      b[end - 4] === 0xa3 &&
      b[end - 3] === 118 &&
      b[end - 2] === 78 &&
      b[end - 1] === 69,
    "invalid node envelope",
  );
  check(
    b.subarray(8 + n, end - 8).every((x) => x === 0xee),
    "invalid padding",
  );
  return b.subarray(8, 8 + n);
}
export const nodeBytes = (node: Node) => frame(encode(node));
/** One buffer copy at the existing FlexBuffers boundary, then lazy references/blob slices. */
export function nodeView(bytes: Uint8Array): Reference {
  const ref = toReference(unframe(bytes));
  validateNode(ref);
  return ref;
}
export function field(ref: Reference, k: string | number): Reference {
  return ref.get(k);
}
/** Owned reads copy blobs; getView()/Reference remains the explicit borrowed API. */
export function object<T = unknown>(r: Reference): T {
  const clone = (v: unknown): unknown => {
    if (v instanceof Uint8Array) return v.slice();
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === "object") {
      const out = Object.create(null);
      for (const [k, x] of Object.entries(v)) out[k] = clone(x);
      return out;
    }
    return v;
  };
  return clone(r.toObject()) as T;
}
export function validateNode(r: Reference, path?: string): void {
  check(r.isMap(), "basin node must be a map");
  check(
    r.get("0").symbolValue() === Symbol.species &&
      typeof r.get("1").stringValue() === "string" &&
      r.get("1").stringValue()!.length > 0 &&
      r.get("4").intValue() === 0,
    "unsupported node schema",
  );
  check(typeof r.get("2").stringValue() === "string", "invalid node path");
  if (path)
    check(
      r.get("1").stringValue() === DOMAIN && r.get("2").stringValue() === path,
      "wrong node species",
    );
  check(
    r.get("3").isMap() && r.get("6").isVector() && r.get("6").length() >= 2,
    "invalid node metadata",
  );
}
export function edgeFrom(r: Reference): Edge {
  const e = object<Edge>(r);
  validateEdge(e);
  return e;
}
export function validateEdge(e: Edge): void {
  check(
    Array.isArray(e) &&
      e.length === 7 &&
      e[0] === Symbol.match &&
      typeof e[1] === "string" &&
      e[1].length > 0 &&
      e[4] === 0,
    "unsupported basin edge",
  );
  check(validRevision(e[6].revision), "invalid node revision");
  u32(e[3].height);
  u32(e[6].version);
  u32(e[6].length);
  check(
    e[6].version === 0 &&
      e[6].sha384 instanceof Uint8Array &&
      e[6].sha384.length === 48 &&
      e[6].entropy instanceof Uint8Array &&
      e[6].entropy.length === 32,
    "invalid basin edge",
  );
}
export const emptyQuery = (): BasinQuery_S0 => ({
  height: 0,
  degree: 0,
  breadth: 0n,
  rotations: null,
  versions: null,
  schemas: null,
  migrations: null,
});
function range(values: (Bounds<number> | number)[]): Bounds<number> {
  const flat = values.flatMap((v) =>
    v === null ? [] : Array.isArray(v) ? v : [v],
  );
  return flat.length ? [Math.min(...flat), Math.max(...flat)] : null;
}
export function distinct(edges: Edge[]): Edge[] {
  const map = new Map<string, Edge>();
  for (const e of edges) {
    validateEdge(e);
    const id = authKey(link(e));
    const old = map.get(id);
    check(
      !old ||
        (old[6].revision === e[6].revision &&
          equal(old[6].sha384, e[6].sha384)),
      "conflicting edge descriptors",
    );
    map.set(id, e);
  }
  return [...map.values()];
}
export function query(
  edges: Edge[],
  maxDegree = 320,
  maxHeight = 128,
): BasinQuery_S0 {
  const all = distinct(edges);
  check(all.length <= maxDegree, "basin degree limit");
  if (!all.length) return emptyQuery();
  const q: BasinQuery_S0 = {
    height: 1 + Math.max(...all.map((e) => e[3].height)),
    degree: all.length,
    breadth: all.reduce((n, e) => n + 1n + e[3].breadth, 0n),
    rotations: range(all.flatMap((e) => [e[6].rotation, e[3].rotations])),
    versions: range(all.flatMap((e) => [e[6].version, e[3].versions])),
    schemas: range(all.flatMap((e) => [e[4], e[3].schemas])),
    migrations: range(all.flatMap((e) => [e[6][0], e[3].migrations])),
  };
  check(q.height <= maxHeight, "basin height limit");
  return q;
}
export type Link = {
  height: number;
  version: number;
  entropy: Uint8Array;
  revision: string;
};
const authKey = (link: Omit<Link, "revision">) =>
  `${link.height}/${link.version}/${hex(link.entropy)}`;
export const capability = (link: Link) => `${authKey(link)}/${link.revision}`;
export const link = (edge: Edge): Link => ({
  height: edge[3].height,
  version: edge[6].version,
  entropy: edge[6].entropy,
  revision: edge[6].revision,
});
/** Deterministic object address; bucket/tenant prefix and signing belong to storage. */
export async function nodeKey(
  pointer: Link,
  generation: "young" | "old",
): Promise<string> {
  u32(pointer.height);
  check(
    pointer.version === 0 && validRevision(pointer.revision),
    "invalid node pointer",
  );
  const prk = await hmac(new Uint8Array(48), pointer.entropy);
  check(pointer.entropy.length === 32, "invalid entropy");
  const token = (
    await hmac(
      prk,
      concat([utf8("basinsync/basin-node/0/token"), new Uint8Array([1])]),
    )
  ).slice(0, 32);
  return `userspace/heap/${generation}/n-${lex(~BigInt(pointer.height))}/v.${lex(BigInt(pointer.version))}/t.${lex(BigInt(token.length))}/d_${hex(await sha384(token))}/${pointer.revision}`;
}
export interface Storage {
  resolve?(link: Link): Promise<Edge | undefined>;
  /** Return the authoritative allocation revision after the upload succeeds. */
  put(
    edge: PendingEdge,
    bytes: Uint8Array,
    edges: readonly Edge[],
  ): Promise<string>;
  get(edge: Edge): Promise<Uint8Array>;
}
export class MemoryStorage implements Storage {
  readonly objects = new Map<
    string,
    { edge: Edge; bytes: Uint8Array; edges: readonly Edge[] }
  >();
  reads = 0;
  private nextRevision = 0;
  private allocationIndex = new Map<string, string>();
  readonly capabilities = new Map<string, Edge>();
  async put(
    pending: PendingEdge,
    bytes: Uint8Array,
    edges: readonly Edge[] = [],
  ): Promise<string> {
    const auth = {
      height: pending[3].height,
      version: pending[6].version,
      entropy: pending[6].entropy,
    };
    const authId = authKey(auth),
      prior = this.allocationIndex.get(authId);
    const old = prior ? this.objects.get(prior) : undefined;
    if (old) {
      check(equal(old.bytes, bytes), "immutable storage conflict");
      return old.edge[6].revision;
    }
    // Predictable UUIDv4-shaped identities are only for this in-memory test store.
    let revision: string;
    do {
      revision = `00000000-0000-4000-8000-${(++this.nextRevision).toString(16).padStart(12, "0")}`;
    } while (this.capabilities.has(`${authKey(auth)}/${revision}`));
    await this.restore(allocated(pending, revision), bytes, edges);
    return revision;
  }
  async restore(edge: Edge, bytes: Uint8Array, edges: readonly Edge[] = []) {
    validateEdge(edge);
    const k = capability(link(edge)),
      old = this.objects.get(k);
    check(!old || equal(old.bytes, bytes), "immutable storage conflict");
    this.objects.set(k, { edge, bytes: bytes.slice(), edges: [...edges] });
    this.capabilities.set(k, edge);
    const auth = authKey(link(edge)),
      prior = this.allocationIndex.get(auth);
    if (!prior || !this.objects.has(prior)) this.allocationIndex.set(auth, k);
  }
  async resolve(link: Link) {
    return this.capabilities.get(capability(link));
  }
  async get(edge: Edge) {
    this.reads++;
    const v = this.objects.get(capability(link(edge)));
    check(v, "missing basin node");
    return v.bytes.slice();
  }
}
export interface Options {
  seed?: Uint8Array;
  rotation?: number;
  maxDegree?: number;
  maxHeight?: number;
  maxBytes?: number;
  cacheBytes?: number;
}
/** Private, owned metadata snapshot; callers may mutate their descriptors safely. */
type LoadedNode = { ref: Reference; length: number; descriptor: unknown[] };
function sameMetadata(actual: unknown, expected: unknown, depth = 0): boolean {
  check(depth < 1024, "value nesting limit");
  if (actual === expected) return true;
  if (typeof actual === "number" && typeof expected === "number")
    return Number.isNaN(actual) && Number.isNaN(expected);
  if (actual instanceof Uint8Array)
    return expected instanceof Uint8Array && equal(actual, expected);
  if (Array.isArray(actual))
    return (
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((v, i) => sameMetadata(v, expected[i], depth + 1))
    );
  if (
    actual &&
    expected &&
    typeof actual === "object" &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    !(expected instanceof Uint8Array)
  ) {
    const keys = Object.getOwnPropertyNames(actual);
    return (
      keys.length === Object.getOwnPropertyNames(expected).length &&
      keys.every(
        (k) =>
          Object.hasOwn(expected, k) &&
          sameMetadata(
            (actual as Record<string, unknown>)[k],
            (expected as Record<string, unknown>)[k],
            depth + 1,
          ),
      )
    );
  }
  return false;
}
function descriptor(ref: Reference): unknown[] {
  return [
    object(ref.get("3")),
    object(ref.get("5")),
    object(ref.get("6").get(1)),
    ref.get("6").get(0).intValue(),
    ref.get("1").stringValue(),
    ref.get("2").stringValue(),
    ref.get("4").intValue(),
  ];
}
function checkDescriptor(node: LoadedNode, edge: Edge): Reference {
  check(node.length === edge[6].length, "basin node digest/length mismatch");
  const d = node.descriptor;
  check(
    sameMetadata(d[0], edge[3]) &&
      sameMetadata(d[1], edge[5]) &&
      sameMetadata(d[2], edge[6][1]) &&
      d[3] === edge[6][0] &&
      d[4] === edge[1] &&
      d[5] === edge[2] &&
      d[6] === edge[4],
    "edge summary mismatch",
  );
  return node.ref;
}

export class Basin {
  readonly seed: Uint8Array;
  private readonly cache = new Map<string, LoadedNode | Promise<LoadedNode>>();
  private costs = new Map<string, number>();
  clearCache() {
    this.cache.clear();
    this.costs.clear();
  }
  constructor(
    readonly storage: Storage,
    readonly options: Options = {},
  ) {
    this.seed =
      options.seed?.slice() ?? crypto.getRandomValues(new Uint8Array(32));
    check(this.seed.length >= 32, "seed must contain at least 256 secret bits");
  }
  async seal(node: Node, edges: Edge[]): Promise<Edge> {
    const unique = distinct(edges);
    node[3] = query(
      unique,
      this.options.maxDegree ?? 320,
      this.options.maxHeight ?? 128,
    );
    const bytes = nodeBytes(node);
    check(
      bytes.length <= (this.options.maxBytes ?? 64 * 1024 * 1024),
      "basin node byte limit",
    );
    const digest = await sha384(bytes),
      entropy = (
        await hmac(
          this.seed,
          concat([utf8("basinsync/basin-node/entropy/0"), digest]),
        )
      ).slice(0, 32);
    const edge: PendingEdge = [
      Symbol.match,
      node[1],
      node[2],
      node[3],
      node[4],
      node[5],
      {
        0: node[6][0],
        1: node[6][1],
        version: 0,
        length: bytes.length,
        weight:
          BigInt(bytes.length) + unique.reduce((s, e) => s + e[6].weight, 0n),
        sha384: digest,
        entropy,
        rotation: this.options.rotation ?? 0,
      },
    ];
    return allocated(edge, await this.storage.put(edge, bytes, unique));
  }
  /** Inspect a verified ready cache entry without initiating I/O. */
  peek(edge: Edge): Reference | undefined {
    validateEdge(edge);
    const cached = this.cache.get(
      `${capability(link(edge))}/${hex(edge[6].sha384)}`,
    );
    return cached && !(cached instanceof Promise)
      ? checkDescriptor(cached, edge)
      : undefined;
  }
  /** Ready cache hits remain synchronous; misses retain integrity verification. */
  private loadMaybe(edge: Edge): Reference | Promise<Reference> {
    validateEdge(edge);
    const k = `${capability(link(edge))}/${hex(edge[6].sha384)}`;
    const cached = this.cache.get(k);
    if (cached)
      return cached instanceof Promise
        ? cached.then((node) => checkDescriptor(node, edge))
        : checkDescriptor(cached, edge);
    const pending = (async (): Promise<LoadedNode> => {
      const b = await this.storage.get(edge);
      check(
        b.length === edge[6].length && equal(await sha384(b), edge[6].sha384),
        "basin node digest/length mismatch",
      );
      const ref = nodeView(b);
      const node = { ref, length: b.length, descriptor: descriptor(ref) };
      checkDescriptor(node, edge);
      return node;
    })();
    const budget = this.options.cacheBytes ?? 16 * 1024 * 1024;
    if (edge[6].length <= budget) {
      while (
        this.cache.size &&
        (this.cache.size >= 128 ||
          [...this.costs.values()].reduce((a, b) => a + b, 0) + edge[6].length >
            budget)
      ) {
        const oldest = this.cache.keys().next().value!;
        this.cache.delete(oldest);
        this.costs.delete(oldest);
      }
      this.cache.set(k, pending);
      this.costs.set(k, edge[6].length);
      pending.then(
        (node) => {
          if (this.cache.get(k) === pending) this.cache.set(k, node);
        },
        () => {
          if (this.cache.get(k) === pending) {
            this.cache.delete(k);
            this.costs.delete(k);
          }
        },
      );
    }
    return pending.then((node) => checkDescriptor(node, edge));
  }
  async load(edge: Edge): Promise<Reference> {
    return this.loadMaybe(edge);
  }
}
