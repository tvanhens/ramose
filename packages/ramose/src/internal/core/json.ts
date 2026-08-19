/**
 * JSON transport encoding for values that JSON cannot represent natively:
 *   Date        ⇄ { "$inst": <epoch ms> }
 *   Uint8Array  ⇄ { "$bytes": <base64> }
 *   uuid values ⇄ { "$uuid": "<canonical>" }   (tagged values, see datom.ts)
 *   bigint      →  number
 * Used by the HTTP API (worker ⇄ client) and the DO RPC bodies.
 */

import { ValueTag } from "./datom.ts";
import { base64ToBytes, bytesToBase64 } from "./log.ts";

export function toJson(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (v instanceof Date) return { $inst: v.getTime() };
  if (v instanceof Uint8Array) return { $bytes: bytesToBase64(v) };
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(toJson);
  if (v instanceof Set) return [...v].map(toJson);
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), toJson(x)]));
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("vt" in o && "v" in o && Object.keys(o).length === 2) {
      if (o.vt === ValueTag.Uuid) return { $uuid: o.v };
      if (o.vt === ValueTag.Inst) return { $inst: o.v };
      if (o.vt === ValueTag.Bytes) return { $bytes: bytesToBase64(o.v as Uint8Array) };
      return toJson(o.v);
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = toJson(x);
    return out;
  }
  return v;
}

export function fromJson(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(fromJson);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    if ("$inst" in o) return new Date(typeof o.$inst === "number" ? o.$inst : Date.parse(String(o.$inst)));
    if ("$bytes" in o) return base64ToBytes(String(o.$bytes));
    if ("$uuid" in o) return { vt: ValueTag.Uuid, v: String(o.$uuid).toLowerCase() };
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = fromJson(x);
  return out;
}

export function stringifyJson(v: unknown): string {
  return JSON.stringify(toJson(v));
}
export function parseJson<T = unknown>(s: string): T {
  return fromJson(JSON.parse(s)) as T;
}
