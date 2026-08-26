/**
 * `Db<C>` — one database, typed from its catalog.
 *
 * A db is a **value**: `ramose.db(name, catalog)` is pure, `asOf(t)` and
 * `history` are `Db -> ReadDb` with zero I/O, and `dbAfter` on a
 * {@link TxReport} is the same db (a min-`t` floor on HTTPS; the local
 * confirmed overlay on a session client). Nothing here names a transport:
 * a session client reads the overlay and writes through `POST /op`
 * (`db.run`); raw `POST /transact` is admin / seed / `writes: "all"`.
 * HTTPS-only clients POST reads and writes, and neither path is
 * reachable from the public surface.
 */

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { EffectDb, EffectOf, EffectReadDb } from "./effect-types.ts";
import { DATABASE_NAME_RE, invalidDatabaseName } from "./DatabaseName.ts";
import type { AnySchema } from "./Schema.ts";
import { type Eid, makeEid } from "./Eid.ts";
import { lowerEntityArg } from "./entityArg.ts";
import { schemaTx } from "./ensure.ts";
import {
  assembleInstalled,
  checkEvolution,
  installTx,
  occupancyIdents,
  occupancyQuery,
  installedCoreQuery,
  installedOptionalQuery,
  installedUniqueQuery,
  namespacesNeedingOccupancy,
  type InstalledAttr,
} from "./evolution.ts";
import {
  type DbError,
  type InstallOptions,
  InvalidRequest,
  NotOne,
} from "./Errors.ts";
export { IncompatibleSchema } from "./Errors.ts";
export type { InstallOptions, SchemaChange } from "./Errors.ts";
import type { AnyEntity } from "./Entity.ts";
import type {
  AnyOperation,
  OpReport,
  Operation,
  OperationInvocation,
  RunArg,
  RunEntity,
} from "./Operation.ts";
import { asPromise, fromStream } from "./promise.ts";
import { shareEqualDeep } from "./shareEqualDeep.ts";
import { runOperation } from "./run.ts";
import { compact, record } from "./http.ts";
import type { EntityRef } from "./idents.ts";
import {
  tryLowerQueryObject,
  type AnyQueryObject,
  type LoweredKernelQuery,
  type Page,
  type QueryObject,
} from "./query/index.ts";
import type { SessionPrincipal } from "./session.ts";
import {
  type IdentPullPattern,
  lowerPullPattern,
  type Pull,
  reshapePullResult,
  type ValidatePull,
} from "./Pull.ts";
import type { ConnectionStatus, Session } from "./session.ts";
import type { Subscription } from "./subscription.ts";

/**
 * What `db.query` / `db.live` can fail with. `.oneOrFail()` adds {@link NotOne}
 * when the peer answers zero or two rows. Every other query — a rows array,
 * `.one()`'s `row | null`, a cursor {@link Page}, a scalar aggregate — is
 * {@link DbError} only.
 */
export type QueryError<R = unknown> =
  | ([R] extends [readonly unknown[]]
      ? DbError
      : [null] extends [R]
        ? DbError
        : [R] extends [number]
          ? DbError
          : [R] extends [Page<unknown>]
            ? DbError
            : DbError | NotOne);

// ── the transport seam ─────────────────────────────────────────────────────

/**
 * @internal What a `Db` needs from the outside world. Supplied by
 * the hatch factory; deliberately not a public name — HTTP is Worker internals.
 */
