/**
 * `Db<C>` — one database, typed from its catalog.
 *
 * A db is a **value**: `ramose.db(name, catalog)` is pure, `asOf(t)` and
 * `history` are `Db -> ReadDb` with zero I/O, and `dbAfter` on a
 * {@link TxReport} is the same db (a min-`t` floor on HTTPS; the local
 * confirmed overlay on a session client). Nothing here names a transport:
 * a session client reads the overlay and writes `POST /transact` with a
 * pending layer; HTTPS-only clients POST reads and writes, and neither
 * path is reachable from the public surface.
 */

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { DATABASE_NAME_RE, invalidDatabaseName } from "./DatabaseName.ts";
import type { AnyCatalog } from "./Catalog.ts";
import { type CatalogEid, type Eid, makeEid } from "./Eid.ts";
import { schemaTx } from "./ensure.ts";
import type { Equal } from "./equal.ts";
import type { DbError, InvalidRequest } from "./Errors.ts";
import { NotOne, ParamError } from "./Errors.ts";
import { compact, record } from "./http.ts";
import type { LookupRef } from "./idents.ts";
import {
  asNavQuery,
  finalizeAggResult,
  finalizeNavPage,
  finalizeNavResult,
  lowerNavQuery,
  takeNavResult,
  type NavQuery,
  type NavQueryBuilder,
  type Page,
} from "./NavQuery.ts";
import type { AnyNamespace } from "./Namespace.ts";
import type { ParamArgs } from "./Params.ts";
import type { SessionPrincipal } from "./session.ts";
import {
  type IdentPullPattern,
  lowerPullPattern,
  type Pull,
  reshapePullResult,
  type ValidatePull,
} from "./Pull.ts";
import type { Session } from "./session.ts";
import {
  type Tx,
  txBuilder,
  type YieldContext,
  type YieldError,
} from "./Tx.ts";

/** A navigational query value, or the builder that makes one. */
export type QueryInput<R, P = never> =
  | NavQuery<R, P>
  | NavQueryBuilder<AnyNamespace, R, P>;

/**
 * The rows a query yields here. A query is scoped to a namespace, not to a
 * catalog, so a `.select`-less one types its ids against whichever catalog the
 * db that ran it carries — including after `.one()` / `.oneOrFail()`.
 */
type QueryRows<C extends AnyCatalog, R> = Equal<
  R,
  readonly Eid[]
> extends true
  ? readonly Eid<C>[]
  : Equal<R, Eid | null> extends true
    ? Eid<C> | null
    : Equal<R, Eid> extends true
      ? Eid<C>
      : R;

/**
 * What `db.q` / `db.live` can fail with. `.oneOrFail()` adds {@link NotOne}
 * when the peer answers zero or two rows; a parameterized query adds
 * {@link ParamError} for a missing / unknown / ill-typed binding. Every
 * other query — a rows array, `.one()`'s `row | null`, a cursor
 * {@link Page}, a scalar aggregate — is {@link DbError} only.
 */
export type QueryError<R = unknown, P = never> =
  | ([P] extends [never] ? never : ParamError)
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
 * `Databases.ts`; deliberately not a public name — HTTP is Worker internals.
 */
export interface Wire {
  /** A read op: one session frame, or one HTTPS POST when there is no socket. */
  read(
    name: string,
    op: "q" | "pull",
    body: Record<string, unknown>,
    minT: number | undefined,
  ): Effect.Effect<unknown, DbError>;
  /** `POST /db/:name/transact`. The one writer, always over HTTPS. */
  transact(
    name: string,
    tx: readonly unknown[],
    clientTxId?: string,
  ): Effect.Effect<unknown, DbError>;
  /**
   * Session overlay — confirmed follower + pending layers. Absent on an
   * HTTPS-only client, where reads stay on the peer and writes have no
   * optimistic layer. `makeDb` binds the catalog without opening a socket.
   */
  bindCatalog?(name: string, catalog: AnyCatalog): void;
  overlay?(name: string):
    | {
        transact(
          tx: readonly unknown[],
        ): Effect.Effect<
          {
            readonly t: number;
            readonly txEid: number;
            readonly datoms: unknown;
            readonly datomCount: number;
          },
          DbError
        >;
        /** View-visible mutation generation — captured at `view()`, not before the pass. */
        readonly epoch: number;
        /** `loadSnap` returned confirmed facts — a later JWT must not blank them. */
        readonly hasSnap: boolean;
        /** Opening `sync({ from })` has not finished. */
        readonly catchingUp: boolean;
        /** Subscribe to overlay apply (pending / ack / inbound tx / resync). */
        onChange(cb: () => void): () => void;
      }
    | undefined;
  /** `GET /db/:name/info` — where the basis is. Always HTTPS: cheap, authoritative. */
  info(name: string): Effect.Effect<unknown, DbError>;
  /**
   * Who this connection is: `/info`'s `principal`, cached per session
   * generation — re-read on reconnect, and never cached while `eid` is `null`
   * (the row may be written at any moment).
   */
  principal(name: string): Effect.Effect<SessionPrincipal, DbError>;
  /** This database's session, opened lazily; `undefined` with no `WebSocket`. */
  session(name: string): Session | undefined;
}

