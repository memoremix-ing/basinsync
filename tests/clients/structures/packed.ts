/** Common physical packing for ordered logical nodes. */
import { Basin, Edge, Node, distinct, query, DOMAIN } from "./core";
export type Built = { node: Node; edges: Edge[] };
export async function pack(
  basin: Basin,
  children: Built[],
  own: number,
  refs: Edge[],
) {
  const inlined =
    own +
    children.reduce(
      (n, c) => n + (c.node[5] as { inlined: number }).inlined,
      0,
    );
  const all = distinct([...refs, ...children.flatMap((c) => c.edges)]);
  const cut =
    children.length > 0 &&
    (inlined > 1280 || all.length > (basin.options.maxDegree ?? 320));
  const slots: (Node | Edge)[] = [],
    edges = [...refs];
  for (const c of children) {
    if (cut) {
      const e = await basin.seal(c.node, c.edges);
      slots.push(e);
      edges.push(e);
    } else {
      slots.push(c.node);
      edges.push(...c.edges);
    }
  }
  return { slots, edges: distinct(edges), inlined: cut ? own : inlined };
}
export function built(
  basin: Basin,
  path: string,
  header: unknown,
  footer: unknown[],
  edges: Edge[],
): Built {
  return {
    node: {
      0: Symbol.species,
      1: DOMAIN,
      2: path,
      3: query(
        edges,
        basin.options.maxDegree ?? 320,
        basin.options.maxHeight ?? 128,
      ),
      4: 0,
      5: header,
      6: footer,
    } as Node,
    edges,
  };
}
