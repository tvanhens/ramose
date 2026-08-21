/**
 * Durable overlay log: novelty + follow cursor + pending layers.
 *
 * Memory is the current-view store. This module is async durability of
 * the same snap — one RLG1 blob per confirmed `t`, a JSON meta blob for
 * `confirmedT` + the `t` index + pending. Hydrate rebuilds a Connection
 * from that log + cursor. Apply does not rewrite the full current-view
 * EAVT as JSON.
 *
 * Encode copies into bytes; decode allocates new objects. A "reload" is a
 * new overlay over the same store, never the same Connection identity.
 */

import {
  decodeLogChunk,
  encodeLogChunk,
  fromWireDatom,
  type LogEntry,
  toWireDatom,
  type WireDatom,
} from "../internal/core/log.ts";
import { parseJson, stringifyJson } from "../internal/core/json.ts";
import type { Datom } from "../internal/core/datom.ts";

export interface PendingSnap {
  readonly clientTxId: string;
  readonly tx: unknown[];
  readonly datoms: WireDatom[];
  readonly tempids: Record<string, number>;
}

/** In-memory / hydrate reconstruction of confirmed + the outbox. */
export interface OverlaySnap {
  readonly v: 1;
  readonly confirmedT: number;
  readonly confirmed: WireDatom[];
  readonly pending: readonly PendingSnap[];
}

/** Cursor + log index + outbox. One JSON blob; facts live in per-`t` RLG1. */
export interface OverlayMeta {
  readonly v: 2;
  readonly confirmedT: number;
  readonly ts: readonly number[];
  readonly pending: readonly PendingSnap[];
}

/** Novelty to append, the full `t` index, and optional stale blobs to drop. */
export interface PersistView {
  readonly confirmedT: number;
  readonly entries: readonly LogEntry[];
  readonly ts: readonly number[];
  readonly dropTs?: readonly number[];
  readonly pending: readonly PendingSnap[];
}

/** The storage seam. Keys are per-db. Values are opaque bytes. */
export interface ByteStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete?(key: string): Promise<void>;
}

const META_VERSION = 2 as const;

const asTempids = (value: unknown): Record<string, number> => {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
};

const pendingLayers = (value: unknown): PendingSnap[] => {
  if (!Array.isArray(value)) return [];
  const pending: PendingSnap[] = [];
  for (const p of value) {
    if (typeof p !== "object" || p === null) continue;
    const layer = p as Record<string, unknown>;
    if (typeof layer.clientTxId !== "string") continue;
    if (!Array.isArray(layer.tx) || !Array.isArray(layer.datoms)) continue;
    pending.push({
      clientTxId: layer.clientTxId,
      tx: layer.tx,
      datoms: layer.datoms as WireDatom[],
      tempids: asTempids(layer.tempids),
    });
  }
  return pending;
};

export const pendingToSnap = (layer: {
  readonly clientTxId: string;
  readonly tx: unknown[];
  readonly datoms: readonly Datom[];
  readonly tempids: Record<string, number>;
}): PendingSnap => ({
  clientTxId: layer.clientTxId,
  tx: layer.tx,
  datoms: layer.datoms.map(toWireDatom),
  tempids: { ...layer.tempids },
});

export const pendingFromSnap = (
  layer: PendingSnap,
): {
  clientTxId: string;
  tx: unknown[];
  datoms: Datom[];
  tempids: Record<string, number>;
} => ({
  clientTxId: layer.clientTxId,
  tx: layer.tx.slice(),
  datoms: layer.datoms.map(fromWireDatom),
  tempids: { ...layer.tempids },
});

/**
 * In-memory {@link ByteStore}. `get` returns a **copy**, so a reload cannot
 * share object identity with the bytes that were put.
 */
export const memoryStore = (): ByteStore => {
  const slots = new Map<string, Uint8Array>();
  return {
    get: async (key) => {
      const hit = slots.get(key);
      return hit === undefined ? undefined : hit.slice();
    },
    put: async (key, value) => {
      slots.set(key, value.slice());
    },
    delete: async (key) => {
      slots.delete(key);
    },
  };
};

