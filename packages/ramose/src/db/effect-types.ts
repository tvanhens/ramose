/**
 * Effect-returning `Db` / `ReadDb` — the types behind `db.effect.*`.
 *
 * Imported by the promise `Db` as `readonly effect: EffectDb<C>`, so the
 * client `.d.ts` names this file rather than `effect/Effect`.
 */

import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";

/** Re-export so `Db.d.ts` can name Effect without importing `effect`. */
export type EffectOf<A, E = never, R = never> = Effect.Effect<A, E, R>;
/** Re-export so the hatch factory can name a redacted token without `effect`. */
export type RedactedOf<A> = Redacted.Redacted<A>;
import type { AnySchema } from "./Schema.ts";
import type { DbPrincipal, QueryError, TxReport } from "./Db.ts";
import type { DbError } from "./Errors.ts";
import type { SchemaEid, Eid } from "./Eid.ts";
import type { LookupRef } from "./idents.ts";
import type { AnyEntity } from "./Entity.ts";
import type { OpReport, Operation, RunEntity } from "./Operation.ts";
import type { ParamArgs } from "./Params.ts";
import type { IdentPullPattern, Pull, ValidatePull } from "./Pull.ts";
import type { Page, QueryObject } from "./query/index.ts";
import type { Tx, YieldContext, YieldError } from "./Tx.ts";

type PullPattern<C extends AnySchema, P> = [P] extends [readonly unknown[]]
  ? P & IdentPullPattern<C>
  : ValidatePull<C, P>;

export interface EffectReadDb<C extends AnySchema = AnySchema> {
  readonly name: string;
  readonly schema: C;

  query<Row, P = never, Out = readonly Row[]>(
    input: QueryObject<Row, P, Out>,
    ...params: ParamArgs<P>
  ): Effect.Effect<Out, QueryError<Out, P>>;

  live<Row, P = never, Out = readonly Row[]>(
    input: QueryObject<Row, P, Out>,
    ...params: ParamArgs<P>
  ): Stream.Stream<Out, QueryError<Out, P>>;

  pull<const P>(
    subject: Eid<C> | SchemaEid<C> | LookupRef<C>,
    pattern: PullPattern<C, P>,
  ): Effect.Effect<Pull<C, P> | null, DbError>;

  livePull<const P>(
    subject: Eid<C> | SchemaEid<C> | LookupRef<C>,
    pattern: PullPattern<C, P>,
  ): Stream.Stream<Pull<C, P> | null, DbError>;

  basis(): Effect.Effect<{ readonly t: number }, DbError>;

  asOf(t: number): EffectReadDb<C>;
  readonly history: EffectReadDb<C>;
}

export interface EffectDb<C extends AnySchema = AnySchema>
  extends EffectReadDb<C> {
  principal(): Effect.Effect<DbPrincipal<C>, DbError>;

  /** Generator write — hatch only. App code uses `db.run`. */
  transact<Eff extends Effect.Effect<any, any, any>, A = unknown>(
    body: (tx: Tx<C>) => Generator<Eff, A, never>,
  ): Effect.Effect<
    TxReport<C>,
    DbError | YieldError<Eff>,
    YieldContext<Eff>
  >;

  install(): Effect.Effect<TxReport<C>, DbError>;

  run<I, O, OC extends AnySchema = AnySchema>(
    operation: Operation<string, I, O, undefined, OC>,
    input: I,
  ): Effect.Effect<OpReport<O, C>, DbError>;
  run<I, O, N extends AnyEntity, OC extends AnySchema = AnySchema>(
    operation: Operation<string, I, O, N, OC>,
    entity: RunEntity<C, N>,
    input: I,
  ): Effect.Effect<OpReport<O, C>, DbError>;
}

// Keep Page in the type graph so QueryError's Page branch stays reachable
// from this module the same way it is from `Db.ts`.
export type { Page };