// ── the public shapes ──────────────────────────────────────────────────────

/**
 * Who a session is, as the peer reports it: the principal's entity — `null`
 * until the policy's principal attribute has a row for this `sub` — and its
 * class (`"admin"` on a peer with no policy configured).
 */
export interface DbPrincipal<C extends AnyCatalog = AnyCatalog> {
  readonly eid: Eid<C> | null;
  readonly class: string;
}

/** What a committed transaction reports back. `dbAfter` reads your own writes. */
export interface TxReport<C extends AnyCatalog = AnyCatalog> {
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
type PullPattern<C extends AnyCatalog, P> = [P] extends [readonly unknown[]]
  ? P & IdentPullPattern<C>
  : ValidatePull<C, P>;

export interface ReadDb<C extends AnyCatalog = AnyCatalog> {
  readonly name: string;
  readonly catalog: C;

  /** Run a {@link NavQuery} once. Bind params as the second argument. */
  q<R>(
    input: NavQuery<R, never> | NavQueryBuilder<AnyNamespace, R, never>,
  ): Effect.Effect<QueryRows<C, R>, QueryError<R, never>>;
  q<R, P = never>(
    input: QueryInput<R, P>,
    ...params: ParamArgs<P>
  ): Effect.Effect<QueryRows<C, R>, QueryError<R, P>>;

  /**
   * Stand a query up. On an overlay session, re-run when that overlay
   * mutates (`{ op: "tx" }` / `{ op: "resync" }` / local `transact`) —
   * apply is the notify. HTTPS live (no overlay) still re-runs when the
   * session's `t` moves. Requirements are `never` — teardown is fiber
   * interruption — and a pinned view (`asOf` / `history`) emits once and
   * completes. A pass that returns the rows already emitted is not
   * emitted again: a write this query does not see is not a re-render.
   * Bind params as the second argument.
   */
  live<R>(
    input: NavQuery<R, never> | NavQueryBuilder<AnyNamespace, R, never>,
  ): Stream.Stream<QueryRows<C, R>, QueryError<R, never>>;
  live<R, P = never>(
    input: QueryInput<R, P>,
    ...params: ParamArgs<P>
  ): Stream.Stream<QueryRows<C, R>, QueryError<R, P>>;

  /**
   * Project one entity. `null` when a required field is missing. The subject
   * is an `Eid<C>`, a namespace-branded row cell (`select({ id: N.id })`),
   * or a lookup ref.
   */
  pull<const P>(
    subject: Eid<C> | CatalogEid<C> | LookupRef<C>,
    pattern: PullPattern<C, P>,
  ): Effect.Effect<Pull<C, P> | null, DbError>;

  /**
   * Stand a pull up: `live`'s exact contract over one entity. Overlay
   * re-runs when that overlay mutates; HTTPS live still fences on `t`.
   * Deduped by digest.
   * `null` (entity gone, or a required field missing) is a legitimate
   * emission — a retracted entity emits `null` and keeps standing. A
   * pinned view (`asOf` / `history`) emits once and completes.
   */
  livePull<const P>(
    subject: Eid<C> | CatalogEid<C> | LookupRef<C>,
    pattern: PullPattern<C, P>,
  ): Stream.Stream<Pull<C, P> | null, DbError>;

  /**
   * The basis this view reads at: for a live db, the peer's current `t`
   * (one `GET /db/:name/info`); for `asOf(t)`, `t` with no I/O. Observing a
   * newer basis bumps the session, so a standing `live` that missed a tick
   * re-runs — the same rule as `transact`.
   */
  basis(): Effect.Effect<{ readonly t: number }, DbError>;