export interface Wire {
  /** A read op: one session frame, or one HTTPS POST when there is no socket. */
  read(
    name: string,
    op: "q" | "pull",
    body: Record<string, unknown>,
    minT: number | undefined,
  ): EffectOf<unknown, DbError>;
  /** `POST /db/:name/transact`. Raw writer — admin / seed / `writes: "all"`. */
  transact(
    name: string,
    tx: readonly unknown[],
    clientTxId?: string,
  ): EffectOf<unknown, DbError>;
  /** `POST /db/:name/op`. The operations writer, always over HTTPS. */
  operation(
    name: string,
    invocation: OperationInvocation,
  ): EffectOf<unknown, DbError>;
  /**
   * Session overlay — confirmed follower + pending layers. Absent on an
   * HTTPS-only client, where reads stay on the peer and writes have no
   * optimistic layer. `makeDb` binds the catalog without opening a socket.
   */
  bindSchema?(name: string, schema: AnySchema): void;
  overlay?(name: string):
    | {
        transact(
          tx: readonly unknown[],
        ): EffectOf<
          {
            readonly t: number;
            readonly txEid: number;
            readonly datoms: unknown;
            readonly datomCount: number;
          },
          DbError
        >;
        run(args: {
          readonly invocation: OperationInvocation;
          readonly operation: AnyOperation;
          readonly schema: AnySchema;
          readonly principal: {
            readonly eid: number | null;
            readonly class: string;
          };
          readonly db: string;
        }): EffectOf<
          {
            readonly t: number;
            readonly txEid: number;
            readonly datomCount: number;
            readonly output: unknown;
            readonly clientOpId: string;
          },
          DbError
        >;
        /** View-visible mutation generation — captured at `view()`, not before the pass. */
        readonly epoch: number;
        /** Subscribe to overlay apply (pending / ack / inbound tx / resync). */
        onChange(cb: () => void): () => void;
      }
    | undefined;
  /** `GET /db/:name/info` — where the basis is. Always HTTPS: cheap, authoritative. */
  info(name: string): EffectOf<unknown, DbError>;
  /**
   * Who this connection is: `/info`'s `principal`, cached per session
   * generation — re-read on reconnect, and never cached while `eid` is `null`
   * (the row may be written at any moment).
   */
  principal(name: string): EffectOf<SessionPrincipal, DbError>;
  /** This database's session, opened lazily; `undefined` with no `WebSocket`. */
  session(name: string): Session | undefined;
}

// ── the public shapes ──────────────────────────────────────────────────────

/**
 * Who a session is, as the peer reports it: the principal's entity — `null`
 * until the policy's principal attribute has a row for this `sub` — and its
 * class (`"admin"` on a peer with no policy configured).
 */
export interface DbPrincipal<C extends AnySchema = AnySchema> {
  readonly eid: Eid<C> | null;
  readonly class: string;
}

/** What a committed transaction reports back. `dbAfter` reads your own writes. */
export interface TxReport<C extends AnySchema = AnySchema> {
  readonly t: number;
  readonly txEid: Eid<C>;
  readonly datomCount: number;
  /** The same db after the write — overlay at `t`, or a min-`t` fence on HTTPS. */
  readonly dbAfter: Db<C>;
}

/**
 * The pull pattern a subject accepts: a literate map, `Ramose.all(N)` (the
 * peer's wildcard row), or the ident-array escape.
 */
type PullPattern<C extends AnySchema, P> = [P] extends [readonly unknown[]]
  ? P & IdentPullPattern<C>
  : ValidatePull<C, P>;

export interface ReadDb<C extends AnySchema = AnySchema> {
  readonly name: string;
  readonly schema: C;

  /** Run a {@link QueryObject} once. Put values in the query
   * (`where({ title })`). The result is the query's terminal: the rows
   * array, one row (or `null`) after `one()` / `oneOrFail()`, a `Page`
   * after `after(cursor)`, a scalar after `Q.value(...)`. */
  query<Row, Out = readonly Row[]>(
    input: QueryObject<Row, Out>,
  ): Promise<Out>;

  /**
   * Stand a query up. On an overlay session, re-run when that overlay
   * mutates (`{ op: "tx" }` / `{ op: "resync" }` / local write) —
   * apply is the notify. HTTPS live (no overlay) still re-runs when the
   * session's `t` moves. A pinned view (`asOf` / `history`) emits once and
   * completes. A pass that returns the rows already emitted is not
   * emitted again: a write this query does not see is not a re-render.
   * Put values in the query.
   */
  live<Row, Out = readonly Row[]>(
    input: QueryObject<Row, Out>,
  ): Subscription<Out, QueryError<Out>>;

  /**
   * Project one entity. `null` when a required field is missing. The subject
   * is the shared {@link EntityRef} vocabulary — a branded eid, `{ id }`
   * row, tempid, lookup, or unbranded number.
   */
  pull<const P>(
    subject: EntityRef<C>,
    pattern: PullPattern<C, P>,
  ): Promise<Pull<C, P> | null>;

