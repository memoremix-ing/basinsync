import { expect, test } from "bun:test";
import { form, sha384, sha384Bytes, type CommitDetails } from "./client";
import { parse } from "./json0";

test("SHA-384 preserves all 48 bytes through JSON0 details, including leading zeros", () => {
  // SHA-384("359") begins with a zero byte.
  const expected = "00f3fbd8c288205e0ecd637d7e66c229a6d9874fa5d8a2afe81d02a3fa8edb2aaf090e958d1610179e98912262800c94";
  const blob = new TextEncoder().encode("359");
  expect(sha384(blob)).toBe(expected);
  const data = form("0x/test", blob, 1n << 128n);
  const details = parse<CommitDetails>(data.get("details") as string);
  expect([...data.keys()]).toEqual(["details", "blob"]);
  expect(details.flow).toBe("0x/test");
  expect(details.viewpoint).toBe(1n << 128n);
  expect(details.sha384).toEqual(sha384Bytes(blob));
  expect(Buffer.from(details.sha384).toString("hex")).toBe(expected);
});
