import type { Consumer } from "./trie";
const rules = new WeakMap<object, { keyIndependent: boolean }>();
/** Declare an ordered monoid: combine may regroup summaries; empty is its identity.
 * Registration does not survive spreading/overriding the consumer. */
export function composableConsumer<V, M>(
  consumer: Consumer<V, M>,
  options: { keyIndependent?: boolean } = {},
): Consumer<V, M> {
  const registered = Object.freeze({ ...consumer });
  rules.set(registered, { keyIndependent: options.keyIndependent === true });
  return registered;
}
export function summaryReuse(consumer: object) {
  return rules.get(consumer);
}
