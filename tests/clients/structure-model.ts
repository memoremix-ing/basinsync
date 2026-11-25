/** Independent content oracle: no structure readers, writers or packing helpers. */
export function expectedContents(input: any): unknown[][] {
  if (input.kind === "trie" || input.kind === "btree")
    return [...input.entries].map(([k, v]: [string, unknown]) => [k.toLowerCase(), v] as [string, unknown])
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (input.kind === "vector")
    return [...input.items].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (input.kind === "mixed") {
    const prefix = input.content as Uint8Array, size = input.pageSize ?? 4096;
    const end = input.pages.reduce((n: number, [i,b]: [bigint, Uint8Array]) => Math.max(n, Number(i)*size+b.length), 0);
    const bytes = new Uint8Array(prefix.length+end); bytes.set(prefix);
    for (const [i,b] of input.pages) bytes.set(b,prefix.length+Number(i)*size);
    return [["/mixed",bytes], ...(input.queries??[]).map((at:bigint)=>[`/range/${at}`,bytes.slice(Number(at),Number(at)+33)])];
  }
  if (input.kind === "pages") {
    const pages = new Map(input.pages);
    return input.queries.map((i: bigint) => [i, pages.get(i) ?? null]);
  }
  const files = new Map<string, unknown>(input.files), dirs = new Set<string>(["/"]);
  const parents = (path: string) => {
    for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1))
      dirs.add(path.slice(0, i));
  };
  for (const name of files.keys()) parents(name);
  for (const name of input.directories ?? []) { dirs.add(name); parents(name); }
  const inside = (name: string, root: string) => name === root || name.startsWith(root + "/");
  const remove = (root: string) => {
    for (const name of files.keys()) if (inside(name, root)) files.delete(name);
    for (const name of dirs) if (inside(name, root)) dirs.delete(name);
  };
  for (const op of input.operations ?? []) {
    if (op.op === "rm") remove(op.path);
    else {
      const selectedFiles = [...files].filter(([name]) => inside(name, op.from));
      const selectedDirs = [...dirs].filter(name => inside(name, op.from));
      if (op.replace) remove(op.to);
      if (op.op === "mv") remove(op.from);
      for (const [name, value] of selectedFiles) files.set(op.to + name.slice(op.from.length), value);
      for (const name of selectedDirs) dirs.add(op.to + name.slice(op.from.length));
    }
  }
  const rows: unknown[][] = [];
  const walk = (prefix: string) => {
    const stem = prefix === "/" ? "/" : prefix + "/";
    const names = new Set([...files.keys(), ...dirs].filter(n => n.startsWith(stem) && n !== prefix)
      .map(n => n.slice(stem.length).split("/")[0]));
    for (const name of [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const full = stem + name;
      if (dirs.has(full)) { rows.push([full, null]); walk(full); }
      else rows.push([full, files.get(full)]);
    }
  };
  walk("/");
  return rows;
}
