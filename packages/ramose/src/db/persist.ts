/**
 * Durable overlay log: novelty + follow cursor + pending layers.
 *
 * Memory is the current-view store. This module is async durability of
 * the same snap — one RLG1 dump of the confirmed current-view, plus
 * per-`t` novelty blobs and a JSON meta blob for `confirmedT` + the `t`
 * index + pending. Hydrate prefers the dump so a torn per-`t` log (or a
 * persist that never `remember()`'d every fact that was on screen) still
 * first-paints the last view. Apply does not rewrite EAVT on notify.
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
  /**
   * Confirmed current-view as one RLG1 dump. Hydrate reads this first.
   * Per-`t` `entries` are incremental; the dump is what was on screen.
   */
  readonly dump?: readonly LogEntry[];
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
 * Page fallback when OPFS is missing or `getDirectory()` throws.
 * `get` is always `undefined`; `put` / `delete` are no-ops. A refresh
 * must not see a throwaway Map that looked like it persisted.
 */
export const noopStore = (): ByteStore => ({
  get: async () => undefined,
  put: async () => {},
  delete: async () => {},
});

/**
 * Origin-private OPFS. Missing `navigator.storage` (tests, Node, older
 * browsers) or a thrown `getDirectory()` returns `undefined` — the
 * caller must not swap in a fresh `memoryStore()`.
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

/** Origin lock so two tabs do not tear the same db's meta + per-`t` blobs. */
const withOriginLock = async <A>(
  name: string,
  fn: () => Promise<A>,
): Promise<A> => {
  const locks = (
    globalThis as {
      navigator?: {
        locks?: {
          request?: (n: string, cb: () => Promise<A>) => Promise<A>;
        };
      };
    }
  ).navigator?.locks;
  if (typeof locks?.request !== "function") return fn();
  return locks.request(`ramose.overlay.${sanitize(name)}`, fn);
};

export const persistKey = (name: string): string => `overlay.${sanitize(name)}`;

/** Last confirmed current-view as one RLG1 blob. Hydrate prefers this. */
export const snapKey = (name: string): string =>
  `overlay.${sanitize(name)}.snap`;

/** Page default: OPFS when it works. Never a silent fresh `memoryStore`. */
export const defaultStore = async (): Promise<ByteStore> =>
  (await opfsStore()) ?? noopStore();

/** Group confirmed facts by `t` for the dump blob / per-`t` log. */
export const entriesFromDatoms = (datoms: readonly Datom[]): LogEntry[] => {
  const groups = new Map<number, Datom[]>();
  for (const d of datoms) {
    let g = groups.get(d.t);
    if (g === undefined) {
      g = [];
      groups.set(d.t, g);
    }
    g.push(d);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, ds]) => ({ t, txInstant: 0, datoms: ds }));
};

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
): Promise<OverlaySnap | undefined> =>
  withOriginLock(name, async () => {
    const bytes = await store.get(persistKey(name));
    if (bytes === undefined) return undefined;
    const meta = decodeMeta(bytes);
    if (meta === undefined) return undefined;
    const confirmed: WireDatom[] = [];
    const fromSnap = new Set<number>();
    const dump = await store.get(snapKey(name));
    if (dump !== undefined) {
      try {
        for (const entry of decodeLogChunk(dump)) {
          fromSnap.add(entry.t);
          for (const d of entry.datoms) confirmed.push(toWireDatom(d));
        }
      } catch {
        // torn dump — fall through to per-`t` blobs
      }
    }
    if (typeof console !== "undefined" && console.debug !== undefined) {
      console.debug("[ramose persist] loadSnap", {
        name,
        dump: confirmed.length,
        ts: meta.ts.length,
        pending: meta.pending.length,
        confirmedT: meta.confirmedT,
      });
    }
    for (const t of meta.ts) {
      if (fromSnap.has(t)) continue;
      const blob = await store.get(logKey(name, t));
      if (blob === undefined) continue;
      try {
        for (const entry of decodeLogChunk(blob)) {
          for (const d of entry.datoms) confirmed.push(toWireDatom(d));
        }
      } catch {
        // a torn blob is skipped; the rest of the log still hydrates
      }
    }
    // Cursor-only meta (`ts: []` at a high confirmedT) or meta.ts whose
    // RLG1 blobs are all missing is not a successful snap. Returning it
    // would first-paint `[]` and walk `from` a cursor that has no facts.
    if (confirmed.length === 0) {
      if (meta.pending.length === 0) return undefined;
      return {
        v: 1,
        confirmedT: 0,
        confirmed,
        pending: meta.pending,
      };
    }
    return {
      v: 1,
      confirmedT: meta.confirmedT,
      confirmed,
      pending: meta.pending,
    };
  });

export const saveView = async (
  store: ByteStore,
  name: string,
  view: PersistView,
): Promise<void> =>
  withOriginLock(name, async () => {
    for (const t of view.dropTs ?? []) {
      await store.delete?.(logKey(name, t));
    }
    for (const entry of view.entries) {
      await store.put(logKey(name, entry.t), encodeLogChunk([entry]));
    }
    // The dump is the on-screen confirmed view. Write it before meta so a
    // refresh that lands mid-persist still hydrates from the previous dump
    // (meta still points at the last complete snap) or this one.
    if (view.dump !== undefined && view.dump.length > 0) {
      await store.put(snapKey(name), encodeLogChunk(view.dump));
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
    if (typeof console !== "undefined" && console.debug !== undefined) {
      console.debug("[ramose persist] saveView", {
        name,
        dump: view.dump?.reduce((n, e) => n + e.datoms.length, 0) ?? 0,
        entries: view.entries.length,
        ts: view.ts.length,
        confirmedT: view.confirmedT,
        pending: view.pending.length,
      });
    }
  });
