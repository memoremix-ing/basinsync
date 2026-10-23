export const WELL_KNOWN_BY_NAME: Record<string, symbol> = {
  // asyncDispose: Symbol.asyncDispose,
  asyncIterator: Symbol.asyncIterator,
  // dispose: Symbol.dispose,
  // hasInstance: Symbol.hasInstance,
  // isConcatSpreadable: Symbol.isConcatSpreadable,
  iterator: Symbol.iterator,
  // match: Symbol.match,
  // matchAll: Symbol.matchAll,
  // replace: Symbol.replace,
  // search: Symbol.search,
  species: Symbol.species,
  // split: Symbol.split,
  // toPrimitive: Symbol.toPrimitive,
  // toStringTag: Symbol.toStringTag,
  unscopables: Symbol.unscopables,
};

export const WELL_KNOWN: Record<symbol, string> = Object.fromEntries(
  Object.entries(WELL_KNOWN_BY_NAME).map(([name, symbol]) => [
    symbol,
    name,
  ]),
);

