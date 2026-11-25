/** Read snapshots on either side of the clients/ → tests/clients/ move. */
export function sourceAt(revision: string, file: string) {
  const result = Bun.spawnSync(["jj", "file", "show", "-r", revision, file]);
  return result.exitCode === 0 || !file.startsWith("tests/clients/")
    ? result
    : Bun.spawnSync(["jj", "file", "show", "-r", revision, file.slice("tests/".length)]);
}
