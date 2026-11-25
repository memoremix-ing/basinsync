/** Opt-in Proxy drafts. Records/arrays are deep COW; bytes are atomic read-only views. */
import { check } from "./core";
import {
  CowContext,
  runCow,
  type CowOptions,
  type CowResult,
  type TrieDraft,
  type ValueEdit,
} from "./cow";
import {
  cloneValue,
  validateValue,
  properties,
  markValid,
  registerDraft,
  type CowMetrics,
} from "./cow-values";
import { TrieEditor } from "./trie";
export class ReadonlyCowBytes {
  #bytes: Uint8Array;
  #scope: { check(): void };
  constructor(
    bytes: Uint8Array,
    scope: { check(): void; onClose?(fn: () => void): void },
  ) {
    this.#bytes = bytes;
    this.#scope = scope;
    const unregister = registerDraft(this, () => this.slice());
    scope.onClose?.(() => {
      unregister();
      this.#bytes = new Uint8Array();
    });
    Object.freeze(this);
  }
  get length() {
    this.#scope.check();
    return this.#bytes.length;
  }
  at(i: number) {
    this.#scope.check();
    return this.#bytes.at(i);
  }
  slice(start?: number, end?: number) {
    this.#scope.check();
    return new Uint8Array(this.#bytes.subarray(start, end));
  }
  *[Symbol.iterator]() {
    for (let i = 0; i < this.length; i++) yield this.at(i)!;
  }
}
export interface CowBytes extends Iterable<number> {
  readonly length: number;
  at(index: number): number | undefined;
  slice(start?: number, end?: number): Uint8Array;
}
export type CowValue<T> = T extends Uint8Array
  ? CowBytes
  : T extends readonly (infer V)[]
    ? CowValue<V>[]
    : T extends object
      ? { -readonly [K in keyof T]: CowValue<T[K]> }
      : T;
export type ProxyTrieDraft<V> = {
  [key: string]: CowValue<V>;
  constructor: CowValue<V>;
};
type State = {
  base: any;
  copy?: any;
  parent?: State;
  children: Map<PropertyKey, State>;
  proxy: any;
};
function recordEdit<V>(value: V, scope: CowContext<any, any>): ValueEdit<V> {
  validateValue(value);
  const metrics = scope.options.metrics;
  function mark(s: State) {
    if (!s.copy) {
      s.copy = Array.isArray(s.base)
        ? s.base.slice()
        : Object.assign(Object.create(null), s.base);
      if (metrics) metrics.clonedObjects++;
      if (s.parent) mark(s.parent);
    }
  }
  function wrap(base: any, parent?: State): State {
    const s: State = { base, parent, children: new Map(), proxy: undefined };
    const target = Array.isArray(base) ? [] : Object.create(null);
    const active = () => {
      scope.check();
      if (metrics) metrics.traps++;
    };
    const read = (p: PropertyKey): any => {
      const source = s.copy ?? s.base;
      if (!Object.hasOwn(source, p))
        return Array.isArray(source)
          ? Reflect.get(Array.prototype, p, s.proxy)
          : undefined;
      const v = source[p];
      if (!v || typeof v !== "object") return v;
      if (v instanceof Uint8Array) return new ReadonlyCowBytes(v, scope);
      let child = s.children.get(p);
      // finish() may have installed this child's copy during an intermediate
      // read. Only explicit replacement/deletion detaches its draft identity.
      if (!child) {
        child = wrap(v, s);
        s.children.set(p, child);
      }
      return child.proxy;
    };
    if (metrics) metrics.proxies++;
    const revocable = Proxy.revocable(target, {
      get(_t, p) {
        active();
        return read(p);
      },
      set(_t, p, v) {
        active();
        check(
          typeof p === "string",
          "COW symbol property keys are unsupported",
        );
        const source = s.copy ?? s.base;
        if (Array.isArray(source))
          check(
            p === "length" || /^(0|[1-9][0-9]*)$/.test(p),
            "COW array properties are unsupported",
          );
        if (Object.is(source[p], v) && Object.hasOwn(source, p)) return true;
        const owned =
          v instanceof ReadonlyCowBytes ? v.slice() : cloneValue(v, metrics);
        const prior = s.children.get(p);
        if (prior) prior.parent = undefined;
        s.children.delete(p);
        mark(s);
        s.copy[p] = owned;
        return true;
      },
      deleteProperty(_t, p) {
        active();
        if (!Object.hasOwn(s.copy ?? s.base, p)) return true;
        const prior = s.children.get(p);
        if (prior) prior.parent = undefined;
        s.children.delete(p);
        mark(s);
        delete s.copy[p];
        return true;
      },
      has(_t, p) {
        active();
        return p in (s.copy ?? s.base);
      },
      ownKeys() {
        active();
        return Reflect.ownKeys(s.copy ?? s.base);
      },
      getOwnPropertyDescriptor(_t, p) {
        active();
        const d = Object.getOwnPropertyDescriptor(s.copy ?? s.base, p);
        return d
          ? {
              ...d,
              configurable: !(Array.isArray(s.base) && p === "length"),
              writable: true,
              value: read(p),
            }
          : undefined;
      },
      defineProperty() {
        active();
        throw Error("COW defineProperty is unsupported");
      },
      setPrototypeOf() {
        active();
        throw Error("COW prototype mutation is unsupported");
      },
      preventExtensions() {
        active();
        throw Error("COW preventExtensions is unsupported");
      },
    });
    s.proxy = revocable.proxy;
    scope.onClose(revocable.revoke);
    scope.onClose(
      registerDraft(s.proxy, () => {
        scope.check();
        return finish(s);
      }),
    );
    return s;
  }
  function finish(s: State): any {
    if (!s.copy) return s.base;
    for (const [k, c] of s.children)
      if (Object.hasOwn(s.copy, k))
        s.copy[k] = finish(c);
    properties(s.copy);
    markValid(s.copy);
    return s.copy;
  }
  if (value instanceof Uint8Array)
    return {
      draft: new ReadonlyCowBytes(value, scope) as V,
      finish: () => value,
    };
  check(
    value !== null && typeof value === "object",
    "edit requires a record or array",
  );
  const root = wrap(value);
  return { draft: root.proxy, finish: () => finish(root) };
}
export function produceTrieProxy<V, M, R>(
  base: TrieEditor<V, M>,
  recipe: (d: ProxyTrieDraft<V>, operations: TrieDraft<V, M>) => R,
  options: CowOptions = {},
): CowResult<V, M, R> {
  const context = new CowContext(base, options, recordEdit);
  if (options.metrics) options.metrics.proxies++;
  const property = (p: PropertyKey): p is string =>
    typeof p === "string" &&
    (options.keyEncoding === "utf8" ||
      (p.length % 2 === 0 && /^[0-9a-f]*$/i.test(p)));
  const revocable = Proxy.revocable(Object.create(null), {
    get(_t, p) {
      context.check();
      if (options.metrics) options.metrics.traps++;
      if (!property(p)) return undefined;
      const value = context.value(p);
      if (value !== undefined) validateValue(value);
      return value && typeof value === "object" ? context.edit(p) : value;
    },
    set(_t, p, value) {
      context.check();
      if (options.metrics) options.metrics.traps++;
      check(typeof p === "string", "COW symbol map keys are unsupported");
      context.set(p, value instanceof ReadonlyCowBytes ? value.slice() : value);
      return true;
    },
    deleteProperty(_t, p) {
      context.check();
      if (options.metrics) options.metrics.traps++;
      check(typeof p === "string", "COW symbol map keys are unsupported");
      context.delete(p);
      return true;
    },
    has(_t, p) {
      context.check();
      if (options.metrics) options.metrics.traps++;
      return property(p) && context.value(p) !== undefined;
    },
    ownKeys() {
      if (options.metrics) options.metrics.traps++;
      return context.keys();
    },
    getOwnPropertyDescriptor(_t, p) {
      context.check();
      if (options.metrics) options.metrics.traps++;
      if (!property(p) || context.value(p) === undefined) return;
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (() => {
          const v = context.value(p);
          return v && typeof v === "object" ? context.edit(p) : v;
        })(),
      };
    },
    defineProperty() {
      if (options.metrics) options.metrics.traps++;
      throw Error("COW defineProperty is unsupported");
    },
    setPrototypeOf() {
      if (options.metrics) options.metrics.traps++;
      throw Error("COW prototype mutation is unsupported");
    },
    preventExtensions() {
      if (options.metrics) options.metrics.traps++;
      throw Error("COW preventExtensions is unsupported");
    },
  });
  const draft = revocable.proxy as ProxyTrieDraft<V>;
  context.onClose(revocable.revoke);
  return runCow(context, draft, (d) => recipe(d, context)) as CowResult<
    V,
    M,
    R
  >;
}
