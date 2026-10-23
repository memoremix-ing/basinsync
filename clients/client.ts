import { createHash } from "node:crypto";
import { stringify } from "./json0";

export type Position = { viewpoint: string };
export type EpilogueStatus = {
  latest: Position | null;
  recent: (Position & { url: string }) | null;
};
export type ViewpointMismatch = { next: { viewpoint: string } };
export const sha384 = (blob: Uint8Array): string =>
  createHash("sha384").update(blob).digest("hex");

export type CommitMetadata = { flow: string; viewpoint: bigint; sha384: Uint8Array };
export const sha384Bytes = (blob: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha384").update(blob).digest());

export function form(flow: string, blob: Uint8Array, viewpoint: bigint, digest = sha384Bytes(blob)): FormData {
  const data = new FormData();
  data.set("metadata", stringify({ flow, viewpoint, sha384: digest } satisfies CommitMetadata));
  data.set("blob", new Blob([new Uint8Array(blob)]), "marker");
  return data;
}

export async function commit(url: string, flow: string, blob: Uint8Array, viewpoint: bigint, digest?: Uint8Array): Promise<Response> {
  return fetch(`${url}/api/v0/epilogue`, { method: "PUT", body: form(flow, blob, viewpoint, digest), signal: AbortSignal.timeout(30_000) });
}

export async function epilogueStatus(url: string, flow: string): Promise<EpilogueStatus> {
  const response = await fetch(`${url}/api/v0/epilogue/status?${new URLSearchParams({ flow })}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`status: ${response.status} ${await response.text()}`);
  return response.json() as Promise<EpilogueStatus>;
}
