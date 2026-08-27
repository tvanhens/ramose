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
import { type DbError, InvalidRequest, OperationsCoverageError } from "./Errors.ts";
import type { AnyEntity } from "./Entity.ts";
import type { Tempid } from "./entityArg.ts";
import type { EntityRef, LookupRef, UnbrandedId } from "./idents.ts";
import type { AnyQueryObject, QueryObject } from "./query/index.ts";
import {
  isTxHandle,
  type PutAttrs,
  type PutCreateAttrs,
  type PutSubject,
  type TxCasField,
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

/** Card-one field slot for {@link Op.cas}. Card-many is a type error on a concrete catalog. */
export type OpCasField<C extends AnySchema> = [ConcreteCatalog<C>] extends [true]
  ? TxCasField<C>
  : OpField<C>;

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

/**
 * Schema for an entity id in operation input / output.
 *
 * The decoded type is `number`. A body may return a handle (or
 * `{ id: handle }`) in an `EntityId` slot — {@link finalizeOutput}
 * rematerializes it after the writer assigns eids.
 */
export const EntityId: typeof Schema.Finite = Schema.Finite;

/**
 * What a body may return for output type `O`: a handle is legal
 * wherever the schema expects a number (an {@link EntityId} slot).
 */
export type OutputDraft<O> = O extends number
  ? O | { readonly _tag: "TxHandle" }
  : O extends ReadonlyArray<infer U>
    ? { readonly [K in keyof O]: OutputDraft<U> }
    : O extends object
      ? { [K in keyof O]: OutputDraft<O[K]> }
      : O;

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
  cas<const A extends OpCasField<C>>(
    field: A,
    expected: OpValue<C, A> | null,
    replacement: OpValue<C, A>,
  ): void;
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
  cas<const A extends OpCasField<C>>(
    e: OpEntity<C>,
    field: A,
    expected: OpValue<C, A> | null,
    replacement: OpValue<C, A>,
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
   * new record and the map must carry every required field. A numeric
   * subject names an existing record — a missing id is
   * `TxRejected` `tx/missing-entity` (same as {@link Op.update}; naming
   * never creates). A tempid / handle subject is a create.
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
  /** Humans read this in the docs; later MCP uses it as the tool description. */
  readonly doc: string | undefined;
  readonly body: (op: Op<C, N>, input: I) => Promise<OutputDraft<O>> | OutputDraft<O>;
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
  cas(field: unknown, expected: unknown, replacement: unknown): Effect.Effect<void>;
  remove(field: unknown, value?: unknown): Effect.Effect<void>;
  readonly delete: Effect.Effect<void>;
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
  cas(
    e: unknown,
    field: unknown,
    expected: unknown,
    replacement: unknown,
  ): Effect.Effect<void>;
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
  /** Catalog this registry was bound to, when built with {@link defineOperations}. */
  readonly schema?: AnySchema;
  /** Resolve by the operation's declared `name` (not the registry key). */
  get(name: string): AnyOperation | undefined;
  /** Sorted unique wire ids (`issue/move`). The client/server contract. */
  names(): readonly string[];
  /** Id + doc + entity ns — the projection later MCP `learn` reads. */
  cards(): readonly OperationCard[];
}

export type AnyOperations = Operations<Record<string, AnyOperation>>;

/** A catalog-bound registry — {@link defineOperations}'s return. */
export interface DefinedOperations<
  C extends AnySchema,
  M extends Record<string, AnyOperation> = Record<string, AnyOperation>,
> extends Operations<M> {
  readonly schema: C;
}

/**
 * One registered operation, as discovery later reads it. Name is the
 * wire id; `doc` is the human / tool description; `on` is the entity ns
 * when the op is contextual.
 */
export interface OperationCard {
  readonly name: string;
  readonly doc?: string;
  readonly on?: string;
}

export interface OperationSchemas<
  I,
  O,
  N extends AnyEntity | undefined = undefined,
  C extends AnySchema = AnySchema,
> {
  readonly input: Schema.Codec<I, unknown>;
  readonly output?: Schema.Codec<O, unknown>;
  readonly on?: N;
  /**
   * Type-only: binds the body's write slots to this catalog, not carried
   * at runtime.
   */
  readonly schema?: C;
  /** Humans read this in the docs; later MCP uses it as the tool description. */
  readonly doc?: string;
}

/** `on` must be an entity of `C` once `schema:` is a concrete catalog. */
type OnEntity<C extends AnySchema> = [ConcreteCatalog<C>] extends [true]
  ? C["entities"][keyof C["entities"]] | undefined
  : AnyEntity | undefined;

/** Concrete entity of `C` — {@link Operation.patch}'s `on` target. */
type CatalogEntity<C extends AnySchema> = [ConcreteCatalog<C>] extends [true]
  ? C["entities"][keyof C["entities"]]
  : AnyEntity;

const emptyOutput = Schema.Struct({});

const docOf = (doc: string | undefined): string | undefined =>
  doc === undefined || doc === "" ? undefined : doc;

/** Define one named operation. */
const defineOperation = <
  Name extends string,
  I,
  O = {},
  C extends AnySchema = AnySchema,
  N extends OnEntity<C> = undefined,
>(
  name: Name,
  schemas: OperationSchemas<I, O, N, C>,
  body: (op: Op<C, N>, input: I) => Promise<OutputDraft<O>> | OutputDraft<O>,
): Operation<Name, I, O, N, C> => ({
  _tag: "Operation",
  name,
  input: schemas.input,
  output: (schemas.output ?? emptyOutput) as Schema.Codec<O, unknown>,
  on: schemas.on,
  doc: docOf(schemas.doc),
  body,
});

type FieldSchemaType<E extends AnyEntity, K extends string> = E["fields"][K] extends {
  readonly schema: { readonly Type: infer T };
}
  ? T
  : unknown;

type PatchInput<E extends AnyEntity, Keys extends readonly string[]> = {
  readonly [K in Keys[number]]: FieldSchemaType<E, K>;
};

const structOf = (entity: AnyEntity, keys: readonly string[]): Schema.Codec<any, unknown> => {
  const fields: Record<string, Schema.Codec<unknown, unknown>> = {};
  for (const key of keys) {
    const field = entity.fields[key];
    if (field === undefined) {
      throw new Error(`ramose: ${entity.ns} has no field "${key}"`);
    }
    fields[key] = field.schema as Schema.Codec<unknown, unknown>;
  }
  return Schema.Struct(fields);
};

/**
 * A single-field (or few-field) contextual update. The low-ceremony
 * path for what used to be a three-line `transact` (`setTitle`).
 *
 * `Operation.patch("issue/set-title", Issue, ["title"])` then
 * `db.run(op, issueId, { title })`.
 */
const definePatch = <
  Name extends string,
  E extends AnyEntity,
  const Keys extends readonly (keyof E["fields"] & string)[],
  C extends AnySchema = AnySchema,
>(
  name: Name,
  entity: E,
  keys: Keys,
  options?: { readonly doc?: string; readonly schema?: C },
): Operation<Name, PatchInput<E, Keys>, {}, E, C> => {
  const operation = defineOperation(
    name,
    {
      on: entity as never,
      input: structOf(entity, keys) as Schema.Codec<PatchInput<E, Keys>, unknown>,
      output: emptyOutput,
      ...(options?.doc !== undefined && { doc: options.doc }),
      ...(options?.schema !== undefined && { schema: options.schema }),
    },
    (op, input) => {
      const self = (op as { readonly self?: unknown }).self;
      if (self === undefined) {
        throw new Error(`ramose: ${name} is contextual and needs an entity`);
      }
      (op as { update: (...args: unknown[]) => unknown }).update(entity, self, input);
      return {};
    },
  );
  return operation as unknown as Operation<Name, PatchInput<E, Keys>, {}, E, C>;
};

type OperationDefine<C extends AnySchema> = <
  Name extends string,
  I,
  O = {},
  N extends OnEntity<C> = undefined,
>(
  name: Name,
  schemas: Omit<OperationSchemas<I, O, N, C>, "schema">,
  body: (op: Op<C, N>, input: I) => Promise<OutputDraft<O>> | OutputDraft<O>,
) => Operation<Name, I, O, N, C>;

type OperationPatch<C extends AnySchema> = <
  Name extends string,
  E extends CatalogEntity<C>,
  const Keys extends readonly (keyof E["fields"] & string)[],
>(
  name: Name,
  entity: E,
  keys: Keys,
  options?: { readonly doc?: string },
) => Operation<Name, PatchInput<E, Keys>, {}, E, C>;

type OperationFor<C extends AnySchema> = OperationDefine<C> & {
  readonly patch: OperationPatch<C>;
};

/**
 * Bind `schema:` once for a catalog so every op from the helper carries
 * the membership / ident checks. `Operation.for(Reef)("issue/move", …)`.
 */
const operationFor = <C extends AnySchema>(schema: C): OperationFor<C> =>
  Object.assign(
    ((name, schemas, body) =>
      defineOperation(name, { ...schemas, schema }, body)) as OperationDefine<C>,
    {
      patch: ((name, entity, keys, options) =>
        definePatch(name, entity, keys, { ...options, schema })) as OperationPatch<C>,
    },
  );

/** Define one named operation. `Operation.for(catalog)` bakes `schema:` in. */
export const Operation: typeof defineOperation & {
  readonly for: typeof operationFor;
  readonly patch: typeof definePatch;
} = Object.assign(defineOperation, { for: operationFor, patch: definePatch });

const namesOfRegistry = (operations: Record<string, AnyOperation>): string[] => {
  const names = new Set<string>();
  for (const op of Object.values(operations)) {
    if (typeof op.name === "string" && op.name.length > 0) names.add(op.name);
  }
  return [...names].sort();
};

const cardsOfRegistry = (
  operations: Record<string, AnyOperation>,
  get: (name: string) => AnyOperation | undefined,
): OperationCard[] =>
  namesOfRegistry(operations).flatMap((name) => {
    const op = get(name);
    if (op === undefined) return [];
    const ns = op.on?.ns;
    return [
      {
        name,
        ...(op.doc !== undefined ? { doc: op.doc } : {}),
        ...(typeof ns === "string" && ns.length > 0 ? { on: ns } : {}),
      },
    ];
  });

const makeRegistry = <const M extends Record<string, AnyOperation>>(
  operations: M,
  schema?: AnySchema,
): Operations<M> => {
  const get = (name: string): AnyOperation | undefined => {
    for (const op of Object.values(operations)) {
      if (op.name === name) return op;
    }
    return undefined;
  };
  return {
    _tag: "Operations",
    operations,
    ...(schema !== undefined && { schema }),
    get,
    names: () => namesOfRegistry(operations),
    cards: () => cardsOfRegistry(operations, get),
  };
};

/** A deploy-time / client registry of operations. */
export const Operations = <const M extends Record<string, AnyOperation>>(
  operations: M,
): Operations<M> => makeRegistry(operations);

type OpsFitCatalog<C extends AnySchema, M extends Record<string, AnyOperation>> = {
  [K in keyof M]: M[K] extends Operation<any, any, any, any, infer OC>
    ? OpCatalogFitsDb<C, OC> extends true
      ? M[K]
      : OpCatalogMismatch
    : M[K];
};

/**
 * Catalog-bound registry both the app and the peer entry import — one
 * source of truth for op ids, inputs, and outputs.
 *
 * ```ts
 * const Op = Operation.for(Reef);
 * export const setTitleOp = Op.patch("issue/set-title", Issue, ["title"]);
 * export const operations = defineOperations(Reef, { setTitleOp });
 * // peer: createServer({ operations })
 * // Server: Server("Ramose", { operations, main: import.meta.resolve("./peer.ts") })
 * ```
 *
 * Wire ids are each operation's declared `name`. Renaming an id is a
 * wire-contract change — add a new id rather than reuse one with a
 * different input or output.
 */
export const defineOperations = <
  C extends AnySchema,
  const M extends Record<string, AnyOperation>,
>(
  schema: C,
  operations: OpsFitCatalog<C, M> & M,
): DefinedOperations<C, M> =>
  makeRegistry(operations, schema) as unknown as DefinedOperations<C, M>;

/** Sorted unique wire ids in a registry. */
export const operationNames = (ops: AnyOperations | undefined): string[] =>
  ops === undefined ? [] : [...ops.names()];

/** Discovery cards (name / doc / on) for a registry. */
export const operationCards = (
  ops: AnyOperations | undefined,
): readonly OperationCard[] => (ops === undefined ? [] : ops.cards());

const namesOf = (source: AnyOperations | readonly string[]): string[] => {
  if (
    typeof source === "object" &&
    source !== null &&
    "_tag" in source &&
    source._tag === "Operations"
  ) {
    return operationNames(source);
  }
  return [...new Set((source as readonly string[]).filter((n) => typeof n === "string" && n.length > 0))].sort();
};

/**
 * The peer must register every id the client ships. Extra peer ops are
 * fine (a newer Worker, an older bundle). Missing ids throw
 * {@link OperationsCoverageError}.
 */
export const checkOperationsCoverage = (
  required: AnyOperations | readonly string[],
  registered: AnyOperations | readonly string[],
): void => {
  const need = namesOf(required);
  const have = new Set(namesOf(registered));
  const missing = need.filter((n) => !have.has(n));
  if (missing.length === 0) return;
  throw new OperationsCoverageError({
    message: `ramose: peer is missing operations: ${missing.join(", ")} — the client ships these ids; renaming an op is a wire-contract change`,
    missing,
  });
};

export { OperationsCoverageError };

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

/**
 * Resolve handles / named tempids against a commit's tempid map, then
 * encode. Call after the writer assigns eids — that is how `db.run`
 * returns the id of what you created.
 */
export const finalizeOutput = (
  schema: Schema.Codec<unknown, unknown>,
  value: unknown,
  tempids: Readonly<Record<string, number>>,
): Effect.Effect<unknown, InvalidRequest> =>
  encodeOutput(schema, materializeOutput(value, tempids)).pipe(
    Effect.orElseSucceed(() => materializeOutput(value, tempids)),
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
