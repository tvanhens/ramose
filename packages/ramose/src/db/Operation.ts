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
import type { AttrAtIdent, EntityRef, LookupRef } from "./idents.ts";
import type { AnyQueryObject, QueryObject } from "./query/index.ts";
import {
  isTxHandle,
  type PutAttrs,
  type PutSubject,
  type TxEntity,
  type TxField,
  type TxHandle,
  type TxKnownEntity,
  type TxValue,
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
    ? PutAttrs<C, E, TxHandle<C> | OpHandle<C>>
    : Record<string, unknown>;

/**
 * Field slot on the op handle. Same union as {@link TxField} once the
 * catalog is known. Against the open `AnySchema` bound: a field ref or
 * an ident string (`":user/name"`), matching `TxField`'s two spellings.
 */
export type OpField<C extends AnySchema> = [ConcreteCatalog<C>] extends [true]
  ? TxField<C>
  : { readonly ident: string } | string;

type IdentOfOpField<A> = A extends { readonly ident: infer I extends string }
  ? I
  : A extends string
    ? A
    : never;

type FieldIsRef<C extends AnySchema, A> = A extends {
  readonly valueType: "ref";
}
  ? true
  : IdentOfOpField<A> extends infer I
    ? I extends string
      ? AttrAtIdent<C, I>["valueType"] extends "ref"
        ? true
        : false
      : false
    : false;

/** Forms the transactor accepts on a ref-typed value (tempid / handle / lookup). */
type RefWriteValue<C extends AnySchema> =
  | TxHandle<C>
  | OpHandle<C>
  | string
  | LookupRef<C>;

type FieldRefValue<C extends AnySchema, A> = A extends {
  readonly schema: { readonly Type: infer T };
}
  ? T | (A extends { readonly valueType: "ref" } ? RefWriteValue<C> : never)
  : unknown;

/**
 * Value correlated to an {@link OpField}. Delegates to {@link TxValue}
 * on a concrete catalog; a ref-typed field also accepts a handle, tempid
 * string, or lookup (the transactor's ref-value forms). Against `AnySchema`,
 * a field ref uses its Schema type; an ident string is `unknown`.
 */
export type OpValue<C extends AnySchema, A> = [ConcreteCatalog<C>] extends [true]
  ? TxValue<C, A> | (FieldIsRef<C, A> extends true ? RefWriteValue<C> : never)
  : FieldRefValue<C, A>;

/**
 * Entity slot on the op handle. Same bag as {@link TxEntity}, plus the
 * promise {@link OpHandle}.
 */
export type OpEntity<C extends AnySchema> = TxEntity<C> | OpHandle<C>;

type OpPutSubject<C extends AnySchema, E extends AnyEntity> =
  [ConcreteCatalog<C>] extends [true]
    ? PutSubject<C, E, TxHandle<C> | OpHandle<C>>
    : OpEntity<C>;

type OnIdent<N extends AnyEntity> = `:${N["ns"]}/${string}`;

/** Unique lookups whose ident is on `N` (`:issue/…`, not `:comment/…`). */
type LookupRefFor<C extends AnySchema, N extends AnyEntity> = Extract<
  LookupRef<C>,
  | readonly [OnIdent<N>, unknown]
  | readonly [{ readonly ident: OnIdent<N> }, unknown]
>;

/**
 * `db.run`'s contextual entity.
 *
 * A *branded* cell of the wrong entity is rejected (`Eid<Comment>` is not
 * an `Eid<Issue>`). The same holds for a branded `{ id }` row
 * (`{ id: Eid<Comment> }` is not a user). Deliberate hatches: an unbranded
 * `number`, and an opaque tempid `string` (the queued-contextual path remaps
 * it after the ack). Lookups are narrowed to a unique attr of the `on`
 * entity. An unbranded `.ids()` `{ id: number }` is not a branded cell —
 * pass `.id` through the number hatch.
 */
export type RunEntity<C extends AnySchema, N extends AnyEntity> =
  | Eid<N>
  | { readonly id: Eid<N> }
  | (number & { readonly _ns?: never })
  | string
  | LookupRefFor<C, N>
  | TxHandle<C>
  | OpHandle<C>;

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

/**
 * Entity handle a body writes through. Promise-surface twin of
 * {@link TxHandle}: same field / value / entity slots, methods return
 * `void` instead of `Effect`.
 */
export interface OpHandle<C extends AnySchema = AnySchema> {
  readonly _tag: "TxHandle";
  readonly eid: EntityRef<C>;
  set<const A extends OpField<C>>(field: A, value: OpValue<C, A>): void;
  remove<const A extends OpField<C>>(field: A, value?: OpValue<C, A>): void;
  delete(): void;
}

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
   * {@link Eid} or a tempid string when `db.run` was given the string hatch.
   */
  readonly self: [N] extends [AnyEntity]
    ? OpHandle<C> & { readonly eid: Eid<N> | string }
    : undefined;
  /** The authenticated caller. On the client this is `db.principal()`. */
  readonly principal: OpPrincipal;
  /** Database name this invocation is bound to. */
  readonly db: string;

  entity(): OpHandle<C>;
  entity(id: OpEntity<C>): OpHandle<C>;
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
   * Entity-level write. Lowers to map form. `undefined` fields are
   * omitted; cardinality-many takes an array. No subject allocates a
   * new record. A subject names the record: an existing id, or a new
   * id if that number has never been used (same as `set` — not
   * "update only").
   *
   * ### Upserts
   *
   * Including a `unique: "upsert"` field in the map makes `put`
   * ensure-this-row-exists: the engine unifies the new record with the
   * existing row. `op.put(User, { sub, name })` is insert-or-update;
   * `op.put(User, { sub })` is enough when you only have the key. A
   * lookup that misses is still a hard rejection — put with the unique
   * field is the path that creates when missing.
   *
   * A two-element array whose first value is an ident (`":…"`) is a
   * lookup on a ref field. On a cardinality-many scalar field, that
   * shape is expanded to one value per element so `tags: [":a", "b"]`
   * writes two strings.
   */
  put<E extends OpKnownEntity<C>>(
    entity: E,
    attrs: OpPutAttrs<C, E>,
  ): OpHandle<C>;
  put<E extends OpKnownEntity<C>>(
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

/**
 * `[User.name, "Ada"]` / `[":user/name", "Ada"]` → the wire lookup
 * `[":user/name", "Ada"]`. `undefined` when `value` is not a lookup.
 */
export const asLookupRef = (
  value: unknown,
): readonly [string, unknown] | undefined => {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const head = value[0];
  const ident =
    typeof head === "string"
      ? head
      : typeof head === "object" &&
          head !== null &&
          "ident" in head &&
          typeof (head as { ident: unknown }).ident === "string"
        ? (head as { ident: string }).ident
        : undefined;
  if (ident === undefined || ident[0] !== ":") return undefined;
  return [ident, value[1]];
};

/** Lower a `db.run` entity argument to an eid, tempid, lookup, or `undefined`. */
export const lowerEntityArg = (entity: unknown): unknown => {
  if (entity === undefined || entity === null) return undefined;
  if (typeof entity === "number" || typeof entity === "string") return entity;
  const lookup = asLookupRef(entity);
  if (lookup !== undefined) return lookup;
  if (isEntityLike(entity)) return entity.id;
  if (isTxHandle(entity)) return lowerEntityArg(entity.eid);
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
