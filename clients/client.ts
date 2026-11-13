import { createHash } from "node:crypto";
import { parse, stringify } from "./json0";

export type Position = { viewpoint: bigint };
export type Timelines = { watershed: { milestone: bigint } };
export type ApiResponse<T> = T & { timelines: Timelines };
export type CommitResponse = ApiResponse<Position>;
export type LatestMarker = Position & { length: number; url?: string; headers?: Record<string,string> };
export type EpilogueStatus = ApiResponse<{
  latest: LatestMarker | null;
}>;
export type ViewpointMismatch = ApiResponse<{ next: Position }>;
export type ApiError = ApiResponse<{ error: string; message: string }>;
export type Action = {url:string;headers:Record<string,string>};
export type HeapNode = {auth:[height:number,version:number,token:Uint8Array];length:number;edges:{auth:[height:number,version:number,token:Uint8Array]}[]};
export type HeapResponse = ApiResponse<{
  errors:Record<number,{code:string;message:string}>|null;
  results:Record<number,{actions:{write:Action|null;preview:Action|null;read:Action}}>|null;
}>;
export async function reserveHeap(url:string,flow:string,viewpoint:bigint,nodes:HeapNode[]):Promise<Response>{
  return fetch(`${url}/api/v0/heap/reserve`,{method:"POST",headers:{"content-type":"application/json"},body:stringify({flow,viewpoint,nodes}),signal:AbortSignal.timeout(30_000)});
}
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
