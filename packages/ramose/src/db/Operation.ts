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
import type { Eid } from "./Eid.ts";
import type { AnySchema } from "./Schema.ts";
import type { TxReport } from "./Db.ts";
import { type DbError, InvalidRequest } from "./Errors.ts";
import type { AnyEntity } from "./Entity.ts";
import { asLookupRef, lowerEntityArg, tempid, type Tempid } from "./entityArg.ts";
import type { EntityRef, LookupRef, UnbrandedId } from "./idents.ts";
import type { AnyQueryObject, QueryObject } from "./query/index.ts";
import {
  isTxHandle,
  type PutAttrs,
  type PutCreateAttrs,
  type PutSubject,
  type TxEntity,
  type TxField,
  type TxHandle,
  type TxKnownEntity,
  type TxValue,
  type UpdateMapAttrs,
} from "./Tx.ts";

/**
 * `true` when `C` is a concrete catalog (keys are entity names). The
 * `AnySchema` bound is `Record<string, …>` — `string extends keyof` — and
 * `TxValue` against that bound is `never`.
 */
type ConcreteCatalog<C extends AnySchema> = string extends keyof C["entities"]
  ? false
  : true;

type OpKnownEntity<C extends AnySchema> = [ConcreteCatalog<C>] extends [true]
  ? TxKnownEntity<C>
  : AnyEntity;

type OpPutAttrs<C extends AnySchema, E extends AnyEntity> =
  [ConcreteCatalog<C>] extends [true]
    ? PutAttrs<C, E, TxHandle<C> | AnyOpHandle<C>>
    : Record<string, unknown>;

type OpPutCreateAttrs<C extends AnySchema, E extends AnyEntity> =
  [ConcreteCatalog<C>] extends [true]
    ? PutCreateAttrs<C, E, TxHandle<C> | AnyOpHandle<C>>
    : Record<string, unknown>;

type OpUpdateMapAttrs<C extends AnySchema, E extends AnyEntity> =
  [ConcreteCatalog<C>] extends [true]
    ? UpdateMapAttrs<C, E, TxHandle<C> | AnyOpHandle<C>>
    : Record<string, unknown>;

/**
 * Field slot on the op handle. Same union as {@link TxField} once the
 * catalog is known. Against the open `AnySchema` bound: a field ref or
 * an ident string (`":user/name"`), matching `TxField`'s two spellings.
 */
export type OpField<C extends AnySchema> = [ConcreteCatalog<C>] extends [true]
  ? TxField<C>
  : { readonly ident: string } | string;

type FieldRefValue<C extends AnySchema, A> = A extends {
  readonly schema: { readonly Type: infer T };
}
  ? T | (A extends { readonly valueType: "ref" } ? EntityRef<C, AnyEntity, TxHandle<C> | AnyOpHandle<C>> : never)
  : unknown;

/**
 * Value correlated to an {@link OpField}. Delegates to {@link TxValue}
 * on a concrete catalog — ref fields use the shared {@link EntityRef}
 * vocabulary (no bare `string`). Against `AnySchema`, a field ref uses
 * its Schema type; an ident string is `unknown`.
 */
export type OpValue<C extends AnySchema, A> = [ConcreteCatalog<C>] extends [true]
  ? TxValue<C, A, TxHandle<C> | AnyOpHandle<C>>
  : FieldRefValue<C, A>;

/**
 * Entity slot on the op handle. Same bag as {@link TxEntity}, plus any
 * {@link OpHandle} — including contextual `self` (`Eid<N> | Tempid`).
 */
export type OpEntity<C extends AnySchema> = TxEntity<C> | AnyOpHandle<C>;

type OpPutSubject<C extends AnySchema, E extends AnyEntity> =
  [ConcreteCatalog<C>] extends [true]
    ? PutSubject<C, E, TxHandle<C> | AnyOpHandle<C>>
    : OpEntity<C>;

/**
 * `db.run`'s contextual entity — the shared {@link EntityRef} vocabulary,
 * narrowed to `N`. A branded cell of the wrong entity is rejected. The
 * unbranded-number hatch remains (mint-by-id). Bare `string` does not —
 * pass {@link Tempid} (`op.tempid("ada")` / `tempid("ada")`).
 */
export type RunEntity<C extends AnySchema, N extends AnyEntity> = EntityRef<
  C,
  N,
  TxHandle<C> | AnyOpHandle<C>