  /**
   * Stand a pull up: `live`'s exact contract over one entity. Overlay
   * re-runs when that overlay mutates; HTTPS live still fences on `t`.
   * Deduped by digest.
   * `null` (entity gone, or a required field missing) is a legitimate
   * emission — a retracted entity emits `null` and keeps standing. A
   * pinned view (`asOf` / `history`) emits once and completes.
   */
  livePull<const P>(
    subject: EntityRef<C>,
    pattern: PullPattern<C, P>,
  ): Subscription<Pull<C, P> | null, DbError>;

  /**
   * The basis this view reads at: for a live db, the peer's current `t`
   * (one `GET /db/:name/info`); for `asOf(t)`, `t` with no I/O. Observing a
   * newer basis bumps the session, so a standing `live` that missed a tick
   * re-runs — the same rule as a write.
   */
  basis(): Promise<{ readonly t: number }>;

  /** Read-only view as of transaction `t`. Pure. */
  asOf(t: number): ReadDb<C>;
  /** History view — asserts *and* retracts. Pure. */
  readonly history: ReadDb<C>;

  /**
   * Effect-returning variants of these methods (`Effect` / `Stream`).
   * Import `ramose/db/effect` for `layer` / `Databases`.
   */
  readonly effect: EffectReadDb<C>;
}

export interface Db<C extends AnySchema = AnySchema> extends ReadDb<C> {
  /**
   * Who this session is — the peer resolves `sub → eid` at its end, so no
   * query is needed to learn your own entity. A signed-in user is provisioned
   * at session establishment (`sub`, `role`, matching `ramose.attrs`). `eid`
   * is `null` for anonymous and service callers; a `null` is never cached.
   * A non-`null` answer is cached per session generation and re-read on
   * reconnect.
   */
  principal(): Promise<DbPrincipal<C>>;

  /**
   * Idempotent catalog upsert, as an ordinary transaction. Reads the
   * installed fields first and fails with {@link IncompatibleSchema} when a
   * value type, cardinality, uniqueness, or a new required field on
   * existing rows would change. Pass `{ allowIncompatible: [":ident"] }`
   * to apply those idents anyway.
   */
  install(options?: InstallOptions): Promise<TxReport<C>>;

  /**
   * Run a named operation. Decode input, apply the optimistic prefix (steps
   * before the first `op.effect`) as a pending layer, and POST the invocation.
   * A contextual operation (`on: Entity`) takes the entity as the second
   * argument. A *branded* cell of the wrong entity is rejected; an unbranded
   * number and a nominal `tempid("ada")` are deliberate hatches.
   * Lookups must use a unique attr of the `on` entity.
   *
   * A schema-less operation runs on any db. An operation bound with
   * `schema:` runs on a db that has at least that catalog's entity keys.
   */
  run<I, O, OC extends AnySchema = AnySchema>(
    operation: Operation<string, I, O, undefined, OC>,
    input: RunArg<C, OC, I>,
  ): Promise<OpReport<O, C>>;
  run<I, O, N extends AnyEntity, OC extends AnySchema = AnySchema>(
    operation: Operation<string, I, O, N, OC>,
    entity: RunArg<C, OC, RunEntity<C, N>>,
    input: I,
  ): Promise<OpReport<O, C>>;

  readonly effect: EffectDb<C>;
}

// ── implementation ─────────────────────────────────────────────────────────

/** The coordinates a read view carries. `minT` is the `dbAfter` floor. */
interface View {
  readonly asOf?: number | undefined;
  readonly history?: boolean | undefined;
  readonly minT?: number | undefined;
}

// ── the hook seam ──────────────────────────────────────────────────────────

/**
 * @internal What `ramose/react`'s hooks need that the public surface
 * deliberately does not say: a **structural** identity for a view (so
 * `db.asOf(t)` built inline in a render compares equal across renders
 * instead of re-subscribing — or looping — on every one), the pinned
 * coordinate (so `useBasis` answers an `asOf` view with no request), and the
 * session's wake (so `useBasis` re-reads the basis on every paint).
 *
 * It rides a registry symbol rather than an export so the public barrel
 * stays exactly what `db-portable.test.ts` asserts. The reader lives in
 * `packages/ramose/src/react/seam.ts` and must stay shape-compatible with this.
 */
