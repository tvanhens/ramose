/**
 * Session-client overlay: a confirmed log follower plus pending novelty
 * layers. HTTPS-only clients never construct one.
 *
 * The overlay view is the current-view store. Applying datoms (pending,
 * ack, inbound `{ op: tx }`, resync) is the notify — same step, after the
 * facts are visible to `view()`. Inbound confirmed datoms are already
 * assigned (`t`, eids) — `applyDatoms`, never `processTx`. Pending layers
 * stay off the confirmed log and are never sent to other sessions.
 *
 * First paint is hydrate: after disk restore, the Connection is the view
 * and notify runs so live can emit. `sync({ from: confirmedT })` is
 * catch-up — it does not hold `ready` / first `q`. A successful walk still
 * applies `{ op: tx }` / `{ op: resync }` and `flush()`es the outbox.
 */

import { Connection } from "../internal/core/conn.ts";
import { type Datom, Index, ValueTag } from "../internal/core/datom.ts";
import { Db as EngineDb } from "../internal/core/db.ts";
import { fromWireDatom, toWireDatom, type WireDatom } from "../internal/core/log.ts";
import { Novelty } from "../internal/core/novelty.ts";
import type { Schema } from "../internal/core/schema.ts";
import {
  QueryBudgetError,
  QueryError,
  query as engineQuery,
} from "../internal/core/query/engine.ts";
import { QueryParseError } from "../internal/core/query/parse.ts";
import {
  normalizePullPattern,
  pull as enginePull,
} from "../internal/core/query/pull.ts";
import { processTx, TxError } from "../internal/core/tx.ts";
import * as Effect from "effect/Effect";
import type { AnyCatalog } from "./Catalog.ts";
import { schemaTx } from "./ensure.ts";
import {
  type DbError,
  fromResponse,
  InternalError,
  InvalidRequest,
  isDatabaseError,
  NetworkError,
  QueryBudgetExceeded,
  TxRejected,
} from "./Errors.ts";
import { record, retryTransient } from "./http.ts";
import {
  type ByteStore,
  loadSnap,
  type OverlaySnap,
  pendingFromSnap,
  pendingToSnap,
  saveSnap,
} from "./persist.ts";
import type { Session } from "./session.ts";

export interface OverlayAck {
  readonly t: number;
  readonly txEid: number;
  readonly tempids: Record<string, number>;
  readonly datoms: WireDatom[];
  readonly datomCount: number;
  readonly clientTxId?: string;
}

export interface Overlay {
  /** Follow cursor: last walked `t` or snapshot dump `t`. Not max applied `t`. */
  readonly confirmedT: number;
  /**
   * Bumped in the same step as a view-visible mutation (pending, ack,
   * inbound `{ op: tx }`, resync). Live waits on this, not on a session
   * epoch snapshotted before `view()`.
   */
  readonly epoch: number;
  /** Fired after {@link epoch} moves — apply is the notify. */
  onChange(cb: () => void): () => void;
  ready(retry?: boolean): Effect.Effect<void, DbError>;
  read(
    op: "q" | "pull",
    body: Record<string, unknown>,
  ): Effect.Effect<unknown, DbError>;
  transact(tx: readonly unknown[]): Effect.Effect<OverlayAck, DbError>;
  handlePush(frame: Record<string, unknown>): Promise<void>;
  /** Confirmed current-view + pending layers — what persist writes. */
  snapshot(): Promise<OverlaySnap>;
  /**
   * POST every pending layer that is still the outbox (offline transact).
   * 409 / reject drops only that layer.
   */
  flush(): Promise<void>;
}

export interface OverlayOptions {
  readonly session: Session;
  readonly post: (
    tx: readonly unknown[],
    clientTxId: string,
  ) => Effect.Effect<unknown, DbError>;
  /** Installs catalog attrs locally so processTx / q can resolve idents. */
  readonly catalog?: AnyCatalog | undefined;
  /**
   * Schema maps when the caller has no catalog object (a SharedWorker
   * received `schemaTx` over the port). Same install as {@link catalog}.
   */
  readonly schema?: readonly unknown[] | undefined;
  /** Injected byte store. Hydrate on first `ready()`, persist after apply. */
  readonly store?: ByteStore | undefined;
  /** Persist key (`<db name>`). Required with {@link store}. */
  readonly name?: string | undefined;
}

