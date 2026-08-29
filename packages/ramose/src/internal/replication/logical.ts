/** Logical authorized-datom projection, state hashing, and bounded diffs. */

import type { Datom, DatomValue } from "../core/datom.ts";
import {
  Index,
  ValueTag,
  compareValue,
} from "../core/datom.ts";
import type { Db } from "../core/db.ts";
import { bytesToBase64 } from "../core/log.ts";
import { canonicalizeJson } from "../authorization/canonical-json.ts";
import type { JsonValue } from "../authorization/json.ts";
import { makeEntityIdentity, opaqueDigest } from "./identity.ts";
import {
  MAX_REPLICATION_CHANGE_BYTES,
  MAX_REPLICATION_DATOMS_PER_CHANGE,
  MAX_REPLICATION_DATOMS_PER_SNAPSHOT_CHUNK,
  MAX_REPLICATION_RAW_VALUE_PART_BYTES,
  MAX_REPLICATION_STRING_BYTES,
  type LogicalDatom,
  type SnapshotDatom,
  type SnapshotLogicalValue,
  type OpaqueReplicationId,
} from "./protocol.ts";

const utf8 = new TextEncoder();
const HASH_BLOCK_BYTES = 65_536;
const MAX_ENTITY_CACHE = 1_024;
// A UTF-16 code unit needs at most three UTF-8 bytes when encoded on its own.
// Fixed code-unit boundaries also preserve lone surrogates through JSON.
const MAX_STRING_PART_CODE_UNITS = Math.floor(
  MAX_REPLICATION_STRING_BYTES / 3,
);

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  signal?.throwIfAborted();
};

export type LogicalEntry = {
  readonly raw: Datom;
  readonly datom: SnapshotDatom;
};

export type LogicalIdentityEncoder = {
  readonly database: string;
  readonly entity: (eid: number) => Promise<OpaqueReplicationId>;
};

export const makeLogicalIdentityEncoder = (
  secret: string,
  database: string,
): LogicalIdentityEncoder => {
  const cache = new Map<number, Promise<OpaqueReplicationId>>();
  return {
    database,
    entity: (eid) => {
      let identity = cache.get(eid);
      if (identity !== undefined) {
        cache.delete(eid);
        cache.set(eid, identity);
        return identity;
      }
      if (cache.size >= MAX_ENTITY_CACHE) {
        cache.delete(cache.keys().next().value!);
      }
      identity = makeEntityIdentity(secret, database, eid);
      cache.set(eid, identity);
      return identity;
    },
  };
};

const boundedText = (value: string): string => {
  if (utf8.encode(value).byteLength > MAX_REPLICATION_STRING_BYTES) {
    throw new RangeError("replication string exceeds the wire bound");
  }
  return value;
};

const concat = (
  left: Uint8Array,
  right: Uint8Array,
): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left);
  out.set(right, left.byteLength);
  return out;
};

function* stringParts(value: string): Generator<string, void, undefined> {
  for (let offset = 0; offset < value.length; offset += MAX_STRING_PART_CODE_UNITS) {
    yield value.slice(offset, offset + MAX_STRING_PART_CODE_UNITS);
  }
}

function* byteParts(value: Uint8Array): Generator<Uint8Array, void, undefined> {
  for (let offset = 0; offset < value.byteLength; offset += MAX_REPLICATION_RAW_VALUE_PART_BYTES) {
    yield value.subarray(offset, offset + MAX_REPLICATION_RAW_VALUE_PART_BYTES);
  }
}

const utf16Bytes = (value: string): Uint8Array => {
  const out = new Uint8Array(value.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < value.length; index++) {
    view.setUint16(index * 2, value.charCodeAt(index), false);
  }
  return out;
};

