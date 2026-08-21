/**
 * Durable overlay snapshot: confirmed current-view + pending layers, as
 * bytes. OPFS is the browser page; tests inject a {@link ByteStore}
 * (memory or a temp dir). That is a storage seam, not a second database.
 *
 * Encode copies into bytes; decode allocates new objects. A "reload" is a
 * new overlay over the same store, never the same Connection identity.
 */

import {
  fromWireDatom,
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

/** Confirmed current-view + the outbox. What hydrate restores. */
export interface OverlaySnap {
  readonly v: 1;
  readonly confirmedT: number;
  readonly confirmed: WireDatom[];
  readonly pending: readonly PendingSnap[];
}

/** The storage seam. Keys are per-db (`<name>`). Values are opaque bytes. */
export interface ByteStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete?(key: string): Promise<void>;
}

const SNAP_VERSION = 1 as const;

export const encodeSnap = (snap: OverlaySnap): Uint8Array =>
  new TextEncoder().encode(stringifyJson({ ...snap, v: SNAP_VERSION }));

export const decodeSnap = (bytes: Uint8Array): OverlaySnap | undefined => {
  let raw: unknown;
  try {
    raw = parseJson(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.v !== SNAP_VERSION) return undefined;
  if (typeof o.confirmedT !== "number" || !Number.isFinite(o.confirmedT)) {
    return undefined;
  }
  if (!Array.isArray(o.confirmed) || !Array.isArray(o.pending)) return undefined;
  const pending: PendingSnap[] = [];
  for (const p of o.pending) {
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
  return {
    v: SNAP_VERSION,
    confirmedT: o.confirmedT,
    confirmed: o.confirmed as WireDatom[],
    pending,
  };
};

const asTempids = (value: unknown): Record<string, number> => {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
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

export const persistKey = (name: string): string =>
  `overlay.${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

export const loadSnap = async (
  store: ByteStore,
  name: string,
): Promise<OverlaySnap | undefined> => {
  const bytes = await store.get(persistKey(name));
  return bytes === undefined ? undefined : decodeSnap(bytes);
};

export const saveSnap = async (
  store: ByteStore,
  name: string,
  snap: OverlaySnap,
): Promise<void> => {
  await store.put(persistKey(name), encodeSnap(snap));
};