interface PendingLayer {
  readonly clientTxId: string;
  tx: unknown[];
  datoms: Datom[];
  tempids: Record<string, number>;
}

const TX_EID_CAP = 2 ** 42;

const asWireDatoms = (value: unknown): WireDatom[] =>
  Array.isArray(value) ? (value as WireDatom[]) : [];

const asTempids = (value: unknown): Record<string, number> => {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
};

const clientTxId = (): string =>
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const rewriteTempid = (value: unknown, ids: Record<string, number>): unknown =>
  typeof value === "string" && ids[value] !== undefined ? ids[value] : value;

const isLookupRef = (value: unknown): value is readonly [string, unknown] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === "string" &&
  value[0].startsWith(":");

const forwardIdent = (ident: string): string => {
  const slash = ident.lastIndexOf("/");
  return slash >= 0 && ident[slash + 1] === "_"
    ? ident.slice(0, slash + 1) + ident.slice(slash + 2)
    : ident;
};

const isRefAttr = (schema: Schema | undefined, a: unknown): boolean => {
  if (schema === undefined) return false;
  if (typeof a === "number") return schema.attr(a)?.valueType === ValueTag.Ref;
  if (typeof a !== "string") return false;
  return schema.attr(forwardIdent(a))?.valueType === ValueTag.Ref;
};

/** Rewrite a tempid only in entity / ref positions — never a scalar like a title. */
const rewriteEntityForm = (
  value: unknown,
  ids: Record<string, number>,
  schema: Schema | undefined,
): unknown => {
  if (isLookupRef(value)) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return rewriteMap(value as Record<string, unknown>, ids, schema);
  }
  return rewriteTempid(value, ids);
};

const rewriteMap = (
  m: Record<string, unknown>,
  ids: Record<string, number>,
  schema: Schema | undefined,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === ":db/id") {
      out[k] = rewriteEntityForm(v, ids, schema);
    } else if (isRefAttr(schema, k)) {
      out[k] = Array.isArray(v) && !isLookupRef(v)
        ? v.map((x) => rewriteEntityForm(x, ids, schema))
        : rewriteEntityForm(v, ids, schema);
    } else {
      out[k] = v;
    }
  }
  return out;
};

const rewriteTx = (
  tx: readonly unknown[],
  ids: Record<string, number>,
  schema: Schema | undefined,
): unknown[] =>
  tx.map((item) => {
    if (Array.isArray(item)) {
      const [op, e, a, v] = item as unknown[];
      if (op === ":db/retractEntity") return [op, rewriteEntityForm(e, ids, schema)];
      if (op === ":db/add" || op === ":db/retract") {
        const next: unknown[] = [op, rewriteEntityForm(e, ids, schema), a];
        if (item.length >= 4) {
          next.push(isRefAttr(schema, a) ? rewriteEntityForm(v, ids, schema) : v);
        }
        return next;
      }
      return item;
    }
    if (item !== null && typeof item === "object") {
      return rewriteMap(item as Record<string, unknown>, ids, schema);
    }
    return item;
  });

const factKey = (d: Datom): string => `${d.a}\0${JSON.stringify(d.v)}\0${d.op}`;

const rewriteEid = (e: number, eids: Map<number, number>): number =>
  eids.get(e) ?? e;

const rewriteDatoms = (datoms: readonly Datom[], eids: Map<number, number>): Datom[] => {
  if (eids.size === 0) return datoms as Datom[];
  return datoms.map((d) => {
    const e = rewriteEid(d.e, eids);
    const v =
      typeof d.v === "number" && eids.has(d.v) ? eids.get(d.v)! : d.v;
    return e === d.e && v === d.v ? d : { ...d, e, v };
  });
};

const classifyQuery = (err: unknown): DbError => {
  if (isDatabaseError(err)) return err;
  if (err instanceof QueryBudgetError) {
    return new QueryBudgetExceeded({
      message: err.message,
      code: err.code,
      clause: err.clause,
      cells: err.cells,
      limit: err.limit,
    });
  }
  if (err instanceof QueryParseError || err instanceof QueryError) {
    return new InvalidRequest({ message: err.message });
  }
  return new InternalError({
    message: err instanceof Error ? err.message : String(err),
  });
};

