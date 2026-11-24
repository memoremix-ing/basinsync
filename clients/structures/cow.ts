/** Scoped explicit COW. Byte and record payloads never leak committed writable aliases. */
import { check, hex, isPromiseLike, key, utf8 } from "./core";
import { TrieEditor } from "./trie";
import {
  cloneValue,
  sameValue,
  validateValue,
  markValid,
  type CowMetrics,
} from "./cow-values";
export type CowKey = Uint8Array | string;
export type CowOptions = { metrics?: CowMetrics; keyEncoding?: "hex" | "utf8" };
export type CowMutable<T> = T extends Uint8Array
  ? Uint8Array
  : T extends object
    ? { -readonly [P in keyof T]: CowMutable<T[P]> }
    : T;
export interface TrieDraft<V, M> {
  get(key: CowKey): V | undefined;
  /** Clone a payload on first access, mutate normally, detach again at commit. */
  edit(key: CowKey): CowMutable<V>;
  updateIn(
    key: CowKey,
    path: readonly (string | number)[],
    update: (value: unknown) => unknown,
  ): void;
  set(key: CowKey, value: V): void;
  delete(key: CowKey): void;
  deletePrefix(prefix: CowKey): void;
  graftPrefix(
    prefix: CowKey,
    subtree: TrieEditor<V, M>,
    mode?: "error" | "replace",
  ): void;
}
export type ValueEdit<V> = { draft: V; finish(): V };
export class CowContext<V, M> implements TrieDraft<V, M> {
  active = true;
  private closers: (() => void)[] = [];
  onClose(fn: () => void) {
    this.check();
    this.closers.push(fn);
  }
  close() {
    this.active = false;
    for (const fn of this.closers) fn();
    this.closers = [];
    this.edits.clear();
    this.current = undefined;
    this.factory = undefined;
  }
  private edits = new Map<string, { key: Uint8Array; edit: ValueEdit<V> }>();
  constructor(
    private current: TrieEditor<V, M> | undefined,
    readonly options: CowOptions = {},
    private factory?: (value: V, scope: CowContext<V, M>) => ValueEdit<V>,
  ) {}
  check() {
    check(this.active, "COW scope is closed");
  }
  bytes(k: CowKey) {
    if (typeof k === "string" && this.options.keyEncoding === "utf8") {
      check(k.isWellFormed(), "invalid COW UTF-8 key");
      return utf8(k);
    }
    return key(k);
  }
  value(k: CowKey): V | undefined {
    this.check();
    return (
      this.edits.get(hex(this.bytes(k)))?.edit.finish() ??
      this.current!.get(this.bytes(k))
    );
  }
  get(k: CowKey) {
    const v = this.value(k);
    return v === undefined ? undefined : cloneValue(v, this.options.metrics);
  }
  edit(k: CowKey): CowMutable<V> {
    this.check();
    const bytes = this.bytes(k),
      id = hex(bytes),
      prior = this.edits.get(id);
    if (prior) return prior.edit.draft as CowMutable<V>;
    check(this.current!.has(bytes), "missing COW key");
    const value = this.current!.get(bytes)!;
    const edit = this.factory
      ? this.factory(value, this)
      : (() => {
          const draft = cloneValue(value, this.options.metrics);
          return {
            draft,
            finish: () =>
              sameValue(draft, value)
                ? value
                : cloneValue(draft, this.options.metrics),
          };
        })();
    this.edits.set(id, { key: bytes, edit });
    return edit.draft as CowMutable<V>;
  }
  updateIn(
    k: CowKey,
    path: readonly (string | number)[],
    update: (value: unknown) => unknown,
  ) {
    this.check();
    const bytes = this.bytes(k),
      id = hex(bytes),
      pending = this.edits.get(id);
    const value = pending ? pending.edit.finish() : this.current!.get(bytes);
    check(value !== undefined, "missing COW key");
    validateValue(value);
    const replace = (v: any, depth: number): any => {
      if (depth === path.length) {
        const next = update(cloneValue(v, this.options.metrics));
        return Object.is(next, v) ? v : cloneValue(next, this.options.metrics);
      }
      check(
        v && typeof v === "object" && !(v instanceof Uint8Array),
        "COW path requires a record/array; replace bytes atomically",
      );
      const p = path[depth];
      check(Object.hasOwn(v, p), "missing COW path");
      const child = replace(v[p], depth + 1);
      if (Object.is(child, v[p])) return v;
      const copy = Array.isArray(v)
        ? v.slice()
        : Object.assign(Object.create(null), v);
      if (this.options.metrics) this.options.metrics.clonedObjects++;
      copy[p] = child;
      markValid(copy);
      return copy;
    };
    const next = replace(value, 0);
    this.edits.delete(id);
    this.current = this.current!.set(bytes, next);
  }
  set(k: CowKey, v: V) {
    this.check();
    const bytes = this.bytes(k),
      owned = cloneValue(v, this.options.metrics);
    this.edits.delete(hex(bytes));
    this.current = this.current!.set(bytes, owned);
  }
  delete(k: CowKey) {
    this.check();
    const bytes = this.bytes(k);
    this.edits.delete(hex(bytes));
    this.current = this.current!.delete(bytes);
  }
  private flush() {
    for (const { key, edit } of this.edits.values())
      this.current = this.current!.set(key, edit.finish());
  }
  deletePrefix(k: CowKey) {
    this.check();
    this.flush();
    const prefix = this.bytes(k);
    this.current = this.current!.deletePrefix(prefix);
    for (const [id, e] of this.edits)
      if (
        e.key.length >= prefix.length &&
        prefix.every((b, i) => b === e.key[i])
      )
        this.edits.delete(id);
  }
  graftPrefix(
    k: CowKey,
    subtree: TrieEditor<V, M>,
    mode: "error" | "replace" = "error",
  ) {
    this.check();
    this.flush();
    const prefix = this.bytes(k);
    this.current = this.current!.graftPrefix(prefix, subtree, mode);
    for (const [id, e] of this.edits)
      if (
        e.key.length >= prefix.length &&
        prefix.every((b, i) => b === e.key[i])
      )
        this.edits.delete(id);
  }
  keys() {
    this.check();
    return [...this.current!.entries()].map(([k]) =>
      this.options.keyEncoding === "utf8"
        ? new TextDecoder("utf-8", { fatal: true }).decode(k)
        : hex(k),
    );
  }
  finish() {
    this.check();
    this.flush();
    return this.current!;
  }
}
export function runCow<V, M, D>(
  context: CowContext<V, M>,
  draft: D,
  recipe: (d: D) => unknown,
): TrieEditor<V, M> | Promise<TrieEditor<V, M>> {
  try {
    const work = recipe(draft);
    if (isPromiseLike(work))
      return Promise.resolve(work)
        .then(() => context.finish())
        .finally(() => {
          context.close();
        });
    const result = context.finish();
    context.close();
    return result;
  } catch (e) {
    context.close();
    throw e;
  }
}
export type CowResult<V, M, R> =
  R extends PromiseLike<unknown> ? Promise<TrieEditor<V, M>> : TrieEditor<V, M>;
export function produceTrie<V, M, R>(
  base: TrieEditor<V, M>,
  recipe: (d: TrieDraft<V, M>) => R,
  options: CowOptions = {},
): CowResult<V, M, R> {
  const context = new CowContext(base, options);
  return runCow(context, context, recipe) as CowResult<V, M, R>;
}
