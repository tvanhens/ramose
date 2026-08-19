/**
 * Transaction log records and the (versioned) novelty wire format.
 *
 * - `LogEntry`: one committed transaction (t, txInstant, datoms).
 * - Binary chunk codec for `log/<t0>-<t1>` R2 objects (indexer input, replica catch-up).
 * - JSON wire format v1 for novelty frames pushed over WebSocket (Transactor → replicas
 *   → clients). Values are encoded so that every value type round-trips through JSON.
 */

import { ByteReader, ByteWriter } from "./bytes.ts";
import { type Datom, type DatomValue, ValueTag } from "./datom.ts";
import { readValue, writeValue } from "./segment.ts";

export interface LogEntry {
  t: number;
  txInstant: number;
  datoms: Datom[];
}

const LOG_MAGIC = 0x524c4731; // "RLG1"

export function encodeLogChunk(entries: readonly LogEntry[]): Uint8Array {
  const w = new ByteWriter();
  w.u32(LOG_MAGIC);
  w.uvar(entries.length);
  for (const e of entries) {
    w.uvar(e.t);
    w.uvar(e.txInstant);
    w.uvar(e.datoms.length);
    for (const d of e.datoms) {
      w.uvar(d.e);
      w.uvar(d.a);
      writeValue(w, d.vt, d.v);
      w.u8(d.op ? 1 : 0);
    }
  }
  return w.finish();
}

export function decodeLogChunk(buf: Uint8Array): LogEntry[] {
  const r = new ByteReader(buf);
  if (r.u32() !== LOG_MAGIC) throw new Error("bad log chunk magic");
  const n = r.uvar();
  const out: LogEntry[] = [];
  for (let i = 0; i < n; i++) {
    const t = r.uvar();
    const txInstant = r.uvar();
    const m = r.uvar();
    const datoms: Datom[] = new Array(m);
    for (let j = 0; j < m; j++) {
      const e = r.uvar();
      const a = r.uvar();
      const { vt, v } = readValue(r);
      const op = r.u8() !== 0;
      datoms[j] = { e, a, vt, v, t, op };
    }
    out.push({ t, txInstant, datoms });
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON wire format (v1)
// ---------------------------------------------------------------------------

/** Compact JSON datom: [e, a, vt, v, t, op] with bytes base64-encoded. */
export type WireDatom = [number, number, number, string | number | boolean, number, 0 | 1];

export function toWireDatom(d: Datom): WireDatom {
  let v: string | number | boolean;
  if (d.vt === ValueTag.Bytes) v = bytesToBase64(d.v as Uint8Array);
  else v = d.v as string | number | boolean;
  return [d.e, d.a, d.vt, v, d.t, d.op ? 1 : 0];
}
export function fromWireDatom(w: WireDatom): Datom {
  const vt = w[2] as ValueTag;
  const v: DatomValue = vt === ValueTag.Bytes ? base64ToBytes(w[3] as string) : (w[3] as DatomValue);
  return { e: w[0], a: w[1], vt, v, t: w[4], op: w[5] === 1 };
}

export interface NoveltyFrameV1 {
  v: 1;
  kind: "tx";
  t: number;
  txInstant: number;
  datoms: WireDatom[];
}
export interface RootFrameV1 {
  v: 1;
  kind: "root";
  /** new index root record */
  root: unknown;
}
export interface HelloFrameV1 {
  v: 1;
  kind: "hello";
  /** transactor's current basis t */
  t: number;
  /** current root record */
  root: unknown;
}
export interface GapFrameV1 {
  v: 1;
  kind: "gap";
  /** subscriber asked to resume from a t we no longer hold in the DO log; fetch log/ chunks up to `from` */
  from: number;
}
export type WireFrame = NoveltyFrameV1 | RootFrameV1 | HelloFrameV1 | GapFrameV1;

export function txFrame(entry: LogEntry): NoveltyFrameV1 {
  return { v: 1, kind: "tx", t: entry.t, txInstant: entry.txInstant, datoms: entry.datoms.map(toWireDatom) };
}
export function entryFromFrame(f: NoveltyFrameV1): LogEntry {
  return { t: f.t, txInstant: f.txInstant, datoms: f.datoms.map(fromWireDatom) };
}

export function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Root record as stored at root/current and roots/<t> (JSON). */
export interface RootRecord {
  v: 1;
  t: number;
  eavt: { hash: string; kind: 0 | 1; count: number };
  aevt: { hash: string; kind: 0 | 1; count: number };
  avet: { hash: string; kind: 0 | 1; count: number };
  vaet: { hash: string; kind: 0 | 1; count: number };
  /** highest t whose log chunk has been flushed to R2 */
  log_watermark: number;
  /** next entity id to allocate (so a restored transactor never reuses ids) */
  next_eid: number;
  codec: string;
  created_at: number;
}
