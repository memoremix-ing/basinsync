import { expect, test } from "bun:test";
import { form, sha384, sha384Bytes, type CommitMetadata } from "./client";
import { parse } from "./json0";

test("SHA-384 preserves all 48 bytes through JSON0 metadata, including leading zeros", () => {
  for (const [text, expected] of [
    ["", "38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b"],
    ["abc", "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7"],
    ["359", "00f3fbd8c288205e0ecd637d7e66c229a6d9874fa5d8a2afe81d02a3fa8edb2aaf090e958d1610179e98912262800c94"],
  ]) {
    const blob = new TextEncoder().encode(text);
    expect(sha384(blob)).toBe(expected);
    const data = form("0x/test", blob, 1n << 128n);
    const metadata = parse<CommitMetadata>(data.get("metadata") as string);
    expect([...data.keys()]).toEqual(["metadata", "blob"]);
    expect(metadata.flow).toBe("0x/test");
    expect(metadata.viewpoint).toBe(1n << 128n);
    expect(metadata.sha384).toEqual(sha384Bytes(blob));
    expect(metadata.sha384.length).toBe(48);
    expect(Buffer.from(metadata.sha384).toString("hex")).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{96}$/);
  }
});
