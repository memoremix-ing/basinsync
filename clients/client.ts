import { createHash } from "node:crypto";

export type Latest = { viewpoint: string; url: string };
export type ViewpointMismatch = { next: { viewpoint: string }; latest: { url: string } | null };
export const sha384 = (blob: Uint8Array): string =>
  createHash("sha384").update(blob).digest("hex");

export function form(blob: Uint8Array, viewpoint: bigint, digest = sha384(blob)): FormData {
  const data = new FormData();
  data.set("blob", new Blob([new Uint8Array(blob)]), "marker");
  data.set("sha384", digest);
  data.set("viewpoint", viewpoint.toString());
  return data;
}

export async function commit(url: string, blob: Uint8Array, viewpoint: bigint, digest?: string): Promise<Response> {
  return fetch(`${url}/epilogue`, { method: "PUT", body: form(blob, viewpoint, digest), signal: AbortSignal.timeout(30_000) });
}

export async function latest(url: string): Promise<Latest | null> {
  const response = await fetch(`${url}/epilogue/latest`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) { await response.arrayBuffer(); return null; }
  if (!response.ok) throw new Error(`latest: ${response.status} ${await response.text()}`);
  return response.json() as Promise<Latest>;
}