/** A bounded-memory digest for grouping fragments of one logical value. */
const valuePartIdentity = async (
  type: "string" | "bytes",
  parts: Iterable<Uint8Array>,
): Promise<OpaqueReplicationId> => {
  let prior: Uint8Array<ArrayBuffer> = new Uint8Array(32);
  for (const part of parts) {
    prior = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      concat(prior, part),
    ));
  }
  return opaqueDigest(`ramose:replication:${type}-value:v1`, prior);
};

/**
 * Project one stored value through the production wire path. Large native
 * strings and byte arrays become independently bounded snapshot-only parts;
 * a change involving any such value takes the existing Reset + snapshot path.
 */
export async function* projectLogicalValueParts(
  datom: Datom,
  encoder: LogicalIdentityEncoder,
): AsyncGenerator<SnapshotLogicalValue, void, undefined> {
  switch (datom.vt) {
    case ValueTag.Long:
      if (typeof datom.v !== "number" || !Number.isSafeInteger(datom.v)) {
        throw new TypeError("invalid logical long");
      }
      yield { type: "long", value: datom.v };
      return;
    case ValueTag.Double:
      if (typeof datom.v !== "number" || Number.isNaN(datom.v)) {
        throw new TypeError("invalid logical double");
      }
      yield {
        type: "double",
        value: datom.v === Number.POSITIVE_INFINITY
          ? "positive-infinity"
          : datom.v === Number.NEGATIVE_INFINITY
            ? "negative-infinity"
            : datom.v,
      };
      return;
    case ValueTag.Str: {
      if (typeof datom.v !== "string") throw new TypeError("invalid logical string");
      if (datom.v.length <= MAX_STRING_PART_CODE_UNITS) {
        yield { type: "string", value: boundedText(datom.v) };
        return;
      }
      const chunks = Math.ceil(datom.v.length / MAX_STRING_PART_CODE_UNITS);
      const identity = await valuePartIdentity(
        "string",
        (function* () {
          for (const part of stringParts(datom.v as string)) yield utf16Bytes(part);
        })(),
      );
      let index = 0;
      for (const value of stringParts(datom.v)) {
        yield { type: "string-part", identity, index, chunks, value };
        index++;
      }
      return;
    }
    case ValueTag.Bool:
      if (typeof datom.v !== "boolean") throw new TypeError("invalid logical boolean");
      yield { type: "boolean", value: datom.v };
      return;
    case ValueTag.Ref:
      if (typeof datom.v !== "number" || !Number.isSafeInteger(datom.v) || datom.v < 0) {
        throw new TypeError("invalid logical reference");
      }
      yield { type: "ref", value: await encoder.entity(datom.v) };
      return;
    case ValueTag.Uuid:
      if (typeof datom.v !== "string") throw new TypeError("invalid logical uuid");
      yield { type: "uuid", value: datom.v };
      return;
    case ValueTag.Inst:
      if (typeof datom.v !== "number" || !Number.isSafeInteger(datom.v)) {
        throw new TypeError("invalid logical instant");
      }
      yield { type: "instant", value: datom.v };
      return;
    case ValueTag.Bytes: {
      if (!(datom.v instanceof Uint8Array)) throw new TypeError("invalid logical bytes");
      if (datom.v.byteLength <= MAX_REPLICATION_RAW_VALUE_PART_BYTES) {
        yield { type: "bytes", value: bytesToBase64(datom.v) };
        return;
      }
      const chunks = Math.ceil(
        datom.v.byteLength / MAX_REPLICATION_RAW_VALUE_PART_BYTES,
      );
      const identity = await valuePartIdentity("bytes", byteParts(datom.v));
      let index = 0;
      for (const part of byteParts(datom.v)) {
        yield {
          type: "bytes-part",
          identity,
          index,
          chunks,
          value: bytesToBase64(part),
        };
        index++;
      }
      return;
    }
  }
}

