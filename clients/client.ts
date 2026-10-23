import { createHash } from "node:crypto";

export type Position = { viewpoint: string };
export type EpilogueStatus = {
  latest: Position | null;
  recent: (Position & { url: string }) | null;
};
export type ViewpointMismatch = { next: { viewpoint: string } };
export const sha384 = (blob: Uint8Array): string =>
  createHash("sha384").update(blob).digest("hex");

export function form(flow: string, blob: Uint8Array, viewpoint: bigint, digest = sha384(blob)): FormData {
  const data = new FormData();
  data.set("flow", flow);
  data.set("blob", new Blob([new Uint8Array(blob)]), "marker");
  data.set("sha384", digest);
  data.set("viewpoint", viewpoint.toString());
  return data;
}

export async function commit(url: string, flow: string, blob: Uint8Array, viewpoint: bigint, digest?: string): Promise<Response> {
  return fetch(`${url}/api/v0/epilogue`, { method: "PUT", body: form(flow, blob, viewpoint, digest), signal: AbortSignal.timeout(30_000) });
}

export async function epilogueStatus(url: string, flow: string): Promise<EpilogueStatus> {
  const response = await fetch(`${url}/api/v0/epilogue/status?${new URLSearchParams({ flow })}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`status: ${response.status} ${await response.text()}`);
  return response.json() as Promise<EpilogueStatus>;
}
