/**
 * Explicitly defined, schema-checked operations — the typed write path.
 *
 * An operation is a named value: input/output are `effect/Schema`, the body
 * is `(op, input) => Effect`. Transaction verbs accumulate one commit;
 * `op.effect` is a server-side side-effect step. The client runs the same
 * body as a fiber and stops at the first effect (the optimistic prefix).
 *
 * Portable: this module is on `ramose/db` and must not import the Worker
 * or the engine barrel.
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AnyCatalog } from "./Catalog.ts";
import type { TxReport } from "./Db.ts";
import { type DbError, InvalidRequest } from "./Errors.ts";
import type { AnyNamespace } from "./Namespace.ts";
import type { AnyQueryObject, QueryObject } from "./query/index.ts";
import type { Entity } from "./Tx.ts";

/** Schema for an entity id in operation input / output. */
export const EntityId: typeof Schema.Number = Schema.Number;

/**
 * Internal halt: client-side `op.effect` ends the optimistic prefix.
 * Not a {@link DbError}; `db.run` catches it and keeps the ops so far.
 *
 * @internal
 */
export class PrefixHalt extends Data.TaggedError("ramose/PrefixHalt")<{}> {}

/** Who the body sees as the caller. `eid` is `null` until the principal row exists. */
export interface OpPrincipal {
  readonly eid: number | null;
  readonly class: string;
  readonly sub?: string;
  readonly name?: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

/**
 * What an `op.effect` thunk receives on the server. The client never
 * evaluates the thunk — `op.effect` interrupts the prefix fiber instead.
 */
export interface OperationEffectContext {
  /** Worker env (bindings, secrets). Opaque on the portable surface. */
  readonly env: unknown;
  readonly principal: OpPrincipal;
  /** Control-plane writes that are not this operation's transaction. */
  readonly databases: {
    /**
     * Idempotent catalog upsert on `name` (defaults to the operation's db).
     * Runs as its own transaction — an effect, not a prefix step.
     */
    install(
      catalog: AnyCatalog,
      name?: string,
    ): Effect.Effect<unknown, DbError>;
  };
}

export type EffectThunk<A = unknown, E = unknown, R = unknown> = (
  ctx: OperationEffectContext,
) => Effect.Effect<A, E, R> | Promise<A>;

/**
 * Entity handle a body writes through. Catalog-generic: operations are
 * defined against imported attr refs, not a `Tx<AnyCatalog>` (that bound
 * turns every value into `never`).
 */
export interface OpEntity {
  readonly _tag: "Entity";
  readonly eid: unknown;
  add(attr: unknown, value: unknown): Effect.Effect<void>;
  retract(attr: unknown, value?: unknown): Effect.Effect<void>;
  retractEntity(): Effect.Effect<void>;
}

/**
 * The handle a body yields through. Transaction verbs match {@link Tx}
 * at runtime; reads see the speculative view (confirmed + pending + ops
 * so far). Writes accept any attr ref — the catalog is bound at `db.run`.
 */
export interface Op<N extends AnyNamespace | undefined = undefined> {
  /**
   * The entity a contextual operation is bound to (`on: Namespace`).
   * Absent on a non-contextual operation.
   */
  readonly self: [N] extends [AnyNamespace] ? OpEntity : undefined;
  /** The authenticated caller. On the client this is `db.principal()`. */
  readonly principal: OpPrincipal;
  /** Database name this invocation is bound to. */
  readonly db: string;

  entity(): Effect.Effect<OpEntity>;
  entity(id: unknown): Effect.Effect<OpEntity>;
  add(e: unknown, attr: unknown, value: unknown): Effect.Effect<void>;
  retract(e: unknown, attr: unknown, value?: unknown): Effect.Effect<void>;
  retractEntity(e: unknown): Effect.Effect<void>;

  q<Row, P = never, Out = readonly Row[]>(
    input: QueryObject<Row, P, Out>,
    params?: P extends never ? never : P,
  ): Effect.Effect<Out, DbError>;
  q(
    input: AnyQueryObject,
    params?: Readonly<Record<string, unknown>>,
  ): Effect.Effect<unknown, DbError>;

  pull(subject: unknown, pattern: unknown): Effect.Effect<unknown, DbError>;