const classifyTx = (err: unknown): DbError => {
  if (isDatabaseError(err)) return err;
  if (err instanceof TxError) {
    return new TxRejected({ message: err.message, code: err.code });
  }
  return new InternalError({
    message: err instanceof Error ? err.message : String(err),
  });
};

const unknownPullAttrs = (db: EngineDb, pattern: { kind: string; attr?: string }[]): string[] => {
  const out: string[] = [];
  const walk = (p: { kind: string; attr?: string; sub?: unknown }[]): void => {
    for (const spec of p) {
      if (spec.kind !== "attr" || spec.attr === undefined || spec.attr === ":db/id") continue;
      if (db.attr(spec.attr) === undefined) out.push(spec.attr);
      if (Array.isArray(spec.sub)) walk(spec.sub as { kind: string; attr?: string; sub?: unknown }[]);
    }
  };
  walk(pattern);
  return out;
};

const overlayDb = (confirmed: EngineDb, extra: readonly Datom[]): EngineDb => {
  if (extra.length === 0) return confirmed;
  const nov = new Novelty();
  const avet = (a: number) => confirmed.schema.isAvet(a);
  const vaet = (a: number) => confirmed.schema.isVaet(a);
  nov.add(confirmed.novelty.byIndex[Index.EAVT].all(), avet, vaet);
  nov.add(extra, avet, vaet);
  let basisT = confirmed.basisT;
  for (const d of extra) if (d.t > basisT) basisT = d.t;
  return new EngineDb({
    store: confirmed.store,
    roots: confirmed.roots,
    novelty: nov,
    basisT,
    schema: confirmed.schema,
    nextEid: confirmed.nextEid,
  });
};

const installSchema = async (
  next: Connection,
  options: OverlayOptions,
): Promise<void> => {
  const tx =
    options.catalog !== undefined
      ? (schemaTx(options.catalog) as unknown[])
      : options.schema !== undefined
        ? [...options.schema]
        : undefined;
  if (tx !== undefined && tx.length > 0) await next.transact(tx);
};