export async function* projectLogicalDatoms(
  db: Db,
  raw: Datom,
  encoder: LogicalIdentityEncoder,
): AsyncGenerator<SnapshotDatom, void, undefined> {
  const attribute = db.attr(raw.a);
  if (attribute === undefined || !attribute.ident.startsWith(":")) {
    throw new TypeError("authorized datom has no logical field identity");
  }
  const entity = await encoder.entity(raw.e);
  const field = boundedText(attribute.ident);
  for await (const value of projectLogicalValueParts(raw, encoder)) {
    yield Object.freeze({ entity, field, value, op: "add" as const });
  }
}

/** Current asserted authorized facts in stable physical scan order. */
export async function* logicalEntries(
  db: Db,
  encoder: LogicalIdentityEncoder,
  signal?: AbortSignal,
): AsyncGenerator<LogicalEntry, void, undefined> {
  throwIfAborted(signal);
  for await (const chunk of db.datoms(Index.EAVT, {})) {
    for (const raw of chunk) {
      throwIfAborted(signal);
      for await (const datom of projectLogicalDatoms(db, raw, encoder)) {
        throwIfAborted(signal);
        yield Object.freeze({ raw, datom });
      }
    }
  }
}

class LogicalStateHasher {
  private prior: Uint8Array<ArrayBuffer> = new Uint8Array(32);
  private block = "";
  private bytes = 0;

  async add(datom: SnapshotDatom): Promise<void> {
    const line = `${canonicalizeJson(datom as unknown as JsonValue)}\n`;
    const size = utf8.encode(line).byteLength;
    if (this.bytes > 0 && this.bytes + size > HASH_BLOCK_BYTES) {
      await this.flush();
    }
    this.block += line;
    this.bytes += size;
  }

  private async flush(): Promise<void> {
    const material = concat(this.prior, utf8.encode(this.block));
    const digest = await crypto.subtle.digest("SHA-256", material);
    this.prior = new Uint8Array(digest);
    this.block = "";
    this.bytes = 0;
  }

  async finish(): Promise<OpaqueReplicationId> {
    await this.flush();
    return opaqueDigest("ramose:replication:state:v1", this.prior);
  }
}

export const digestLogicalDb = async (
  db: Db,
  encoder: LogicalIdentityEncoder,
  signal?: AbortSignal,
): Promise<OpaqueReplicationId> => {
  const hasher = new LogicalStateHasher();
  for await (const entry of logicalEntries(db, encoder, signal)) {
    await hasher.add(entry.datom);
  }
  throwIfAborted(signal);
  return hasher.finish();
};

const compareRawFact = (left: Datom, right: Datom): number => {
  if (left.e !== right.e) return left.e < right.e ? -1 : 1;
  if (left.a !== right.a) return left.a < right.a ? -1 : 1;
  return compareValue(left.vt, left.v, right.vt, right.v);
};

const isValuePart = (
  value: SnapshotLogicalValue,
): value is
  | Extract<SnapshotLogicalValue, { readonly type: "string-part" }>
  | Extract<SnapshotLogicalValue, { readonly type: "bytes-part" }> =>
  value.type === "string-part" || value.type === "bytes-part";

const asChangeDatom = (
  datom: SnapshotDatom,
  op: LogicalDatom["op"],
): LogicalDatom | undefined =>
  isValuePart(datom.value)
    ? undefined
    : Object.freeze({ ...datom, value: datom.value, op });

const encodedBytes = (value: unknown): number =>
  utf8.encode(JSON.stringify(value)).byteLength;

export type LogicalDelta = {
  readonly previousStateDigest: OpaqueReplicationId;
  readonly stateDigest: OpaqueReplicationId;
  readonly datoms: readonly LogicalDatom[];
  readonly overflow: boolean;
};

export type SnapshotChunkFits = (
  datoms: readonly SnapshotDatom[],
  index: number,
) => boolean;