export interface DbSeam {
  /**
   * Equal iff two views read the same coordinates over the same client.
   * This is the view half of a live subscription key:
   * `(viewKey, astKey)`.
   */
  readonly key: string;
  /** `asOf(t)`'s `t`; `undefined` on a live (or history) view. */
  readonly asOf: number | undefined;
  /**
   * Subscribe to the session's wakes (tx/resync, local writes, drops).
   * Returns the unsubscribe, or `undefined` on an HTTPS-only client, where
   * there is nothing to wake on.
   */
  readonly onWake: (cb: () => void) => (() => void) | undefined;
  /**
   * The highest basis the session has seen, `undefined` without a session —
   * so a waker can tell a wake that carries news from one it caused itself
   * (observing the basis bumps the session).
   */
  readonly t: () => number | undefined;
  /**
   * Session generation — 0 before a socket exists. A reconnect after a
   * terminal live error is new information.
   */
  readonly generation: () => number;
  /**
   * `"offline"` with no socket factory; otherwise the session's
   * {@link ConnectionStatus} (`"connecting"` until the first handshake).
   */
  readonly status: () => ConnectionStatus;
  /**
   * Standing query that emits the raw wire result — no take-unwrap, no
   * page-wrap. `useLive` shares this handle and applies each subscriber's
   * `finalize`.
   */
  readonly liveRaw: (
    query: AnyQueryObject,
  ) => Subscription<unknown, unknown>;
}

/** @internal The registry key {@link DbSeam} is attached under. */
export const DB_SEAM: symbol = Symbol.for("ramose.db.seam");

/**
 * @internal Raw `POST /transact` submit — admin / seed / test. Not on the
 * public `Db` or `EffectDb` shapes. App writes use {@link Db.run}.
 */
export const DB_SUBMIT: unique symbol = Symbol.for("ramose.db.submit");

/** One token per client, so views over different clients never compare equal. */
const clientTokens = new WeakMap<Wire, number>();
let nextClientToken = 1;

const attachSeam = (
  db: object,
  wire: Wire,
  name: string,
  view: View,
  liveRaw: DbSeam["liveRaw"],
): void => {
  let client = clientTokens.get(wire);
  if (client === undefined) {
    client = nextClientToken++;
    clientTokens.set(wire, client);
  }
  const seam: DbSeam = {
    key:
      `${client}/${name}` +
      `?asOf=${view.asOf ?? ""}&history=${view.history === true}` +
      `&minT=${view.minT ?? ""}`,
    asOf: view.asOf,
    onWake: (cb) => wire.session(name)?.onWake(cb),
    t: () => wire.session(name)?.t,
    generation: () => wire.session(name)?.generation ?? 0,
    status: () => wire.session(name)?.status ?? "offline",
    liveRaw,
  };
  (db as Record<symbol, unknown>)[DB_SEAM] = seam;
};

/**
 * One pass of a standing read: the emission, the basis `t` the peer
 * answered at (HTTPS wake fence), and — on an overlay — the overlay epoch
 * captured in the same turn as `view()`.
 */
interface Pass<A> {
  readonly value: A;
  readonly t: number;
  readonly viewed?: number | undefined;
}

/** The pause between `live` passes that failed non-terminally, in ms. */
const RETRY_MIN = 250;
const RETRY_MAX = 5000;

/**
 * Failures a standing query must not retry: re-running them changes nothing.
 * `Unauthorized` reaches here only after the session already re-read the token
 * and re-authenticated in place, so a second one is terminal.
 */
const terminal = (e: { readonly _tag: string }): boolean =>
  e._tag === "InvalidRequest" ||
  e._tag === "DatabaseNotFound" ||
  e._tag === "Unauthorized" ||
  e._tag === "QueryBudgetExceeded" ||
  e._tag === "NotOne" ||
  e._tag === "OperationRejected";

/** `[User.name, "Ada"]` and `[":user/name", "Ada"]` both lower to the wire form. */
const lowerSubject = (subject: unknown): unknown => lowerEntityArg(subject);