  /** Read-only view as of transaction `t`. Pure. */
  asOf(t: number): ReadDb<C>;
  /** History view — asserts *and* retracts. Pure. */
  readonly history: ReadDb<C>;
}

export interface Db<C extends AnyCatalog = AnyCatalog> extends ReadDb<C> {
  /**
   * Who this session is — the peer resolves `sub → eid` at its end, so no
   * query is needed to learn your own entity. `eid` is `null` while the
   * principal's row does not exist yet; a `null` is never cached, so re-read
   * it after transacting the row. A non-`null` answer is cached per session
   * generation and re-read on reconnect.
   */
  principal(): Effect.Effect<DbPrincipal<C>, DbError>;

  /**
   * The one write. The generator's yielded Effects compose as they do in
   * `Effect.gen`, so a failure in the body aborts before anything is sent.
   */
  transact<Eff extends Effect.Effect<any, any, any>, A = unknown>(
    body: (tx: Tx<C>) => Generator<Eff, A, never>,
  ): Effect.Effect<
    TxReport<C>,
    DbError | YieldError<Eff>,
    YieldContext<Eff>
  >;

  /** Idempotent catalog upsert, as an ordinary transaction. */
  install(): Effect.Effect<TxReport<C>, DbError>;
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
  /** Equal iff two views read the same coordinates over the same client. */
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
}

/** @internal The registry key {@link DbSeam} is attached under. */
export const DB_SEAM: symbol = Symbol.for("ramose.db.seam");

/** One token per client, so views over different clients never compare equal. */
const clientTokens = new WeakMap<Wire, number>();
let nextClientToken = 1;

const attachSeam = (
  db: object,
  wire: Wire,
  name: string,
  view: View,
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
  };
  (db as Record<symbol, unknown>)[DB_SEAM] = seam;
};

/**
 * One pass of a standing read: the emission, the raw wire result it is
 * digested from, the basis `t` the peer answered at (HTTPS wake fence),
 * and — on an overlay — the overlay epoch captured in the same turn as
 * `view()`.
 */
interface Pass<A> {
  readonly value: A;
  readonly raw: unknown;
  readonly t: number;
  readonly viewed?: number;
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
  e._tag === "ParamError";

const isGenerator = (
  value: unknown,
): value is Generator<Effect.Effect<any, any, any>, unknown, unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Iterator<unknown>).next === "function";

const runGenerator = (
  gen: Generator<Effect.Effect<any, any, any>, unknown, unknown>,
): Effect.Effect<unknown, any, any> =>
  Effect.gen(function* () {
    let step = gen.next();
    while (!step.done) {
      const value = yield* step.value;
      step = gen.next(value);
    }
    return step.value;
  });

/** `[User.name, "Ada"]` and `[":user/name", "Ada"]` both lower to the wire form. */
const lowerSubject = (subject: unknown): unknown => {
  if (Array.isArray(subject) && subject.length === 2) {
    const head = subject[0];
    const ident =
      typeof head === "object" && head !== null && "ident" in head
        ? (head as { ident: string }).ident
        : head;
    return [ident, subject[1]];
  }
  const id = (subject as { id?: unknown } | null)?.id;
  return typeof id === "number" ? id : subject;
};