export const openOverlay = (options: OverlayOptions): Overlay => {
  const pending: PendingLayer[] = [];
  /** Layers whose POST has not succeeded — the outbox. Same array as pending. */
  const unsent = new Set<string>();
  let conn: Connection | undefined;
  let confirmedT = 0;
  /** `t` values whose facts are already in the follower. Used so a late
   * lower-`t` frame still applies after a higher `t` was painted, and so
   * empty/count-only stamps cannot skip a later real inbound at the same `t`. */
  const factTs = new Set<number>();
  let epoch = 0;
  let readyGen = -1;
  /** Non-network catch-up failure (e.g. Unauthorized). First paint already
   * happened; the next `ready()` surfaces it. Cleared on a new generation. */
  let walkFail: DbError | undefined;
  let opening: Promise<void> | undefined;
  let applied: Promise<void> = Promise.resolve();
  let applyQueued = 0;
  let outbox: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();

  /**
   * Orderer only. An idle, sync `fn` (a `{ op: tx }` with a ready
   * follower) runs before this returns — apply is the notify. A busy
   * queue (in-flight resync) defers `fn` onto the tail.
   */
  const enqueueApply = (fn: () => void | Promise<void>): Promise<void> => {
    if (applyQueued === 0) {
      applyQueued = 1;
      try {
        const result = fn();
        if (result === undefined) {
          applyQueued -= 1;
          return Promise.resolve();
        }
        const done = Promise.resolve(result).finally(() => {
          applyQueued -= 1;
        });
        applied = done.then(() => undefined, () => undefined);
        return done;
      } catch (err) {
        applyQueued -= 1;
        return Promise.reject(err);
      }
    }
    applyQueued += 1;
    const next = applied.then(fn, fn).finally(() => {
      applyQueued -= 1;
    });
    applied = next.then(() => undefined, () => undefined);
    return next;
  };

  const takeSnapshot = async (): Promise<OverlaySnap> => {
    const confirmed: WireDatom[] = [];
    if (conn !== undefined) {
      for await (const chunk of conn.db().datoms(Index.EAVT, {})) {
        for (const d of chunk) confirmed.push(toWireDatom(d));
      }
    }
    return {
      v: 1,
      confirmedT,
      confirmed,
      pending: pending.map(pendingToSnap),
    };
  };

  /** Apply is the notify: persist matches `view()`, then epoch moves. */
  const notify = (): void => {
    epoch += 1;
    options.session.nudge();
    for (const cb of [...listeners]) cb();
  };

  const persistThenNotify = (): void | Promise<void> => {
    const store = options.store;
    const name = options.name;
    if (store === undefined || name === undefined) {
      notify();
      return;
    }
    return takeSnapshot().then(async (snap) => {
      await saveSnap(store, name, snap);
      notify();
    });
  };

  const pendingDatoms = (): Datom[] => {
    const out: Datom[] = [];
    for (const layer of pending) out.push(...layer.datoms);
    return out;
  };

  const view = (): EngineDb => {
    if (conn === undefined) {
      throw new Error("ramose: overlay view before the follower is ready");
    }
    return overlayDb(conn.db(), pendingDatoms());
  };

  const nextEid = (): number => {
    let n = conn?.nextEntityId ?? 1000;
    for (const layer of pending) {
      for (const d of layer.datoms) {
        if (d.e < TX_EID_CAP && d.e >= n) n = d.e + 1;
      }
    }
    return n;
  };

  /** Paint server facts into the follower without claiming a log prefix. */
  const paintFacts = (datoms: readonly Datom[]): void => {
    if (conn === undefined || datoms.length === 0) return;
    const fresh = datoms.filter((d) => !factTs.has(d.t));
    if (fresh.length === 0) return;
    conn.applyDatoms(fresh);
    for (const d of fresh) factTs.add(d.t);
  };

  /**
   * `{ op: "tx" }` paints by the datom's `t`. It does **not** move the follow
   * cursor: own echo of N+1 must not claim the prefix (a still-queued N would
   * then be skipped by `sync({ from })`). `confirmedT` moves on a walked
   * sync reply or a snapshot dump.
   */
  const applyConfirmed = (datoms: readonly Datom[]): void => {
    if (conn === undefined) return;
    paintFacts(datoms);
  };

  const replaceConfirmed = async (datoms: readonly Datom[], t: number): Promise<void> => {
    const next = await Connection.fromDatoms(datoms);
    await installSchema(next, options);
    conn = next;
    confirmedT = t;
    factTs.clear();
    for (const d of datoms) factTs.add(d.t);
    options.session.bump(t);
  };

  const remapQueued = (
    acked: Record<string, number>,
    local: Record<string, number>,
  ): void => {
    const eids = new Map<number, number>();
    for (const [tmp, serverEid] of Object.entries(acked)) {
      const was = local[tmp];
      if (typeof was === "number") eids.set(was, serverEid);
    }
    // only rewrite tempid *strings* a queued item referred to and did not mint
    const referred: Record<string, number> = {};
    for (const [tmp, serverEid] of Object.entries(acked)) {
      referred[tmp] = serverEid;
    }
    for (const layer of pending) {
      const foreign: Record<string, number> = {};
      for (const [tmp, serverEid] of Object.entries(referred)) {
        if (layer.tempids[tmp] === undefined) foreign[tmp] = serverEid;
      }
      if (Object.keys(foreign).length > 0) {
        layer.tx = rewriteTx(layer.tx, foreign, conn?.db().schema);
      }
      layer.datoms = rewriteDatoms(layer.datoms, eids);
      for (const [tmp, e] of Object.entries(layer.tempids)) {
        layer.tempids[tmp] = eids.get(e) ?? e;
      }
    }
  };

  const dropLayer = (clientTxId: string): PendingLayer | undefined => {
    const i = pending.findIndex((l) => l.clientTxId === clientTxId);
    if (i < 0) return undefined;
    unsent.delete(clientTxId);
    return pending.splice(i, 1)[0];
  };

  const remapDropped = (layer: PendingLayer, incoming: readonly Datom[]): void => {
    const serverE = new Map<string, number>();
    for (const d of incoming) {
      if (d.e < TX_EID_CAP) serverE.set(factKey(d), d.e);
    }
    const eids = new Map<number, number>();
    for (const d of layer.datoms) {
      if (d.e >= TX_EID_CAP) continue;
      const e = serverE.get(factKey(d));
      if (e !== undefined && d.e !== e) eids.set(d.e, e);
    }
    const acked: Record<string, number> = {};
    for (const [tmp, e] of Object.entries(layer.tempids)) {
      acked[tmp] = eids.get(e) ?? e;
    }
    remapQueued(acked, layer.tempids);
  };

  /**
   * Inbound `{ op: "tx" }` may land before the HTTP ack. Covering is by
   * `clientTxId` on the writer's own echo — a sieved subset still drops that
   * layer. Fact-set equality is not used: another session's overlapping
   * a/v/op must not drop this session's pending.
   */
  const dropCoveredPending = (
    incoming: readonly Datom[],
    coveredId?: string,
  ): void => {
    if (typeof coveredId !== "string" || coveredId.length === 0) return;
    const layer = dropLayer(coveredId);
    if (layer !== undefined) remapDropped(layer, incoming);
  };

  const hydrate = async (snap: OverlaySnap): Promise<void> => {
    await replaceConfirmed(
      snap.confirmed.map(fromWireDatom),
      snap.confirmedT,
    );
    pending.length = 0;
    unsent.clear();
    for (const layer of snap.pending) {
      const restored = pendingFromSnap(layer);
      pending.push(restored);
      unsent.add(restored.clientTxId);
    }
  };

  const ensureConn = async (): Promise<void> => {
    if (conn !== undefined) return;
    if (options.store !== undefined && options.name !== undefined) {
      const snap = await loadSnap(options.store, options.name);
      if (snap !== undefined) {
        await hydrate(snap);
        return;
      }
    }
    conn = await Connection.create();
    await installSchema(conn, options);
  };

  const requestSync = () =>
    Effect.tryPromise({
      try: () =>
        options.session.request({
          op: "sync",
          from: confirmedT,
        }),
      catch: (cause) =>
        isDatabaseError(cause)
          ? cause
          : new NetworkError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    }).pipe(
      Effect.flatMap((got) =>
        got.status >= 400
          ? Effect.fail(
              fromResponse(got.status, got.body, {
                get: (h) => got.headers?.[h.toLowerCase()] ?? null,
              }),
            )
          : Effect.succeed(got),
      ),
    );

  const painted = (): boolean => confirmedT > 0 || pending.length > 0;

  const sync = async (retry = true): Promise<void> => {
    await ensureConn();
    try {
      // A hydrated view is already the database. One walk attempt, then
      // offline-ready — do not sit on the retry ladder before notify.
      const reply = await Effect.runPromise(
        retry && !painted()
          ? retryTransient(requestSync, { while: () => !options.session.closed })
          : requestSync(),
      );
      readyGen = options.session.generation;
      // Frames from this walk are queued on `applied`. Stamp the follow cursor
      // only after they run, and only to the worker's walked `t` — not a log
      // tip the worker jumped to. A resync dump already stamped via replaceConfirmed.
      await applied;
      const t = record(reply.body).t;
      if (typeof t === "number" && t > confirmedT) {
        confirmedT = t;
        options.session.bump(t);
      }
      await flush();
    } catch (cause) {
      const fail = isDatabaseError(cause)
        ? cause
        : new NetworkError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          });
      // Hydrated follower is the offline database. A walk that cannot
      // reach the peer is not a failed boot — pending stays the outbox.
      if (fail._tag === "NetworkError" && !options.session.closed && painted()) {
        walkFail = undefined;
        readyGen = options.session.generation;
        return;
      }
      // Auth / request failure after paint is not a loader — stamp it
      // and notify so live can keep the last rows and surface the error.
      if (painted() && !options.session.closed) {
        walkFail = fail;
        readyGen = options.session.generation;
        notify();
        return;
      }
      throw fail;
    }
  };

  /**
   * Catch-up only. First paint does not await this. A painted follower
   * swallows walk failure so an un-awaited kick is not an unhandled
   * rejection — closed still fails the next `ready()`.
   */
  const kickWalk = (retry: boolean, hold: boolean): Promise<void> => {
    if (readyGen === options.session.generation && conn !== undefined) {
      return Promise.resolve();
    }
    if (opening !== undefined) return opening;
    const started = sync(retry)
      .catch((err) => {
        if (hold) return;
        throw err;
      })
      .finally(() => {
        if (opening === started) opening = undefined;
      });
    opening = started;
    return started;
  };

  const ready: Overlay["ready"] = (retry = true) =>
    Effect.tryPromise({
      try: async () => {
        if (options.session.closed) {
          throw new NetworkError({ message: "ramose: the client is closed" });
        }
        if (
          walkFail !== undefined &&
          readyGen === options.session.generation
        ) {
          throw walkFail;
        }
        walkFail = undefined;
        const first = conn === undefined;
        await ensureConn();
        // Hydrate is the view. Notify so live can emit those rows, then
        // kick `sync({ from: confirmedT })` without holding first paint.
        if (first && painted()) notify();
        const hold = painted();
        const walk = kickWalk(retry, hold);
        if (hold) return;
        await walk;
        await applied;
      },
      catch: (cause) =>
        isDatabaseError(cause)
          ? cause
          : new NetworkError({
              message:
                cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    });

  const read: Overlay["read"] = (op, body) =>
    // Capture epoch before `ready()` kicks a catch-up walk. A 401 notify
    // during that walk must be newer than this pass so live re-runs and
    // surfaces `walkFail` — capturing after the notify parks on it forever.
    // Older than `view()` is safe (one extra pass); newer is the missed wake.
    Effect.sync(() => epoch).pipe(
      Effect.flatMap((viewed) =>
        ready().pipe(
          Effect.flatMap(() =>
            Effect.tryPromise({
              try: async () => {
                // Hydrated view is first paint. Do not join a catch-up
                // resync / `{ op: tx }` on `applied` — that walk is not a loader.
                const db = view();
                if (op === "pull") {
                  const pattern = normalizePullPattern(body.pattern);
                  const unknown = unknownPullAttrs(db, pattern as { kind: string; attr?: string }[]);
                  if (unknown.length > 0) {
                    throw new InvalidRequest({
                      message: `unknown attribute${unknown.length > 1 ? "s" : ""} in pull pattern: ${unknown.join(", ")}`,
                    });
                  }
                  const subject = body.eid;
                  const eid =
                    typeof subject === "number"
                      ? subject
                      : await db.entid(subject as number | string | [string, unknown]);
                  if (eid === undefined) {
                    return { t: confirmedT, result: null, epoch: viewed };
                  }
                  return {
                    t: confirmedT,
                    result: await enginePull(db, eid, pattern),
                    epoch: viewed,
                  };
                }
                const result = await engineQuery(
                  db,
                  body.query as object,
                  Array.isArray(body.inputs) ? body.inputs : [],
                );
                return { t: confirmedT, root: confirmedT, result, epoch: viewed };
              },
              catch: classifyQuery,
            }),
          ),
        ),
      ),
    );

  const ackOf = (
    body: unknown,
    id: string,
  ): OverlayAck => {
    const ack = record(body);
    const t = typeof ack.t === "number" ? ack.t : 0;
    const raw = ack.datoms;
    const datoms = Array.isArray(raw) ? (raw as WireDatom[]) : [];
    return {
      t,
      txEid: typeof ack.txEid === "number" ? ack.txEid : 0,
      tempids: asTempids(ack.tempids),
      datoms,
      datomCount:
        datoms.length > 0
          ? datoms.length
          : typeof ack.datoms === "number"
            ? ack.datoms
            : 0,
      clientTxId: typeof ack.clientTxId === "string" ? ack.clientTxId : id,
    };
  };

  /**
   * POST one pending layer. NetworkError keeps the layer (outbox). 409 /
   * reject drops only that layer. Same apply path as inbound `{ op: tx }`.
   */
  const postLayer = (
    id: string,
    fallbackTx: unknown[],
    resume?: (next: Effect.Effect<OverlayAck, DbError>) => void,
  ): Promise<void> =>
    Effect.runPromise(
      options.post(
        pending.find((l) => l.clientTxId === id)?.tx ?? fallbackTx,
        id,
      ),
    )
      .then(async (body) => {
        const ack = ackOf(body, id);
        await enqueueApply(() => {
          unsent.delete(id);
          const layer = dropLayer(id);
          if (ack.datoms.length > 0) paintFacts(ack.datoms.map(fromWireDatom));
          if (layer !== undefined) remapQueued(ack.tempids, layer.tempids);
          return persistThenNotify();
        });
        resume?.(Effect.succeed(ack));
      })
      .catch(async (err) => {
        const fail = isDatabaseError(err) ? err : classifyTx(err);
        if (fail._tag === "NetworkError") {
          // pending layer stays — flush() POSTs when the network is back
          resume?.(Effect.succeed(localAck(id)));
          return;
        }
        await enqueueApply(() => {
          unsent.delete(id);
          dropLayer(id);
          return persistThenNotify();
        });
        resume?.(Effect.fail(fail));
      });

  const localAck = (id: string): OverlayAck => {
    const layer = pending.find((l) => l.clientTxId === id);
    return {
      t: confirmedT,
      txEid: 0,
      tempids: layer?.tempids ?? {},
      datoms: (layer?.datoms ?? []).map(toWireDatom),
      datomCount: layer?.datoms.length ?? 0,
      clientTxId: id,
    };
  };

  const flush = async (): Promise<void> => {
    const ids = pending.filter((l) => unsent.has(l.clientTxId)).map((l) => l.clientTxId);
    for (const id of ids) {
      const layer = pending.find((l) => l.clientTxId === id);
      if (layer === undefined) continue;
      await new Promise<void>((resolve) => {
        const next = outbox.then(
          () =>
            postLayer(id, layer.tx, () => {
              resolve();
            }),
          () =>
            postLayer(id, layer.tx, () => {
              resolve();
            }),
        );
        outbox = next.catch(() => undefined);
      });
    }
  };

  const transact: Overlay["transact"] = (tx) =>
    ready(false).pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const expansion = yield* Effect.tryPromise({
            try: () =>
              processTx(
                view(),
                tx as unknown[],
                // Fake local `t` only — not a dense log assignment. Must sit
                // above painted server facts (`factTs`) as well as `confirmedT`,
                // or a later pending layer collides with an ack we did not
                // stamp as prefix.
                Math.max(confirmedT, ...factTs, 0) + pending.length + 1,
                nextEid(),
                Date.now(),
              ),
            catch: classifyTx,
          });

          const id = clientTxId();
          pending.push({
            clientTxId: id,
            tx: tx as unknown[],
            datoms: expansion.datoms,
            tempids: expansion.tempids,
          });
          unsent.add(id);
          yield* Effect.promise(() => Promise.resolve(persistThenNotify()));

          const posted = yield* Effect.callback<OverlayAck, DbError>((resume) => {
            const run = () => postLayer(id, tx as unknown[], resume);
            const next = outbox.then(run, run);
            outbox = next.catch(() => undefined);
            return Effect.void;
          });
          return posted;
        }),
      ),
    );

  /** The one tx apply: paint, then notify. */
  const applyTx = (frame: Record<string, unknown>): void | Promise<void> => {
    const incoming = asWireDatoms(frame.datoms).map(fromWireDatom);
    applyConfirmed(incoming);
    dropCoveredPending(
      incoming,
      typeof frame.clientTxId === "string" ? frame.clientTxId : undefined,
    );
    return persistThenNotify();
  };

  const applyFrame = (frame: Record<string, unknown>): void | Promise<void> => {
    if (conn === undefined) {
      return ensureConn().then(() => applyFrame(frame));
    }
    if (frame.op === "resync") {
      pending.length = 0;
      unsent.clear();
      const t = typeof frame.t === "number" ? frame.t : 0;
      return replaceConfirmed(asWireDatoms(frame.datoms).map(fromWireDatom), t).then(
        () => persistThenNotify(),
      );
    }
    if (frame.op === "tx") return applyTx(frame);
  };

  const handlePush = (frame: Record<string, unknown>): Promise<void> =>
    enqueueApply(() => applyFrame(frame));

  options.session.onPush(handlePush);

  return {
    get confirmedT() {
      return confirmedT;
    },
    get epoch() {
      return epoch;
    },
    onChange: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    ready,
    read,
    transact,
    handlePush,
    snapshot: takeSnapshot,
    flush,
  };
};