/** @internal Everything a `Db` and its `ReadDb` views share. */
const makeRead = <C extends AnySchema>(
  wire: Wire,
  name: string,
  schema: C,
  view: View,
  bad: InvalidRequest | undefined,
): EffectReadDb<C> => {
  const fenced = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    bad === undefined ? effect : Effect.fail(bad as E);

  const pullOne = (
    subject: unknown,
    pattern: unknown,
    minT: number | undefined,
  ): Effect.Effect<Pass<unknown>, DbError> =>
    wire
      .read(
        name,
        "pull",
        compact({
          eid: lowerSubject(subject),
          pattern: lowerPullPattern(pattern),
          asOf: view.asOf,
          history: view.history === true ? true : undefined,
        }),
        minT ?? view.minT,
      )
      .pipe(
        Effect.map((body) => {
          const rec = record(body);
          return {
            value: reshapePullResult(pattern, rec.result),
            t: typeof rec.t === "number" ? rec.t : 0,
            viewed: typeof rec.epoch === "number" ? rec.epoch : undefined,
          };
        }),
      );

  const runQuery = (
    input: AnyQueryObject,
    minT: number | undefined,
    raw = false,
  ): Effect.Effect<
    {
      readonly rows: unknown;
      readonly t: number;
      readonly viewed?: number | undefined;
    },
    DbError | NotOne
  > =>
    Effect.gen(function* () {
      let lowered: LoweredKernelQuery;
      try {
        lowered = tryLowerQueryObject(input);
      } catch (e) {
        return yield* Effect.fail(
          e instanceof InvalidRequest
            ? e
            : new InvalidRequest({
                message: e instanceof Error ? e.message : String(e),
              }),
        );
      }
      const reply = record(
        yield* wire.read(
          name,
          "q",
          compact({
            query: lowered.query,
            inputs: [],
            asOf: view.asOf,
            history: view.history === true ? true : undefined,
          }),
          minT ?? view.minT,
        ),
      );
      const t = typeof reply.t === "number" ? reply.t : 0;
      const viewed = typeof reply.epoch === "number" ? reply.epoch : undefined;
      // Shared `useLive` cache holds this raw wire result; each subscriber
      // applies its own `finalize` (take-unwrap / page-wrap / reshape).
      if (raw) return { rows: reply.result, t, viewed };
      // `finalize` applies the query's terminal too: a page wraps, a take
      // unwraps — an `oneOrFail()` miss comes back as the NotOne to fail with
      const rows = lowered.finalize(reply.result);
      if (rows instanceof NotOne) return yield* Effect.fail(rows);
      return { rows, t, viewed };
    });

  /**
   * Keep a standing query alive: re-run a pass that failed non-terminally
   * until it succeeds. This is not a transient policy — the wire's
   * `retryTransient` ladder already retried each Unavailable / NetworkError
   * attempt and only surfaces once spent — it is what happens *after* that
   * (an outage longer than the ladder), and for the failures the ladder does
   * not touch (a 5xx `InternalError`). Exponential pause, capped.
   */
  const withBackoff = <A, E extends { readonly _tag: string }>(
    attempt: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> => {
    const step = (wait: number): Effect.Effect<A, E> =>
      attempt.pipe(
        Effect.catch((e: E) => {
          if (terminal(e)) return Effect.fail(e);
          const next = wait === 0 ? RETRY_MIN : Math.min(wait * 2, RETRY_MAX);
          return Effect.sleep(next).pipe(Effect.andThen(() => step(next)));
        }),
      );
    return step(0);
  };

  /**
   * The standing loop `live` and `livePull` share: run a pass, emit when the
   * shared value is not `Object.is` the previous emission, sleep until the
   * overlay mutates (or the session's basis on HTTPS). Unchanged rows keep
   * their previous object identity (`shareEqualDeep`). What varies is only
   * the pass itself — a query for `live`, a pull for `livePull`.
   */
  const standing = <A, E extends { readonly _tag: string } = DbError>(
    runPass: (minT: number | undefined) => Effect.Effect<Pass<A>, E>,
  ): Stream.Stream<A, E> =>
    Stream.callback<A, E>((queue) =>
      Effect.gen(function* () {
        if (bad !== undefined) return yield* Queue.fail(queue, bad as unknown as E);
        const session = wire.session(name);
        const pinned = view.asOf !== undefined || view.history === true;
        // pinned reads stay on the peer — do not construct an overlay just
        // to decide the waiter. Overlay live is a function of that db.
        const overlay = !pinned ? wire.overlay?.(name) : undefined;
        const overlaid = overlay !== undefined;

        if (!pinned && session === undefined) {
          return yield* Queue.failCause(
            queue,
            Cause.die(
              new Error(
                "ramose: db.live needs the session socket — pass `webSocket` to Ramose.connect or Ramose.layer (or run where a global WebSocket exists)",
              ),
            ),
          );
        }

        const none: unique symbol = Symbol("none");
        let last: A | typeof none = none;
        for (;;) {
          const seen = session?.t ?? 0;
          const generation = session?.generation ?? 0;
          const httpsEpoch = session?.epoch ?? 0;
          // one pass; the wire ladder retries its transient attempts, and
          // withBackoff only re-runs the pass once that ladder is spent.
          // Overlay does not fence on session.t — live re-runs when that db
          // mutates. The viewed epoch is captured at view(), not here.
          const pass = yield* withBackoff(
            runPass(overlaid ? undefined : seen || undefined),
          );
          // reuse previous row objects when deep-equal; skip the tick when
          // the shared root is the previous emission
          const shared: A =
            last === none ? pass.value : shareEqualDeep(last, pass.value);
          if (last === none || shared !== last) {
            last = shared;
            yield* Queue.offer(queue, shared);
          }
          if (pinned || session === undefined) break;
          if (overlaid && overlay !== undefined) {
            yield* awaitOverlay(
              overlay,
              session,
              generation,
              pass.viewed ?? overlay.epoch,
            );
          } else {
            yield* awaitWake(session, generation, httpsEpoch, {
              minT: Math.max(seen, pass.t),
            });
          }
        }
        return yield* Queue.end(queue);
      }).pipe(
        Effect.catch((e: E) => Queue.fail(queue, e)),
      ),
    );

  const liveStanding = (
    input: AnyQueryObject,
    raw: boolean,
  ) =>
    standing<unknown, DbError | NotOne>((minT) =>
      runQuery(input, minT, raw).pipe(
        Effect.map((pass) => ({
          value: pass.rows,
          t: pass.t,
          viewed: pass.viewed,
        })),
      ),
    );

  const read: EffectReadDb<C> = {
    name,
    schema,

    query: ((input: AnyQueryObject) =>
      fenced(
        Effect.suspend(() =>
          runQuery(input, undefined).pipe(
            Effect.map((r) => r.rows),
          ),
        ),
      )) as EffectReadDb<C>["query"],

    live: ((input: AnyQueryObject) =>
      liveStanding(input, false)) as EffectReadDb<C>["live"],

    pull: ((subject: unknown, pattern: unknown) =>
      fenced(
        Effect.suspend(() =>
          pullOne(subject, pattern, undefined).pipe(
            Effect.map((pass) => pass.value),
          ),
        ),
      )) as EffectReadDb<C>["pull"],

    livePull: ((subject: unknown, pattern: unknown) =>
      standing((minT) => pullOne(subject, pattern, minT))) as EffectReadDb<
      C
    >["livePull"],

    // a pinned view answers from its own coordinate; a live view (history
    // included) asks the peer, not `session.t` — that is 0 before the first
    // frame and lags a fresh peer, while `/info` is authoritative and cheap
    basis: () =>
      fenced(
        view.asOf !== undefined
          ? Effect.succeed({ t: view.asOf })
          : Effect.suspend(() =>
              wire.info(name).pipe(
                Effect.map((body) => {
                  const raw = record(body).t;
                  const t = typeof raw === "number" ? raw : 0;
                  // an observed basis advances the whole connection: a
                  // standing `live` that missed a tick re-runs (as `transact`)
                  wire.session(name)?.bump(t);
                  return { t };
                }),
              ),
            ),
      ),

    asOf: (t: number) =>
      makeRead(wire, name, schema, { ...view, asOf: t }, bad),

    get history() {
      return makeRead(wire, name, schema, { ...view, history: true }, bad);
    },
  };
  // enumerable, so `makeDb`'s spread carries it onto the writable db too
  attachSeam(read, wire, name, view, (query) =>
    fromStream(liveStanding(query, true)),
  );
  return read;
};

/**
 * Overlay live: wait until that db mutates past the epoch this pass
 * viewed, or the socket drops. The viewed epoch is captured at `view()`,
 * so apply-then-notify cannot park a waiter on a newer epoch than the
 * rows it just read.
 */
const awaitOverlay = (
  overlay: {
    readonly epoch: number;
    onChange(cb: () => void): () => void;
  },
  session: Session,
  generation: number,
  viewed: number,
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      offChange();
      offWake();
      resume(Effect.void);
    };
    const news = () =>
      overlay.epoch !== viewed || session.generation !== generation;
    const offChange = overlay.onChange(() => {
      if (news()) settle();
    });
    const offWake = session.onWake(() => {
      if (news()) settle();
    });
    if (news()) settle();
    return Effect.sync(() => {
      done = true;
      offChange();
      offWake();
    });
  });