  /**
   * A named side-effect step. On the server, `run` executes immediately
   * with {@link OperationEffectContext}. On the client this interrupts the
   * body — later steps are never guessed.
   */
  effect<A, E = never, R = never>(
    name: string,
    run: EffectThunk<A, E, R>,
  ): Effect.Effect<A, E, R>;
}

export interface Operation<
  Name extends string = string,
  I = unknown,
  O = unknown,
  N extends AnyNamespace | undefined = undefined,
> {
  readonly _tag: "Operation";
  readonly name: Name;
  readonly input: Schema.Codec<I, unknown>;
  readonly output: Schema.Codec<O, unknown>;
  readonly on: N;
  readonly body: (op: Op<N>, input: I) => Effect.Effect<O, any, any>;
}

export type AnyOperation = Operation<string, any, any, any>;

export interface Operations<
  M extends Record<string, AnyOperation> = Record<string, AnyOperation>,
> {
  readonly _tag: "Operations";
  readonly operations: M;
  /** Resolve by the operation's declared `name` (not the registry key). */
  get(name: string): AnyOperation | undefined;
}

export type AnyOperations = Operations<Record<string, AnyOperation>>;

export interface OperationSchemas<
  I,
  O,
  N extends AnyNamespace | undefined = undefined,
> {
  readonly input: Schema.Codec<I, unknown>;
  readonly output: Schema.Codec<O, unknown>;
  readonly on?: N;
}

/** Define one named operation. */
export const Operation = <
  Name extends string,
  I,
  O,
  N extends AnyNamespace | undefined = undefined,
>(
  name: Name,
  schemas: OperationSchemas<I, O, N>,
  body: (op: Op<N>, input: I) => Effect.Effect<O, any, any>,
): Operation<Name, I, O, N> => ({
  _tag: "Operation",
  name,
  input: schemas.input,
  output: schemas.output,
  on: schemas.on as N,
  body,
});

/** A deploy-time / client registry of operations. */
export const Operations = <const M extends Record<string, AnyOperation>>(
  operations: M,
): Operations<M> => ({
  _tag: "Operations",
  operations,
  get: (name) => {
    for (const op of Object.values(operations)) {
      if (op.name === name) return op;
    }
    return undefined;
  },
});

/** What `db.run` reports back — a {@link TxReport} plus the encoded output. */
export interface OpReport<O = unknown, C extends AnyCatalog = AnyCatalog>
  extends TxReport<C> {
  readonly output: O;
}

/** An outbox / wire invocation. Not raw tx ops. */
export interface OperationInvocation {
  readonly name: string;
  readonly entity?: unknown;
  readonly input: unknown;
  readonly clientOpId: string;
}

/** Lower a `db.run` entity argument to an eid, tempid, or `undefined`. */
export const lowerEntityArg = (entity: unknown): unknown => {
  if (entity === undefined || entity === null) return undefined;
  if (typeof entity === "number" || typeof entity === "string") return entity;
  if (isEntityLike(entity)) return entity.id;
  if (
    typeof entity === "object" &&
    entity !== null &&
    (entity as { _tag?: unknown })._tag === "Entity" &&
    "eid" in entity
  ) {
    return (entity as Entity).eid;
  }
  return entity;
};

const isEntityLike = (value: unknown): value is { readonly id: number } =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof (value as { id: unknown }).id === "number";

/**
 * Replace entity handles and tempid strings with resolved eids so an
 * operation's return value can be schema-encoded.
 */
export const materializeOutput = (
  value: unknown,
  tempids: Readonly<Record<string, number>>,
): unknown => {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "Entity"
  ) {
    const ref = (value as Entity).eid;
    if (typeof ref === "string") return tempids[ref] ?? ref;
    return ref;
  }
  if (typeof value === "string" && tempids[value] !== undefined) {
    return tempids[value];
  }
  if (Array.isArray(value)) {
    return value.map((item) => materializeOutput(item, tempids));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = materializeOutput(v, tempids);
    }
    return out;
  }
  return value;
};

/** Decode operation input; schema failures are `InvalidRequest`. */
export const decodeInput = <I>(
  schema: Schema.Codec<I, unknown>,
  input: unknown,
): Effect.Effect<I, InvalidRequest> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      (e) =>
        new InvalidRequest({
          message: e.message || "invalid operation input",
        }),
    ),
  );

/** Encode operation output for the wire. */
export const encodeOutput = <O>(
  schema: Schema.Codec<O, unknown>,
  output: O,
): Effect.Effect<unknown, InvalidRequest> =>
  Schema.encodeUnknownEffect(schema)(output).pipe(
    Effect.mapError(
      (e) =>
        new InvalidRequest({
          message: e.message || "invalid operation output",
        }),
    ),
  );
