/**
 * Explicitly defined, schema-checked operations — the typed write path.
 *
 * An operation is a named value: input/output are `effect/Schema`, the body
 * is an async function. Transaction verbs accumulate one commit; `op.effect`
 * is a server-side side-effect step. The client runs the same body and
 * stops at the first `op.effect` (the optimistic prefix).
 *
 * Portable: this module is on `ramose/db` and must not import the Worker
 * or the engine barrel.
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AnySchema } from "./Schema.ts";
import type { TxReport } from "./Db.ts";
import { type DbError, InvalidRequest } from "./Errors.ts";
import type { AnyEntity } from "./Entity.ts";
import type { AnyQueryObject, QueryObject } from "./query/index.ts";
import { isTxHandle } from "./Tx.ts";

/** Schema for an entity id in operation input / output. */
export const EntityId: typeof Schema.Number = Schema.Number;

/**
 * Client-side `op.effect` ends the optimistic prefix. Not a {@link DbError};
 * `db.run` keeps the ops collected so far. Thrown into an async body — rethrow
 * it from a `catch` if you intercept it; swallowing does not un-halt the prefix.
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
 * evaluates the thunk — `op.effect` throws {@link PrefixHalt} instead.
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
    install(schema: AnySchema, name?: string): Promise<unknown>;
  };
}

export type EffectThunk<A = unknown> = (
  ctx: OperationEffectContext,
) => Promise<A> | A;

/**
 * Entity handle a body writes through. Catalog-generic: operations are
 * defined against imported attr refs, not a `Tx<AnySchema>` (that bound
 * turns every value into `never`).
 */
export interface OpHandle {
  readonly _tag: "TxHandle";
  readonly eid: unknown;
  set(field: unknown, value: unknown): void;
  remove(field: unknown, value?: unknown): void;
  delete(): void;
}

/**
 * The handle a body awaits through. Transaction verbs accumulate one
 * commit; reads see the speculative view (confirmed + pending + ops so
 * far). Writes accept any attr ref — the catalog is bound at `db.run`.
 */
export interface Op<N extends AnyEntity | undefined = undefined> {
  /**
   * The entity a contextual operation is bound to (`on: Entity`).
   * Absent on a non-contextual operation.
   */
  readonly self: [N] extends [AnyEntity] ? OpHandle : undefined;
  /** The authenticated caller. On the client this is `db.principal()`. */
  readonly principal: OpPrincipal;
  /** Database name this invocation is bound to. */
  readonly db: string;

  entity(): OpHandle;
  entity(id: unknown): OpHandle;
  set(e: unknown, field: unknown, value: unknown): void;
  remove(e: unknown, field: unknown, value?: unknown): void;
  delete(e: unknown): void;

  query<Row, P = never, Out = readonly Row[]>(
    input: QueryObject<Row, P, Out>,
    params?: P extends never ? never : P,
  ): Promise<Out>;
  query(
    input: AnyQueryObject,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;

  pull(subject: unknown, pattern: unknown): Promise<unknown>;

  /**
   * A named side-effect step. On the server, `run` executes immediately
   * with {@link OperationEffectContext}. On the client this throws
   * {@link PrefixHalt} — later steps are never guessed.
   */
  effect<A>(name: string, run: EffectThunk<A>): Promise<A>;
}

export interface Operation<
  Name extends string = string,
  I = unknown,
  O = unknown,
  N extends AnyEntity | undefined = undefined,
> {
  readonly _tag: "Operation";
  readonly name: Name;
  readonly input: Schema.Codec<I, unknown>;
  readonly output: Schema.Codec<O, unknown>;
  readonly on: N | undefined;
  readonly body: (op: Op<N>, input: I) => Promise<O> | O;
}

export type AnyOperation = Operation<string, any, any, any>;

/**
 * Runtime handle the overlay and Worker actually build. Effect-flavored —
 * {@link asPromiseOp} is what an operation body sees.
 *
 * `self` is set only when the operation is contextual.
 */
export interface RuntimeOpHandle {
  readonly _tag: "TxHandle";
  readonly eid: unknown;
  set(field: unknown, value: unknown): Effect.Effect<void>;
  remove(field: unknown, value?: unknown): Effect.Effect<void>;
  delete(): Effect.Effect<void>;
}

export interface RuntimeOp {
  readonly self: RuntimeOpHandle | undefined;
  readonly principal: OpPrincipal;
  readonly db: string;
  readonly _effects: "halt" | "run";
  /** Set when client-side `op.effect` fires; `try/catch` cannot clear it. */
  readonly _prefix: { halted: boolean };
  /** Snapshot ops at the first halt so later writes are not guessed. */
  readonly _haltPrefix: () => void;
  entity(): Effect.Effect<RuntimeOpHandle>;
  entity(id: unknown): Effect.Effect<RuntimeOpHandle>;
  set(e: unknown, field: unknown, value: unknown): Effect.Effect<void>;
  remove(e: unknown, field: unknown, value?: unknown): Effect.Effect<void>;
  delete(e: unknown): Effect.Effect<void>;
  query(
    input: AnyQueryObject,
    params?: Readonly<Record<string, unknown>>,
  ): Effect.Effect<unknown, DbError>;
  pull(subject: unknown, pattern: unknown): Effect.Effect<unknown, DbError>;
  effect<A, E = never>(
    name: string,
    run: (
      ctx: {
        readonly env: unknown;
        readonly principal: OpPrincipal;
        readonly databases: {
          install(
            schema: AnySchema,
            name?: string,
          ): Effect.Effect<unknown, DbError>;
        };
      },
    ) => Effect.Effect<A, E> | Promise<A>,
  ): Effect.Effect<A, E | DbError>;
}

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
  N extends AnyEntity | undefined = undefined,
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
  N extends AnyEntity | undefined = undefined,
>(
  name: Name,
  schemas: OperationSchemas<I, O, N>,
  body: (op: Op<N>, input: I) => Promise<O> | O,
): Operation<Name, I, O, N> => ({
  _tag: "Operation",
  name,
  input: schemas.input,
  output: schemas.output,
  on: schemas.on,
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
export interface OpReport<O = unknown, C extends AnySchema = AnySchema>
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
  if (isTxHandle(entity)) return entity.eid;
  return entity;
};

const isEntityLike = (value: unknown): value is { readonly id: number } =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "number";

/**
 * Replace entity handles and tempid strings with resolved eids so an
 * operation's return value can be schema-encoded.
 */
export const materializeOutput = (
  value: unknown,
  tempids: Readonly<Record<string, number>>,
): unknown => {
  if (isTxHandle(value)) {
    const ref = value.eid;
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
    for (const [k, v] of Object.entries(value)) {
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
  output: unknown,
): Effect.Effect<unknown, InvalidRequest> =>
  Schema.encodeUnknownEffect(schema)(output).pipe(
    Effect.mapError(
      (e) =>
        new InvalidRequest({
          message: e.message || "invalid operation output",
        }),
    ),
  );

/** Decode a wire output back into the operation's output type. */
export const decodeOutput = <O>(
  schema: Schema.Codec<O, unknown>,
  output: unknown,
): Effect.Effect<O, InvalidRequest> =>
  Schema.decodeUnknownEffect(schema)(output).pipe(
    Effect.mapError(
      (e) =>
        new InvalidRequest({
          message: e.message || "invalid operation output",
        }),
    ),
  );