/** Merge two immutable authorized values without retaining either full value. */
export const diffLogicalDbs = async (
  previous: Db,
  current: Db,
  encoder: LogicalIdentityEncoder,
  signal?: AbortSignal,
): Promise<LogicalDelta> => {
  const before = logicalEntries(previous, encoder, signal)[Symbol.asyncIterator]();
  const after = logicalEntries(current, encoder, signal)[Symbol.asyncIterator]();
  const changes: LogicalDatom[] = [];
  let changeBytes = 0;
  let overflow = false;
  const hasher = new LogicalStateHasher();
  const previousHasher = new LogicalStateHasher();
  const appendChange = (datom: SnapshotDatom, op: LogicalDatom["op"]): void => {
    if (overflow) return;
    const change = asChangeDatom(datom, op);
    if (change === undefined) {
      overflow = true;
      return;
    }
    const size = encodedBytes(change);
    if (
      changes.length >= MAX_REPLICATION_DATOMS_PER_CHANGE ||
      changeBytes + size > MAX_REPLICATION_CHANGE_BYTES
    ) {
      overflow = true;
      return;
    }
    changes.push(change);
    changeBytes += size;
  };
  let left = await before.next();
  let right = await after.next();
  try {
    while (!left.done || !right.done) {
      if (left.done) {
        if (right.done) break;
        const added = right.value;
        await hasher.add(added.datom);
        appendChange(added.datom, "add");
        right = await after.next();
        continue;
      }
      if (right.done) {
        await previousHasher.add(left.value.datom);
        appendChange(left.value.datom, "retract");
        left = await before.next();
        continue;
      }
      const order = compareRawFact(left.value.raw, right.value.raw);
      if (order === 0) {
        await previousHasher.add(left.value.datom);
        await hasher.add(right.value.datom);
        left = await before.next();
        right = await after.next();
      } else if (order < 0) {
        await previousHasher.add(left.value.datom);
        appendChange(left.value.datom, "retract");
        left = await before.next();
      } else {
        await hasher.add(right.value.datom);
        appendChange(right.value.datom, "add");
        right = await after.next();
      }
    }
  } finally {
    await before.return?.();
    await after.return?.();
  }
  throwIfAborted(signal);
  return Object.freeze({
    previousStateDigest: await previousHasher.finish(),
    stateDigest: await hasher.finish(),
    datoms: Object.freeze(changes),
    overflow,
  });
};

/** Snapshot chunks retain only the current bounded chunk. */
export async function* snapshotEntryChunks(
  db: Db,
  encoder: LogicalIdentityEncoder,
  fits: SnapshotChunkFits,
  signal?: AbortSignal,
): AsyncGenerator<readonly LogicalEntry[], void, undefined> {
  let chunk: LogicalEntry[] = [];
  let index = 0;
  for await (const entry of logicalEntries(db, encoder, signal)) {
    if (
      chunk.length > 0 &&
      (chunk.length >= MAX_REPLICATION_DATOMS_PER_SNAPSHOT_CHUNK ||
        !fits([...chunk.map((item) => item.datom), entry.datom], index))
    ) {
      yield Object.freeze(chunk);
      chunk = [];
      index++;
    }
    if (!fits([entry.datom], index)) {
      throw new RangeError("one logical datom exceeds the snapshot frame bound");
    }
    chunk.push(entry);
  }
  if (chunk.length > 0) yield Object.freeze(chunk);
}

/** Re-check a delayed chunk against the newest complete authorized value. */
export const chunkStillAuthorized = async (
  current: Db,
  chunk: readonly LogicalEntry[],
  signal?: AbortSignal,
): Promise<boolean> => {
  for (const entry of chunk) {
    throwIfAborted(signal);
    const raw = entry.raw;
    const found = await current.first(Index.EAVT, {
      e: raw.e,
      a: raw.a,
      vt: raw.vt,
      v: raw.v as DatomValue,
    });
    if (found === undefined) return false;
    const attribute = current.attr(raw.a);
    if (attribute === undefined || attribute.ident !== entry.datom.field) return false;
  }
  throwIfAborted(signal);
  return true;
};
