/** Shared value rules for COW experiments: acyclic records, dense arrays and atomic bytes. */
import { check } from "./core";
export type CowMetrics = {
  clonedObjects: number;
  copiedBytes: number;
  proxies: number;
  traps: number;
};
export const cowMetrics = (): CowMetrics => ({
  clonedObjects: 0,
  copiedBytes: 0,
  proxies: 0,
  traps: 0,
});
const validated = new WeakSet<object>();
const draftValues = new WeakMap<object, () => unknown>();
export function registerDraft(value: object, snapshot: () => unknown) {
  draftValues.set(value, snapshot);
  return () => draftValues.delete(value);
}
export function properties(value: object): string[] {
  const array = Array.isArray(value),
    proto = Object.getPrototypeOf(value);
  check(
    array
      ? proto === Array.prototype
      : proto === Object.prototype || proto === null,
    "COW supports plain records, dense arrays and atomic bytes",
  );
  const keys = Reflect.ownKeys(value).filter((k) => !(array && k === "length"));
  for (const k of keys) {
    check(typeof k === "string", "COW symbol property keys are unsupported");
    const d = Object.getOwnPropertyDescriptor(value, k)!;
    check(
      "value" in d && d.enumerable,
      "COW accessor/nonenumerable properties are unsupported",
    );
    if (array)
      check(
        /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < (value as unknown[]).length,
        "COW array properties are unsupported",
      );
  }
  if (array)
    check(
      keys.length === (value as unknown[]).length,
      "COW arrays must be dense; use splice instead of deleting indices",
    );
  return keys as string[];
}
export function validateValue(v: unknown, path = new Set<object>()): void {
  if (v === null || typeof v !== "object") {
    check(v !== undefined && typeof v !== "function", "unsupported COW value");
    return;
  }
  if (validated.has(v) || v instanceof Uint8Array) return;
  check(!path.has(v), "cyclic COW value");
  path.add(v);
  for (const k of properties(v)) validateValue((v as any)[k], path);
  path.delete(v);
  validated.add(v);
}
export function cloneValue<T>(
  v: T,
  metrics?: CowMetrics,
  path = new Set<object>(),
): T {
  if (v === null || typeof v !== "object") {
    validateValue(v);
    return v;
  }
  const draft = draftValues.get(v);
  if (draft) return cloneValue(draft(), metrics, path) as T;
  if (v instanceof Uint8Array) {
    if (metrics) metrics.copiedBytes += v.length;
    return new Uint8Array(v) as T;
  }
  check(!path.has(v), "cyclic COW value");
  path.add(v);
  const out: any = Array.isArray(v) ? [] : Object.create(null);
  if (metrics) metrics.clonedObjects++;
  for (const k of properties(v))
    out[k] = cloneValue((v as any)[k], metrics, path);
  path.delete(v);
  validated.add(out);
  return out;
}
export function sameValue(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array)
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((v, i) => v === b[i])
    );
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]))
  );
}
export function markValid(value: object) {
  validated.add(value);
}
