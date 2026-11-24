/** A ready value, or a lazy generator that yields only when asynchronous work is needed. */
export type Deferred<T> = () => Generator<PromiseLike<unknown>, T, unknown>;
export type Operation<T> = T | Deferred<T>;
/** Resume rejected waits inside the generator, preserving its normal catch/finally semantics. */
export async function resolveOperation<T>(operation: Operation<T>): Promise<T> {
  if (typeof operation !== "function") return operation;
  const generator = (operation as Deferred<T>)();
  let step = generator.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = await step.value;
    } catch (error) {
      step = generator.throw(error);
      continue;
    }
    step = generator.next(value);
  }
  return step.value;
}