>;

/**
 * Distributes over a union `C` so every member must cover `OC`. A
 * `Movies | Alt` db therefore rejects a Movies-bound op; a superset db
 * (extra entity keys) accepts it.
 */
type CatalogCovers<C extends AnySchema, OC extends AnySchema> = C extends AnySchema
  ? keyof OC["entities"] extends keyof C["entities"]
    ? true
    : false
  : false;

/**
 * Whether operation catalog `OC` may run on db catalog `C`. A schema-less
 * op (open `AnySchema` bound) runs anywhere; a `schema:`-bound op runs on
 * a db that has at least that catalog's entity keys.
 */
export type OpCatalogFitsDb<
  C extends AnySchema,
  OC extends AnySchema,
> = [ConcreteCatalog<OC>] extends [false]
  ? true
  : CatalogCovers<C, OC> extends true
    ? true
    : false;

/** Parameter type when {@link OpCatalogFitsDb} is false — names the catalog. */
export type OpCatalogMismatch = "operation schema does not match this db";

/** `I` / entity argument, or {@link OpCatalogMismatch} when the catalogs diverge. */
export type RunArg<C extends AnySchema, OC extends AnySchema, A> =
  OpCatalogFitsDb<C, OC> extends true ? A : OpCatalogMismatch;

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

/** Id a non-contextual handle names — unbranded so it is valid in any ref slot. */
export type OpHandleId<C extends AnySchema = AnySchema> =
  | UnbrandedId
  | Tempid
  | LookupRef<C>;

/**
 * Entity handle a body writes through. Promise-surface twin of
 * {@link TxHandle}: same field / value / entity slots, methods return
 * `void` instead of `Effect`. `Id` defaults to {@link OpHandleId};
 * contextual `self` specializes it to `Eid<N> | Tempid`.
 */
export interface OpHandle<
  C extends AnySchema = AnySchema,
  Id = OpHandleId<C>,
> {
  readonly _tag: "TxHandle";
  readonly eid: Id;
  set<const A extends OpField<C>>(field: A, value: OpValue<C, A>): void;
  remove<const A extends OpField<C>>(field: A, value?: OpValue<C, A>): void;
  delete(): void;
}

/** Any handle, including contextual `self`. */
export type AnyOpHandle<C extends AnySchema = AnySchema> = OpHandle<C, any>;

/**
 * The handle a body awaits through. Transaction verbs accumulate one
 * commit; reads see the speculative view (confirmed + pending + ops so
 * far). Write slots are {@link TxField} / {@link TxValue} / {@link TxEntity}
 * (thin aliases when the catalog is concrete).
 */
export interface Op<
  C extends AnySchema = AnySchema,
  N extends AnyEntity | undefined = undefined,
