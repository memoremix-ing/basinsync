import { readFileSync } from "node:fs";

/** Wire vectors shared with the Rust tests in tests/vectors/. */
export const vectors = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../vectors/${name}.json`, import.meta.url), "utf8"));