/** @internal Everything a `Db` and its `ReadDb` views share. */
const makeRead = <C extends AnyCatalog>(
  wire: Wire,
  name: string,
  catalog: C,
  view: View,
  bad: InvalidRequest | undefined,
): ReadDb<C> => {
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
            raw: rec.result,
            t: typeof rec.t === "number" ? rec.t : 0,
            viewed: typeof rec.epoch === "number" ? rec.epoch : undefined,
          };
        }),
      );

  const runQuery = <R, P = never>(
    input: QueryInput<R, P>,
    minT: number | undefined,
    bindings: Readonly<Record<string, unknown>> | undefined,
  ): Effect.Effect<
    {
      readonly rows: unknown;
      readonly t: number;
      readonly raw: unknown;
      readonly viewed?: number;
    },
    DbError | NotOne | ParamError
  > =>
    Effect.gen(function* () {
      const nav = asNavQuery(input);
      let lowered: ReturnType<typeof lowerNavQuery>;
      try {
        lowered = lowerNavQuery(nav as NavQuery<any, any>, bindings);
      } catch (e) {
        if (e instanceof ParamError) return yield* Effect.fail(e);
        throw e;
      }
      const fence = minT ?? view.minT;
      const body = record(
        yield* wire.read(
          name,
          "q",
          compact({
            query: lowered.query,
            inputs: [],
            asOf: view.asOf,
            history: view.history === true ? true : undefined,
          }),
          fence,
        ),
      );
      const t = typeof body.t === "number" ? body.t : 0;
      const viewed = typeof body.epoch === "number" ? body.epoch : undefined;
      if (nav.spec.aggregate !== undefined) {
        return {
          rows: finalizeAggResult(body.result, nav.spec),
          t,
          raw: body.result,
          viewed,
        };
      }
      const finalized = finalizeNavResult(body.result, lowered.pullMap);
      if (nav.spec.after !== undefined) {
        return {
          rows: finalizeNavPage(body.result, finalized, lowered.query.limit),
          t,
          raw: body.result,
          viewed,
        };
      }
      const taken = takeNavResult(finalized, nav.spec.take);
      if (taken instanceof NotOne) return yield* Effect.fail(taken);
      return { rows: taken, t, raw: body.result, viewed };
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
   * digest moved, sleep until the overlay mutates (or the session's basis
   * on HTTPS). What varies is only the pass itself — a query for `live`, a
   * pull for `livePull`.
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

        let last: string | undefined;
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
          // a tick the pass's result did not notice is not news
          const digest = JSON.stringify(pass.raw) ?? "";
          if (digest !== last) {
            // Token / generation / empty resync can re-run onto `[]`
            // while the hydrated snap is still the board. Do not offer
            // that blank; `finishCatchUp` is not catchingUp and can
            // still emit an honest empty after a real wipe.
            const blankingSnap =
              overlaid &&
              overlay !== undefined &&
              overlay.hasSnap &&
              overlay.catchingUp &&
              digest === "[]" &&
              last !== undefined &&
              last !== "[]";
            if (!blankingSnap) {
              last = digest;
              yield* Queue.offer(queue, pass.value);
            }
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

  const read: ReadDb<C> = {
    name,
    catalog,

    q: ((
      input: QueryInput<unknown, unknown>,
      bindings?: Readonly<Record<string, unknown>>,
    ) =>
      fenced(
        Effect.suspend(() =>
          runQuery(input, undefined, bindings).pipe(
            Effect.map((r) => r.rows),
          ),
        ),
      )) as ReadDb<C>["q"],

    live: ((
      input: QueryInput<unknown, unknown>,
      bindings?: Readonly<Record<string, unknown>>,
    ) =>
      standing<unknown, DbError | NotOne | ParamError>((minT) =>
        runQuery(input, minT, bindings).pipe(
          Effect.map((pass) => ({
            value: pass.rows,
            raw: pass.raw,
            t: pass.t,
            viewed: pass.viewed,
          })),
        ),
      )) as ReadDb<C>["live"],

    pull: ((subject: unknown, pattern: unknown) =>
      fenced(
        Effect.suspend(() =>
          pullOne(subject, pattern, undefined).pipe(
            Effect.map((pass) => pass.value),
          ),
        ),
      )) as ReadDb<C>["pull"],

    livePull: ((subject: unknown, pattern: unknown) =>
      standing((minT) => pullOne(subject, pattern, minT))) as ReadDb<
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
      makeRead(wire, name, catalog, { ...view, asOf: t }, bad),

    get history() {
      return makeRead(wire, name, catalog, { ...view, history: true }, bad);
    },
  };
  // enumerable, so `makeDb`'s spread carries it onto the writable db too
  attachSeam(read, wire, name, view);
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

/** @internal `ramose.db(name, catalog)`. Pure: no request, no ensure, no socket. */
export const makeDb = <C extends AnyCatalog>(
  wire: Wire,
  name: string,
  catalog: C,
  view: View = {},
): Db<C> => {
  // a bad name never reaches the peer; every operation fails `InvalidRequest`
  const bad = DATABASE_NAME_RE.test(name)
    ? undefined
    : invalidDatabaseName(name);

  // remember the catalog so the first session read can install schema
  // locally — must not open a socket (db() is pure)
  wire.bindCatalog?.(name, catalog);

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
          dbAfter: makeDb(wire, name, catalog, view),
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
          dbAfter: makeDb(wire, name, catalog, { ...view, minT: t }),
        };
      }),
    );
  };

  return {
    ...makeRead(wire, name, catalog, view, bad),

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

    transact: ((body: (tx: Tx<C>) => unknown) =>
      Effect.suspend(() => {
        const tx = txBuilder(catalog);
        const out = body(tx);
        const run = isGenerator(out)
          ? runGenerator(out)
          : (out as Effect.Effect<unknown, unknown, unknown>);
        return run.pipe(
          Effect.andThen(() => submit(tx.spec.ops as readonly unknown[])),
        );
      })) as Db<C>["transact"],

    install: () => submit(schemaTx(catalog)),
  } as Db<C>;
};