> {
  /**
   * The entity a contextual operation is bound to (`on: Entity`).
   * Absent on a non-contextual operation. `eid` is the `on` cell — an
   * {@link Eid} or a {@link Tempid} when `db.run` was given a named tempid.
   */
  readonly self: [N] extends [AnyEntity]
    ? OpHandle<C, Eid<N> | Tempid>
    : undefined;
  /** The authenticated caller. On the client this is `db.principal()`. */
  readonly principal: OpPrincipal;
  /** Database name this invocation is bound to. */
  readonly db: string;

  entity(): OpHandle<C>;
  entity(id: OpEntity<C>): OpHandle<C>;
  /** Brand a string as a named tempid. Not a bare `string`. */
  tempid(name: string): Tempid;
  set<const A extends OpField<C>>(
    e: OpEntity<C>,
    field: A,
    value: OpValue<C, A>,
  ): void;
  remove<const A extends OpField<C>>(
    e: OpEntity<C>,
    field: A,
    value?: OpValue<C, A>,
  ): void;
  delete(e: OpEntity<C>): void;

  /**
   * Make this row so. Lowers to map form. `undefined` fields are
   * omitted; cardinality-many takes an array. No subject allocates a
   * new record and the map must carry every required field. A subject
   * names the record: an existing id, or a new id if that number has
   * never been used (same as `set` — not "update only").
   *
   * Including a `unique: "upsert"` field unifies with the existing row
   * — insert-or-update, still with full required data on create.
   * Partial writes to an existing row are {@link Op.update}.
   *
   * A two-element array whose first value is an ident (`":…"`) is a
   * lookup on a ref field. On a cardinality-many scalar field, that
   * shape is expanded to one value per element so `tags: [":a", "b"]`
   * writes two strings.
   */
  put<E extends OpKnownEntity<C>>(
    entity: E,
    attrs: OpPutCreateAttrs<C, E>,
  ): OpHandle<C>;
  put<E extends OpKnownEntity<C>>(
    entity: E,
    id: OpPutSubject<C, E>,
    attrs: OpPutAttrs<C, E>,
  ): OpHandle<C>;

  /**
   * Change what's there. Partial; never creates. Address by subject
   * (eid / handle / branded cell / lookup) or by a map that contains
   * at least one `unique: "upsert"` field. Missing row →
   * `TxRejected` `tx/missing-entity`. Wrong-entity subject →
   * `tx/wrong-entity`.
   */
  update<E extends OpKnownEntity<C>>(
    entity: E,
    attrs: OpUpdateMapAttrs<C, E>,
  ): OpHandle<C>;
  update<E extends OpKnownEntity<C>>(
    entity: E,
    id: OpPutSubject<C, E>,
    attrs: OpPutAttrs<C, E>,
  ): OpHandle<C>;

  query<Row, Out = readonly Row[]>(
    input: QueryObject<Row, Out>,
  ): Promise<Out>;
  query(input: AnyQueryObject): Promise<unknown>;

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
  C extends AnySchema = AnySchema,
> {
  readonly _tag: "Operation";
  readonly name: Name;
  readonly input: Schema.Codec<I, unknown>;
  readonly output: Schema.Codec<O, unknown>;
  readonly on: N | undefined;
  readonly body: (op: Op<C, N>, input: I) => Promise<O> | O;
}

export type AnyOperation = Operation<string, any, any, any, any>;

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
  put(entity: unknown, attrs: unknown): Effect.Effect<RuntimeOpHandle>;
  put(entity: unknown, id: unknown, attrs: unknown): Effect.Effect<RuntimeOpHandle>;
  update(entity: unknown, attrs: unknown): Effect.Effect<RuntimeOpHandle>;
  update(entity: unknown, id: unknown, attrs: unknown): Effect.Effect<RuntimeOpHandle>;
  query(input: AnyQueryObject): Effect.Effect<unknown, DbError>;
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
  C extends AnySchema = AnySchema,
> {
  readonly input: Schema.Codec<I, unknown>;
  readonly output: Schema.Codec<O, unknown>;
  readonly on?: N;
  /**
   * Type-only: binds the body's write slots to this catalog, not carried
   * at runtime.
   */
  readonly schema?: C;
}

/** `on` must be an entity of `C` once `schema:` is a concrete catalog. */
type OnEntity<C extends AnySchema> = [ConcreteCatalog<C>] extends [true]
  ? C["entities"][keyof C["entities"]] | undefined
  : AnyEntity | undefined;

/** Define one named operation. */
const defineOperation = <
  Name extends string,
  I,
  O,
  C extends AnySchema = AnySchema,
  N extends OnEntity<C> = undefined,
>(
  name: Name,
  schemas: OperationSchemas<I, O, N, C>,
  body: (op: Op<C, N>, input: I) => Promise<O> | O,
): Operation<Name, I, O, N, C> => ({
  _tag: "Operation",
  name,
  input: schemas.input,
  output: schemas.output,
  on: schemas.on,
  body,
});

type OperationFor<C extends AnySchema> = <
  Name extends string,
  I,
  O,
  N extends OnEntity<C> = undefined,
>(
  name: Name,
  schemas: Omit<OperationSchemas<I, O, N, C>, "schema">,
  body: (op: Op<C, N>, input: I) => Promise<O> | O,
) => Operation<Name, I, O, N, C>;

/**
 * Bind `schema:` once for a catalog so every op from the helper carries
 * the membership / ident checks. `Operation.for(Reef)("issue/move", …)`.
 */
const operationFor = <C extends AnySchema>(schema: C): OperationFor<C> =>
  (name, schemas, body) => defineOperation(name, { ...schemas, schema }, body);

/** Define one named operation. `Operation.for(catalog)` bakes `schema:` in. */
export const Operation: typeof defineOperation & {
  readonly for: typeof operationFor;
} = Object.assign(defineOperation, { for: operationFor });

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

export { asLookupRef, lowerEntityArg } from "./entityArg.ts";

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
