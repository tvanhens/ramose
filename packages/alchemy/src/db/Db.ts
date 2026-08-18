/**
 * `Db<C>` — one database, typed from its catalog.
 *
 * A db is a **value**: `ripple.db(name, catalog)` is pure, `asOf(t)` and
 * `history` are `Db -> ReadDb` with zero I/O, and `dbAfter` on a
 * {@link TxReport} is the same db carrying a min-`t` floor. Nothing here names
 * a transport: reads take the session socket when there is one and HTTPS when
 * there is not, writes are always `POST /db/:name/transact`, and neither is
 * reachable from the public surface.
 */

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { DATABASE_NAME_RE, invalidDatabaseName } from "../DatabaseName.ts";
import type { AnyCatalog } from "./Catalog.ts";
import { type Eid, makeEid } from "./Eid.ts";
import { schemaTx } from "./ensure.ts";
import type { Equal } from "./equal.ts";
import type { DbError, InvalidRequest } from "./Errors.ts";
import { compact, record } from "./http.ts";
import type { LookupRef } from "./idents.ts";
import {
  asNavQuery,
  finalizeNavResult,
  lowerNavQuery,
  type NavQuery,
  type NavQueryBuilder,
} from "./NavQuery.ts";
import type { AnyNamespace } from "./Namespace.ts";
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
export type QueryInput<R> = NavQuery<R> | NavQueryBuilder<AnyNamespace, R>;

/**
 * The rows a query yields here. A query is scoped to a namespace, not to a
 * catalog, so a `.select`-less one types its ids against whichever catalog the
 * db that ran it carries.
 */
type QueryRows<C extends AnyCatalog, R> =
  Equal<R, readonly Eid[]> extends true ? readonly Eid<C>[] : R;

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
  ): Effect.Effect<unknown, DbError>;
  /** `GET /db/:name/info` — where the basis is. Always HTTPS: cheap, authoritative. */
  info(name: string): Effect.Effect<unknown, DbError>;
  /** This database's session, opened lazily; `undefined` with no `WebSocket`. */
  session(name: string): Session | undefined;
}

// ── the public shapes ──────────────────────────────────────────────────────

/** What a committed transaction reports back. `dbAfter` reads your own writes. */
export interface TxReport<C extends AnyCatalog = AnyCatalog> {
  readonly t: number;
  readonly txEid: Eid<C>;
  readonly datomCount: number;
  /** The same db, floored at `t` — no second round trip and no `sync`. */
  readonly dbAfter: Db<C>;
}

/** The pull pattern a subject accepts: a literate map, or the ident-array escape. */
type PullPattern<C extends AnyCatalog, P> = [P] extends [readonly unknown[]]
  ? P & IdentPullPattern<C>
  : ValidatePull<C, P>;

export interface ReadDb<C extends AnyCatalog = AnyCatalog> {
  readonly name: string;
  readonly catalog: C;

  /** Run a {@link NavQuery} once. */
  q<R>(input: QueryInput<R>): Effect.Effect<QueryRows<C, R>, DbError>;

  /**
   * Stand a query up: re-run on every basis tick this session sees,
   * and after a local `transact`. Requirements are `never` — teardown is fiber
   * interruption — and a pinned view (`asOf` / `history`) emits once and
   * completes. A pass that returns the rows already emitted is not emitted
   * again: a write this query does not see is not a re-render.
   */
  live<R>(input: QueryInput<R>): Stream.Stream<QueryRows<C, R>, DbError>;

  /** Project one entity. `null` when a required field is missing. */
  pull<const P>(
    subject: Eid<C> | LookupRef<C>,
    pattern: PullPattern<C, P>,
  ): Effect.Effect<Pull<C, P> | null, DbError>;

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

/** The pause between `live` passes that failed non-terminally, in ms. */
const RETRY_MIN = 250;
const RETRY_MAX = 5000;

/**
 * Failures a standing query must not retry: re-running them changes nothing.
 * `Unauthorized` reaches here only after the session already re-read the token
 * and re-authenticated in place, so a second one is terminal.
 */
const terminal = (e: DbError): boolean =>
  e._tag === "InvalidRequest" ||
  e._tag === "DatabaseNotFound" ||
  e._tag === "Unauthorized" ||
  e._tag === "QueryBudgetExceeded";

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
  const fenced = <A>(effect: Effect.Effect<A, DbError>) =>
    bad === undefined ? effect : Effect.fail<DbError>(bad);

