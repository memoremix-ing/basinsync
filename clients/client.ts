import { createHash } from "node:crypto";
import { parse, stringify } from "./json0";

export type Position = { viewpoint: bigint };
export type LatestMarker = Position & { length: number; url?: string; headers?: Record<string,string> };
export type EpilogueStatus = {
  latest: LatestMarker | null;
  recent: (Position & { url: string }) | null;
};
export type ViewpointMismatch = { next: Position };
export type ApiError = { error: string; message: string };
export async function parseResponse<T>(response: Response): Promise<T> {
  return parse<T>(await response.text());
}
export const sha384 = (blob: Uint8Array): string =>
  createHash("sha384").update(blob).digest("hex");

export type CommitDetails = { flow: string; viewpoint: bigint; sha384: Uint8Array };
export const sha384Bytes = (blob: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha384").update(blob).digest());

export function form(flow: string, blob: Uint8Array, viewpoint: bigint, digest = sha384Bytes(blob)): FormData {
  const data = new FormData();
  data.set("details", stringify({ flow, viewpoint, sha384: digest } satisfies CommitDetails));
  data.set("blob", new Blob([new Uint8Array(blob)]), "marker");
  return data;
}

export async function commit(url: string, flow: string, blob: Uint8Array, viewpoint: bigint, digest?: Uint8Array): Promise<Response> {
  return fetch(`${url}/api/v0/epilogue`, { method: "PUT", body: form(flow, blob, viewpoint, digest), signal: AbortSignal.timeout(30_000) });
}

export async function epilogueStatus(url: string, flow: string): Promise<EpilogueStatus> {
  const response = await fetch(`${url}/api/v0/epilogue/status?${new URLSearchParams({ flow })}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`status: ${response.status} ${await response.text()}`);
  return parseResponse<EpilogueStatus>(response);
}

export async function latestBlob(marker:LatestMarker):Promise<Uint8Array>{
  if(marker.length===0)return new Uint8Array();
  if(!marker.url||!marker.headers)throw new Error("missing marker GET capability");
  const response=await fetch(marker.url,{headers:marker.headers,signal:AbortSignal.timeout(30_000)});
  if(response.status!==(marker.headers.Range?206:200))throw new Error(`marker GET: ${response.status}`);
  const blob=new Uint8Array(await response.arrayBuffer());
  if(blob.length!==marker.length)throw new Error("marker GET length mismatch");
  return blob;
}