/**
 * HTTPS live: resolve when the session's basis moves past `minT`, the
 * socket drops (`generation`), or a paint nudge moves `epoch`. Overlay
 * live does not use this — it waits on the overlay db via
 * {@link awaitOverlay}.
 */
const awaitWake = (
  session: Session,
  generation: number,
  epoch: number,
  fence: { readonly minT?: number },
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      off();
      resume(Effect.void);
    };
    const news = () =>
      (fence.minT !== undefined && session.t > fence.minT) ||
      session.generation !== generation ||
      session.epoch !== epoch;
    const off = session.onWake(() => {
      if (news()) settle();
    });
    if (news()) settle();
    return Effect.sync(() => {
      done = true;
      off();
    });
  });

const copySeam = (from: object, to: object): void => {
  const seam = (from as Record<symbol, unknown>)[DB_SEAM];
  if (seam !== undefined) (to as Record<symbol, unknown>)[DB_SEAM] = seam;
};

const wrapRead = <C extends AnySchema>(inner: EffectReadDb<C>): ReadDb<C> => {
  const read = {
    name: inner.name,
    schema: inner.schema,
    query: ((input: AnyQueryObject) =>
      asPromise(
        (inner.query as (q: AnyQueryObject) => Effect.Effect<unknown, QueryError>)(
          input,
        ),
      )) as ReadDb<C>["query"],
    live: ((input: AnyQueryObject) =>
      fromStream(
        (inner.live as (q: AnyQueryObject) => Stream.Stream<unknown, QueryError>)(
          input,
        ),
      )) as ReadDb<C>["live"],
    pull: ((subject: unknown, pattern: unknown) =>
      asPromise(inner.pull(subject as never, pattern as never))) as ReadDb<
      C
    >["pull"],
    livePull: ((subject: unknown, pattern: unknown) =>
      fromStream(
        inner.livePull(subject as never, pattern as never),
      )) as ReadDb<C>["livePull"],
    basis: () => asPromise(inner.basis()),
    asOf: (t: number) => wrapRead(inner.asOf(t)),
    get history() {
      return wrapRead(inner.history);
    },
    effect: inner,
  } as ReadDb<C>;
  copySeam(inner, read);
  return read;
};