/**
 * Origin-private OPFS. Missing `navigator.storage` (tests, Node, older
 * browsers) returns `undefined` — the caller falls through to memory or
 * a no-op. Same-origin; no credentials in the bytes.
 */
export const opfsStore = async (
  dir = "ramose",
): Promise<ByteStore | undefined> => {
  const storage = (
    globalThis as { navigator?: { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } } }
  ).navigator?.storage;
  if (typeof storage?.getDirectory !== "function") return undefined;
  let root: FileSystemDirectoryHandle;
  try {
    root = await storage.getDirectory();
    root = await root.getDirectoryHandle(dir, { create: true });
  } catch {
    return undefined;
  }
  return {
    get: async (key) => {
      try {
        const file = await root.getFileHandle(key);
        const blob = await file.getFile();
        return new Uint8Array(await blob.arrayBuffer());
      } catch {
        return undefined;
      }
    },
    put: async (key, value) => {
      const file = await root.getFileHandle(key, { create: true });
      const writable = await file.createWritable();
      await writable.write(new Uint8Array(value));
      await writable.close();
    },
    delete: async (key) => {
      try {
        await root.removeEntry(key);
      } catch {
        // missing is fine
      }
    },
  };
};

const sanitize = (name: string): string => name.replace(/[^a-zA-Z0-9._-]/g, "_");

export const persistKey = (name: string): string => `overlay.${sanitize(name)}`;

export const logKey = (name: string, t: number): string =>
  `overlay.${sanitize(name)}.t.${t}`;

export const encodeMeta = (meta: OverlayMeta): Uint8Array =>
  new TextEncoder().encode(
    stringifyJson({
      v: META_VERSION,
      confirmedT: meta.confirmedT,
      ts: meta.ts,
      pending: meta.pending,
    }),
  );

export const decodeMeta = (bytes: Uint8Array): OverlayMeta | undefined => {
  let raw: unknown;
  try {
    raw = parseJson(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.v !== META_VERSION) return undefined;
  if (typeof o.confirmedT !== "number" || !Number.isFinite(o.confirmedT)) {
    return undefined;
  }
  if (!Array.isArray(o.ts)) return undefined;
  const ts: number[] = [];
  for (const t of o.ts) {
    if (typeof t === "number" && Number.isFinite(t)) ts.push(t);
  }
  return {
    v: META_VERSION,
    confirmedT: o.confirmedT,
    ts,
    pending: pendingLayers(o.pending),
  };
};

export const loadSnap = async (
  store: ByteStore,
  name: string,
): Promise<OverlaySnap | undefined> => {
  const bytes = await store.get(persistKey(name));
  if (bytes === undefined) return undefined;
  const meta = decodeMeta(bytes);
  if (meta === undefined) return undefined;
  const confirmed: WireDatom[] = [];
  for (const t of meta.ts) {
    const blob = await store.get(logKey(name, t));
    if (blob === undefined) continue;
    try {
      for (const entry of decodeLogChunk(blob)) {
        for (const d of entry.datoms) confirmed.push(toWireDatom(d));
      }
    } catch {
      // a torn blob is skipped; cursor + the rest of the log still hydrate
    }
  }
  return {
    v: 1,
    confirmedT: meta.confirmedT,
    confirmed,
    pending: meta.pending,
  };
};

export const saveView = async (
  store: ByteStore,
  name: string,
  view: PersistView,
): Promise<void> => {
  for (const t of view.dropTs ?? []) {
    await store.delete?.(logKey(name, t));
  }
  for (const entry of view.entries) {
    await store.put(logKey(name, entry.t), encodeLogChunk([entry]));
  }
  await store.put(
    persistKey(name),
    encodeMeta({
      v: META_VERSION,
      confirmedT: view.confirmedT,
      ts: view.ts,
      pending: view.pending,
    }),
  );
};
