/** Browser Fetch adapter. Read actions can be signed at an edge service using the revisioned node key;
 * signed URLs are never in the DAG.
 */
import { parse, stringify } from "../json0";
import {
  Basin,
  Edge,
  PendingEdge,
  allocated,
  Link,
  Storage,
  derive,
  capability,
  link,
  equal,
  sha384,
  utf8,
  check,
} from "./core";
export type Action = { url: string; headers: Record<string, string> };
export type Actions = {
  write: Action | null;
  preview: Action | null;
  read: Action;
};
export type Binding = { edge: Edge; actions: Actions };
export interface RemoteOptions {
  url: string;
  flow: string;
  viewpoint: () => bigint;
  fetch?: typeof globalThis.fetch;
  resolve?: (link: Link) => Promise<Binding | undefined>;
  context?: Record<string, string>;
}
export class BasinsyncStorage implements Storage {
  private bindings = new Map<string, Binding>();
  private fetch: typeof globalThis.fetch;
  constructor(readonly options: RemoteOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  private async binding(edge: Edge): Promise<Binding> {
    const key = capability(link(edge));
    let b = this.bindings.get(key);
    if (!b && this.options.resolve) {
      b = await this.options.resolve(link(edge));
      if (b) this.bindings.set(key, b);
    }
    check(
      b &&
        capability(link(b.edge)) === key &&
        equal(b.edge[6].sha384, edge[6].sha384),
      "no matching read capability; supply a resolver",
    );
    return b;
  }
  async resolve(l: Link): Promise<Edge | undefined> {
    let b = this.bindings.get(capability(l));
    if (!b && this.options.resolve) {
      b = await this.options.resolve(l);
      if (b) this.bindings.set(capability(l), b);
    }
    return b?.edge;
  }
  async put(
    pending: PendingEdge,
    bytes: Uint8Array,
    edges: readonly Edge[],
  ): Promise<string> {
    const auth = async (e: Edge | PendingEdge) =>
      [e[3].height, e[6].version, (await derive(e)).token] as [
        number,
        number,
        Uint8Array,
      ];
    const response = await this.fetch(
      `${this.options.url}/api/v0/userspace/heap/reserve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stringify({
          flow: this.options.flow,
          viewpoint: this.options.viewpoint(),
          nodes: [
            {
              auth: await auth(pending),
              length: bytes.length,
              context: this.options.context ?? { codec: "structures/0" },
              edges: await Promise.all(
                edges.map(async (e) => ({
                  auth: await auth(e),
                  revision: e[6].revision,
                })),
              ),
            },
          ],
        }),
      },
    );
    const result = parse<{
      errors: Record<string, { code: string; message: string }> | null;
      results: Record<string, { revision: string; actions: Actions }> | null;
    }>(await response.text());
    check(
      response.ok && !result.errors?.["0"] && result.results?.["0"],
      `reserve failed: ${response.status} ${stringify(result)}`,
    );
    const { actions, revision } = result.results["0"];
    const edge = allocated(pending, revision);
    this.bindings.set(capability(link(edge)), { edge, actions });
    if (actions.write) {
      const uploaded = await this.fetch(actions.write.url, {
        method: "PUT",
        headers: actions.write.headers,
        body: bytes as Uint8Array<ArrayBuffer>,
      });
      if (uploaded.ok) return revision;
      check(uploaded.status === 412, `node upload failed: ${uploaded.status}`);
    }
    const old = await this.get(edge);
    check(equal(old, bytes), "immutable node upload collision");
    return revision;
  }
  async get(edge: Edge): Promise<Uint8Array> {
    const { actions } = await this.binding(edge);
    for (const action of [actions.preview, actions.read]) {
      if (!action) continue;
      const response = await this.fetch(action.url, {
        headers: action.headers,
      });
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        check(
          bytes.length === edge[6].length &&
            equal(await sha384(bytes), edge[6].sha384),
          "node retrieval integrity failure",
        );
        return bytes;
      }
      check(
        response.status === 404 || response.status === 412,
        `node GET failed: ${response.status}`,
      );
    }
    throw Error("missing basin node in either generation");
  }
  /** The caller advances its staging Viewpoint only after this durable response. */
  async publish(
    root: Edge,
    context: Record<string, string> = {},
  ): Promise<Response> {
    const blob = utf8(stringify(root)),
      form = new FormData();
    form.set(
      "details",
      stringify({
        flow: this.options.flow,
        viewpoint: this.options.viewpoint(),
        sha384: await sha384(blob),
        edges: [
          {
            auth: [root[3].height, root[6].version, (await derive(root)).token],
            revision: root[6].revision,
          },
        ],
        context,
      }),
    );
    form.set("blob", new Blob([blob as Uint8Array<ArrayBuffer>]), "root");
    const response = await this.fetch(`${this.options.url}/api/v0/epilogue`, {
      method: "PUT",
      body: form,
    });
    check(
      response.ok,
      `publish failed: ${response.status} ${await response.clone().text()}`,
    );
    return response;
  }
}