const wrapDb = <C extends AnySchema>(inner: EffectDb<C>): Db<C> => {
  const db = {
    ...wrapRead(inner),
    principal: () => asPromise(inner.principal()),
    install: (options?: InstallOptions) => asPromise(inner.install(options)),
    run: ((operation: AnyOperation, a: unknown, b?: unknown) =>
      asPromise(
        operation.on !== undefined
          ? inner.run(operation as never, a as never, b as never)
          : inner.run(operation as never, a as never),
      )) as Db<C>["run"],
    effect: inner,
  } as Db<C>;
  copySeam(inner, db);
  return db;
};

/** @internal `ramose.db(name, catalog)`. Pure: no request, no ensure, no socket. */
export const makeDb = <C extends AnySchema>(
  wire: Wire,
  name: string,
  schema: C,
  view: View = {},
): Db<C> => {
  // a bad name never reaches the peer; every operation fails `InvalidRequest`
  const bad = DATABASE_NAME_RE.test(name)
    ? undefined
    : invalidDatabaseName(name);

  // remember the catalog so the first session read can install schema
  // locally — must not open a socket (db() is pure)
  wire.bindSchema?.(name, schema);

  const submit = (
    tx: readonly unknown[],
  ): Effect.Effect<TxReport<C>, DbError> => {
    if (bad !== undefined) return Effect.fail(bad);
    const overlay = wire.overlay?.(name);
    if (overlay !== undefined) {
      return overlay.transact(tx).pipe(
        Effect.map((ack) => ({
          t: ack.t,
          txEid: makeEid<C>(ack.txEid),
          datomCount: ack.datomCount,
          // local confirmed db at `t` — no min-t fence, no refetch
          dbAfter: makeDb(wire, name, schema, view),
        })),
      );
    }
    return wire.transact(name, tx).pipe(
      Effect.map((body) => {
        const ack = record(body);
        const t = typeof ack.t === "number" ? ack.t : 0;
        // a write advances the whole connection: standing `live` re-runs
        wire.session(name)?.bump(t);
        return {
          t,
          txEid: makeEid<C>(
            typeof ack.txEid === "number" ? ack.txEid : 0,
          ),
          datomCount: Array.isArray(ack.datoms)
            ? ack.datoms.length
            : typeof ack.datoms === "number"
              ? ack.datoms
              : 0,
          dbAfter: makeDb(wire, name, schema, { ...view, minT: t }),
        };
      }),
    );
  };

  const read = makeRead(wire, name, schema, view, bad);
  const effectDb: EffectDb<C> = {
    ...read,

    principal: () =>
      bad !== undefined
        ? Effect.fail<DbError>(bad)
        : Effect.suspend(() => wire.principal(name)).pipe(
            Effect.map(
              (p): DbPrincipal<C> => ({
                eid: p.eid === null ? null : makeEid<C>(p.eid),
                class: p.class,
              }),
            ),
          ),

    install: (options?: InstallOptions) =>
      Effect.gen(function* () {
        if (bad !== undefined) return yield* Effect.fail(bad);
        // asOf pins the read to the peer — the overlay already has this
        // catalog applied locally, so a live query would not see the
        // installed set. A far-future t is the current basis.
        const snap = read.asOf(Number.MAX_SAFE_INTEGER);
        const [core, uniques, optionals] = yield* Effect.all([
          snap.query(installedCoreQuery),
          snap.query(installedUniqueQuery),
          snap.query(installedOptionalQuery),
        ]);
        const installed: InstalledAttr[] = assembleInstalled(
          core,
          uniques,
          optionals,
        );
        const desired = schemaTx(schema);
        const occupied = new Set<string>();
        for (const ns of namespacesNeedingOccupancy(desired, installed, options)) {
          const idents = occupancyIdents(installed, ns);
          if (idents.length === 0) continue;
          const hit = yield* snap.query(occupancyQuery(idents));
          if (hit !== null) occupied.add(ns);
        }
        const refused = checkEvolution(desired, installed, occupied, options);
        if (refused !== undefined) return yield* Effect.fail(refused);
        return yield* submit(installTx(desired, installed));
      }),

    run: ((operation: AnyOperation, a: unknown, b?: unknown) =>
      Effect.suspend(() => {
        const contextual = operation.on !== undefined;
        return runOperation(
          wire,
          name,
          schema,
          {
            ...(view.asOf !== undefined && { asOf: view.asOf }),
            ...(view.history !== undefined && { history: view.history }),
            ...(view.minT !== undefined && { minT: view.minT }),
          },
          bad,
          operation,
          contextual ? a : undefined,
          contextual ? b : a,
          makeDb,
        );
      })) as EffectDb<C>["run"],
  };
  (effectDb as EffectDb<C> & Record<typeof DB_SUBMIT, typeof submit>)[DB_SUBMIT] =
    submit;
  return wrapDb(effectDb);
};