  const pullOne = (
    subject: unknown,
    pattern: unknown,
    minT: number | undefined,
  ): Effect.Effect<unknown, DbError> =>
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
        Effect.map((body) => reshapePullResult(pattern, record(body).result)),
      );

  const runQuery = <R>(
    input: QueryInput<R>,
    minT: number | undefined,
  ): Effect.Effect<
    { readonly rows: unknown; readonly t: number; readonly raw: unknown },
    DbError
  > =>
    Effect.gen(function* () {
      const lowered = lowerNavQuery(asNavQuery(input));
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
      return {
        rows: finalizeNavResult(body.result, lowered.pullMap),
        t,
        raw: body.result,
      };
    });

  /**
   * Keep a standing query alive: re-run a pass that failed non-terminally
   * until it succeeds. This is not a transient policy — the wire's
   * `retryTransient` ladder already retried each Unavailable / NetworkError
   * attempt and only surfaces once spent — it is what happens *after* that
   * (an outage longer than the ladder), and for the failures the ladder does
   * not touch (a 5xx `InternalError`). Exponential pause, capped.
   */
  const withBackoff = <A>(
    attempt: Effect.Effect<A, DbError>,
  ): Effect.Effect<A, DbError> => {
    const step = (wait: number): Effect.Effect<A, DbError> =>
      attempt.pipe(
        Effect.catch((e: DbError) => {
          if (terminal(e)) return Effect.fail(e);
          const next = wait === 0 ? RETRY_MIN : Math.min(wait * 2, RETRY_MAX);
          return Effect.sleep(next).pipe(Effect.andThen(() => step(next)));
        }),
      );
    return step(0);
  };

  const read: ReadDb<C> = {
    name,
    catalog,

    q: (<R>(input: QueryInput<R>) =>
      fenced(
        Effect.suspend(() =>
          runQuery(input, undefined).pipe(Effect.map((r) => r.rows as R)),
        ),
      )) as ReadDb<C>["q"],

    live: (<R>(input: QueryInput<R>) =>
      Stream.callback<R, DbError>((queue) =>
        Effect.gen(function* () {
          if (bad !== undefined) return yield* Queue.fail(queue, bad);
          const session = wire.session(name);
          const pinned = view.asOf !== undefined || view.history === true;

          if (!pinned && session === undefined) {
            return yield* Queue.failCause(
              queue,
              Cause.die(
                new Error(
                  "ripple: db.live needs the session socket — pass `webSocket` to Ripple.layer (or run where a global WebSocket exists)",
                ),
              ),
            );
          }

          let last: string | undefined;
          for (;;) {
            const seen = session?.t ?? 0;
            // one pass; the wire ladder retries its transient attempts, and
            // withBackoff only re-runs the pass once that ladder is spent
            const pass = yield* withBackoff(runQuery(input, seen || undefined));
            // a tick the query's rows did not notice is not news
            const digest = JSON.stringify(pass.raw) ?? "";
            if (digest !== last) {
              last = digest;
              yield* Queue.offer(queue, pass.rows as R);
            }
            if (pinned || session === undefined) break;
            yield* awaitWake(
              session,
              Math.max(seen, pass.t),
              session.generation,
            );
          }
          return yield* Queue.end(queue);
        }).pipe(
          Effect.catch((e: DbError) => Queue.fail(queue, e)),
        ),
      )) as ReadDb<C>["live"],

    pull: ((subject: unknown, pattern: unknown) =>
      fenced(
        Effect.suspend(() => pullOne(subject, pattern, undefined)),
      )) as ReadDb<C>["pull"],

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
  return read;
};

/** Resolve when the session's basis moves past `seen`, or the socket drops. */
const awaitWake = (
  session: Session,
  seen: number,
  generation: number,
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      off();
      resume(Effect.void);
    };
    const off = session.onWake(() => {
      if (session.t > seen || session.generation !== generation) settle();
    });
    if (session.t > seen || session.generation !== generation) settle();
    return Effect.sync(() => {
      done = true;
      off();
    });
  });

/** @internal `ripple.db(name, catalog)`. Pure: no request, no ensure, no socket. */
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

  const submit = (
    tx: readonly unknown[],
  ): Effect.Effect<TxReport<C>, DbError> =>
    bad !== undefined
      ? Effect.fail(bad)
      : wire.transact(name, tx).pipe(
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
              datomCount: typeof ack.datoms === "number" ? ack.datoms : 0,
              dbAfter: makeDb(wire, name, catalog, { ...view, minT: t }),
            };
          }),
        );

  return {
    ...makeRead(wire, name, catalog, view, bad),

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
