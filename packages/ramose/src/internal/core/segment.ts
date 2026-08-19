/**
 * Segment (leaf) codec.
 *
 * A segment is a run of datoms sorted in one index's order. On disk it is:
 *
 *   magic "RSG1" | u8 index | u32 count | columns…
 *   columns: e (zigzag deltas) | a (uvar) | vt (u8) + v payload | t (zigzag deltas) | op (bit-packed)
 *
 * The bytes returned by `encodeSegment` are *uncompressed*; storage layers
 * apply gzip (see `bytes.ts#gzip`) or another codec — see `compress.ts`. The
 * content hash that names a segment (`seg/<sha256>`) is computed over the
 * compressed object body, so identical segments always dedupe.
 *
 * Target size ~3k datoms per leaf (see `tree.ts` builder options).
 */

import { ByteReader, ByteWriter } from "./bytes.ts";
import {
  type Datom,
  type DatomValue,
  type IndexId,
  ValueTag,
  bytesToUuid,
  uuidToBytes,
} from "./datom.ts";

const MAGIC = 0x52534731; // "RSG1"

export function writeValue(w: ByteWriter, vt: ValueTag, v: DatomValue): void {
  w.u8(vt);
  switch (vt) {
    case ValueTag.Long:
    case ValueTag.Inst:
      w.svar(v as number);
      break;
    case ValueTag.Ref:
      w.uvar(v as number);
      break;
    case ValueTag.Double:
      w.f64(v as number);
      break;
    case ValueTag.Str:
      w.str(v as string);
      break;
    case ValueTag.Bool:
      w.u8(v ? 1 : 0);
      break;
    case ValueTag.Uuid:
      w.bytes(uuidToBytes(v as string));
      break;
    case ValueTag.Bytes:
      w.lbytes(v as Uint8Array);
      break;
    default:
      throw new TypeError(`unknown value tag ${vt}`);
  }
}

export function readValue(r: ByteReader): { vt: ValueTag; v: DatomValue } {
  const vt = r.u8() as ValueTag;
  switch (vt) {
    case ValueTag.Long:
    case ValueTag.Inst:
      return { vt, v: r.svar() };
    case ValueTag.Ref:
      return { vt, v: r.uvar() };
    case ValueTag.Double:
      return { vt, v: r.f64() };
    case ValueTag.Str:
      return { vt, v: r.str() };
    case ValueTag.Bool:
      return { vt, v: r.u8() !== 0 };
    case ValueTag.Uuid:
      return { vt, v: bytesToUuid(r.bytes(16), 0) };
    case ValueTag.Bytes:
      return { vt, v: r.lbytes().slice() };
    default:
      throw new TypeError(`unknown value tag ${vt}`);
  }
}

/** Row-encode one datom (used for directory keys). */
export function writeDatom(w: ByteWriter, d: Datom): void {
  w.uvar(d.e);
  w.uvar(d.a);
  writeValue(w, d.vt, d.v);
  w.uvar(d.t);
  w.u8(d.op ? 1 : 0);
}
export function readDatom(r: ByteReader): Datom {
  const e = r.uvar();
  const a = r.uvar();
  const { vt, v } = readValue(r);
  const t = r.uvar();
  const op = r.u8() !== 0;
  return { e, a, vt, v, t, op };
}

export function encodeSegment(index: IndexId, datoms: readonly Datom[]): Uint8Array {
  const n = datoms.length;
  const w = new ByteWriter(Math.max(1024, n * 24));
  w.u32(MAGIC);
  w.u8(index);
  w.u32(n);
  // e column (deltas)
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const e = datoms[i].e;
    w.svar(e - prev);
    prev = e;
  }
  // a column
  for (let i = 0; i < n; i++) w.uvar(datoms[i].a);
  // v column
  for (let i = 0; i < n; i++) writeValue(w, datoms[i].vt, datoms[i].v);
  // t column (deltas)
  prev = 0;
  for (let i = 0; i < n; i++) {
    const t = datoms[i].t;
    w.svar(t - prev);
    prev = t;
  }
  // op column (bit-packed)
  for (let i = 0; i < n; i += 8) {
    let b = 0;
    for (let j = 0; j < 8 && i + j < n; j++) if (datoms[i + j].op) b |= 1 << j;
    w.u8(b);
  }
  return w.finish();
}

export interface DecodedSegment {
  index: IndexId;
  datoms: Datom[];
}

export function decodeSegment(buf: Uint8Array): DecodedSegment {
  const r = new ByteReader(buf);
  if (r.u32() !== MAGIC) throw new Error("bad segment magic");
  const index = r.u8() as IndexId;
  const n = r.u32();
  const es = new Array<number>(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    prev += r.svar();
    es[i] = prev;
  }
  const as = new Array<number>(n);
  for (let i = 0; i < n; i++) as[i] = r.uvar();
  const vts = new Array<ValueTag>(n);
  const vs = new Array<DatomValue>(n);
  for (let i = 0; i < n; i++) {
    const { vt, v } = readValue(r);
    vts[i] = vt;
    vs[i] = v;
  }
  const ts = new Array<number>(n);
  prev = 0;
  for (let i = 0; i < n; i++) {
    prev += r.svar();
    ts[i] = prev;
  }
  const datoms = new Array<Datom>(n);
  for (let i = 0; i < n; i += 8) {
    const b = r.u8();
    for (let j = 0; j < 8 && i + j < n; j++) {
      const k = i + j;
      datoms[k] = { e: es[k], a: as[k], vt: vts[k], v: vs[k], t: ts[k], op: (b & (1 << j)) !== 0 };
    }
  }
  return { index, datoms };
}
