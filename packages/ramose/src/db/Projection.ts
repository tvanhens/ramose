/**
 * Optimistic projections — the authoring contract (#476 slice 1).
 *
 * An operation may declare one optional pure optimistic projection. It is
 * trusted code from the installed client bundle, and it is a *separate*
 * declaration: never a serialized, inferred, restricted, or interpreted form of
 * the authoritative body, which stays deployed server code and never crosses
 * the client boundary.
 *
 * ```ts
 * optimistic: ({ input, tx }) =>
 *   tx
 *     .set(input.issue, Issue.status, input.status)
 *     .set(input.issue, Issue.rank, input.rank)
 * ```
 *
 * Callers express requested *target values* (`done: true`), not basis-dependent
 * commands (`toggle`), because a projection has no basis to depend on.
 *
 * ## What the API withholds
 *
 * The context carries validated invocation input, the invocation's own target,
 * the client refs its declared allocation slots minted, and a transaction
 * builder. It carries no local-database query, no Effect, no clock, and no
 * server capability. That is an API and authoring constraint expressed by what
 * is *passed in* — there is no JavaScript sandbox here, and nothing anywhere in
 * this design reads a callback's source. {@link runProjection} calls the
 * function; it never parses, validates, rewrites, reconstructs, or interprets
 * it, and it never consults `Function.prototype.toString`.
 *
 * ## Why a stamped field ref and not a bare ident
 *
 * `tx.set` lowers its value through the field's *declared* value type. A bare
 * ident (`":issue/status"`) cannot say whether a 55-character string is a
 * sealed handle or an ordinary title, and inferring it from the characters
 * would bind a durable intent to a coincidence — the same reason an allocation
 * slot is declared rather than discovered. So a projection passes the stamped
 * field (`Issue.status`), which carries both.
 *
 * Portable: this module is on `ramose/db`.
 */

import { bytesToBase64 } from "../internal/core/log.ts";
import type { Cardinality } from "./Field.ts";
import { isClientRef, isMutationRef, type ClientRef, type MutationRef } from "./refs.ts";
import type { DbValueType } from "./valueTypes.ts";

const fail = (detail: string): never => {
  throw new Error(`ramose/projection: ${detail}`);
};

/**
 * One projected value, in the replica's own logical value model.
 *
 * The eight cases are exactly the replica's logical value types, so the overlay
 * lowers them through the same projection the replica installer and the
 * integrity validator share. Only `ref` differs: it names an `EntityId` or a
 * `ClientRef` rather than a replication identity, because a client addresses
 * entities by durable public handle. Every case is structured-cloneable, which
 * is what lets a durable layer row store a changeset rather than serialize one.
 */
export type ProjectionValue =
  | { readonly type: "long"; readonly value: number }
  | {
    readonly type: "double";
    readonly value: number | "positive-infinity" | "negative-infinity";
  }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "ref"; readonly value: MutationRef }
  | { readonly type: "uuid"; readonly value: string }
  | { readonly type: "instant"; readonly value: number }
  /** Base64, exactly as the replica's own `bytes` logical value carries it. */
  | { readonly type: "bytes"; readonly value: string };

/**
 * One datom-level operation.
 *
 * `set` replaces on a cardinality-one field and adds on a cardinality-many one,
 * exactly as the public verb means; the overlay reads the cardinality from the
 * committed schema rather than trusting a copy stored here, so the two cannot
 * drift. `remove` with no value removes every value of the field. `create`
 * brings a declared allocation slot's client ref into the local view before the
 * server has committed anything. `delete` retracts the entity.
 */
export type ProjectionOp =
  | {
    readonly op: "set";
    readonly entity: MutationRef;
    readonly field: string;
    readonly value: ProjectionValue;
  }
  | {
    readonly op: "remove";
    readonly entity: MutationRef;
    readonly field: string;
    /** `null` removes every current value of the field. */
    readonly value: ProjectionValue | null;
  }
  | {
    readonly op: "create";
    readonly entity: ClientRef;
    readonly slot: string;
    /** The entity definition's `ns`, asserted as `:ramose/type`. */
    readonly type: string;
  }
  | { readonly op: "delete"; readonly entity: MutationRef };

/** One invocation's whole optimistic intent, in call order. */
export type ProjectionChangeset = readonly ProjectionOp[];

/** What `tx.set` / `tx.remove` accept: a stamped field ref carries both. */
export type ProjectionField = {
  readonly ident: string;
  readonly valueType: DbValueType | undefined;
  readonly cardinality?: Cardinality;
};

/** What `tx.create` accepts: an entity definition names its own type. */
export type ProjectionEntity = { readonly ns: string };

/**
 * The transaction builder. Every verb returns the builder so a projection reads
 * as one expression; `create` returns the slot's client ref instead, because
 * that is the value the rest of the projection needs.
 *
 * It accumulates plain data and reads nothing.
 */
export interface ProjectionTx {
  set(entity: MutationRef, field: ProjectionField, value: unknown): ProjectionTx;
  remove(entity: MutationRef, field: ProjectionField, value?: unknown): ProjectionTx;
  /**
   * The client ref this invocation minted for one *declared* allocation slot,
   * created in the local view as an entity of `definition`. A projection may
   * bring a new entity into view only this way: it cannot manufacture an
   * `EntityId`, a mapping, a receipt, an authorization, or a commit result.
   *
   * The definition is what makes the new row a *member*: `:ramose/type` is
   * what type-scoped queries join on, so a create without it would be a row no
   * query could find.
   */
  create(slot: string, definition: ProjectionEntity): ClientRef;
  delete(entity: MutationRef): ProjectionTx;
}

/** Everything a projection may observe. */
export type ProjectionContext<Input> = {
  readonly input: Input;
  /** The invocation's own target, or `undefined` for an untargeted operation. */
  readonly self: MutationRef | undefined;
  readonly tx: ProjectionTx;
};

/** One declared optimistic projection. Synchronous, and returns nothing. */
export type OptimisticProjection<Input> = (
  context: ProjectionContext<Input>,
) => void;

/** Erased projection, for registries that cannot name the input type. */
export type AnyOptimisticProjection = OptimisticProjection<never>;

/** Revision assumed when a projection declares none. */
export const DEFAULT_PROJECTION_REVISION = 1;

/**
 * The author-declared projection revision: an ordinary positive integer.
 *
 * It is deliberately *not* part of #487's canonical operation descriptor. If
 * bumping it rotated `OperationVersion`, editing a projection would revoke
 * every already-queued invocation's right to submit — so a projection-only
 * client change stays a projection-only change.
 */
export const normalizeProjectionRevision = (value: unknown): number => {
  if (value === undefined) return DEFAULT_PROJECTION_REVISION;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(
      `a projection revision must be a positive integer, not ${JSON.stringify(value)}`,
    );
  }
  return value as number;
};

/** The invocation a projection runs against. */
export type ProjectionInvocation<Input> = {
  /** Already decoded and validated against the operation's input schema. */
  readonly input: Input;
  readonly self?: MutationRef | undefined;
  /** Client refs minted for this invocation's declared allocation slots. */
  readonly allocations?: Readonly<Record<string, ClientRef>> | undefined;
};

/**
 * The result of running one projection.
 *
 * A projection that throws produces no layer rather than a partial one: an
 * invocation still queues normally, and the local view simply shows nothing
 * optimistic for it. Failing loudly here would let one authoring mistake wedge
 * a durable queue that is otherwise perfectly submittable.
 */
export type ProjectionOutcome =
  | { readonly type: "changeset"; readonly changeset: ProjectionChangeset }
  | { readonly type: "failed"; readonly reason: string };

const requireTarget = (entity: unknown): MutationRef => {
  if (!isMutationRef(entity)) {
    fail("a projection target must be an EntityId or a ClientRef");
  }
  return entity as MutationRef;
};

const finiteDouble = (value: number): ProjectionValue => {
  if (Number.isNaN(value)) fail("a double value must not be NaN");
  return {
    type: "double",
    value: value === Number.POSITIVE_INFINITY
      ? "positive-infinity"
      : value === Number.NEGATIVE_INFINITY
        ? "negative-infinity"
        : value + 0,
  };
};

const integral = (
  type: "long" | "instant",
  ident: string,
  value: unknown,
): ProjectionValue => {
  const millis = type === "instant" && value instanceof Date
    ? value.getTime()
    : value;
  if (typeof millis !== "number" || !Number.isSafeInteger(millis)) {
    fail(`${ident} expects a safe integer ${type}`);
  }
  return { type, value: millis as number };
};

/**
 * Lower one authored value against the field's declared value type. Every
 * refusal happens here, inside the projection call, so a bad value becomes a
 * failed projection rather than a changeset the overlay must later discard.
 */
const lowerValue = (field: ProjectionField, value: unknown): ProjectionValue => {
  const ident = field.ident;
  switch (field.valueType) {
    case undefined:
      return fail(
        `${ident} has no declared value type — brand its schema with stored(schema, valueType)`,
      );
    case "ref":
      if (!isMutationRef(value)) {
        fail(`${ident} expects an EntityId or a ClientRef`);
      }
      return { type: "ref", value: value as MutationRef };
    case "string":
      if (typeof value !== "string") fail(`${ident} expects a string`);
      return { type: "string", value: value as string };
    case "uuid":
      if (typeof value !== "string") fail(`${ident} expects a uuid string`);
      return { type: "uuid", value: value as string };
    case "boolean":
      if (typeof value !== "boolean") fail(`${ident} expects a boolean`);
      return { type: "boolean", value: value as boolean };
    case "long":
      return integral("long", ident, value);
    case "instant":
      return integral("instant", ident, value);
    case "double":
      if (typeof value !== "number") fail(`${ident} expects a number`);
      return finiteDouble(value as number);
    case "bytes":
      if (!(value instanceof Uint8Array)) fail(`${ident} expects a Uint8Array`);
      return { type: "bytes", value: bytesToBase64(value as Uint8Array) };
  }
};

/**
 * Engine-owned namespaces. A projection describes application data; letting one
 * assert `:db/valueType` or `:ramose/type` over a committed row would let it
 * restate the local view's own schema and type membership, which nothing about
 * an optimistic update should be able to reach. `tx.create` is the one
 * sanctioned way to claim a type, and only for a ref this device minted.
 */
const RESERVED_NAMESPACES = [":db/", ":db.", ":ramose/"];

const requireField = (field: ProjectionField): string => {
  if (
    typeof field !== "object" || field === null ||
    typeof field.ident !== "string" || !field.ident.startsWith(":")
  ) {
    fail("a projection field must be a stamped field ref (Issue.status)");
  }
  if (RESERVED_NAMESPACES.some((prefix) => field.ident.startsWith(prefix))) {
    fail(`${field.ident} is engine metadata and is not a projectable field`);
  }
  return field.ident;
};

class Builder implements ProjectionTx {
  readonly ops: ProjectionOp[] = [];
  private sealed = false;

  constructor(
    private readonly allocations: Readonly<Record<string, ClientRef>>,
  ) {}

  /**
   * Sealing after the call returns is what makes "no Effects, no async" real
   * rather than advisory: a builder captured into a promise or a timer cannot
   * append to a changeset that has already been handed to the overlay.
   */
  seal(): void {
    this.sealed = true;
  }

  private open(): void {
    if (this.sealed) {
      fail("the transaction builder is only usable while the projection runs");
    }
  }

  set(entity: MutationRef, field: ProjectionField, value: unknown): ProjectionTx {
    this.open();
    const ident = requireField(field);
    this.ops.push({
      op: "set",
      entity: requireTarget(entity),
      field: ident,
      value: lowerValue(field, value),
    });
    return this;
  }

  remove(
    entity: MutationRef,
    field: ProjectionField,
    value?: unknown,
  ): ProjectionTx {
    this.open();
    const ident = requireField(field);
    this.ops.push({
      op: "remove",
      entity: requireTarget(entity),
      field: ident,
      value: value === undefined ? null : lowerValue(field, value),
    });
    return this;
  }

  create(slot: string, definition: ProjectionEntity): ClientRef {
    this.open();
    const ref = Object.hasOwn(this.allocations, slot)
      ? this.allocations[slot]
      : undefined;
    if (!isClientRef(ref)) {
      fail(
        `${JSON.stringify(slot)} is not a declared allocation slot of this invocation`,
      );
    }
    if (
      typeof definition !== "object" || definition === null ||
      typeof definition.ns !== "string" || definition.ns.length === 0
    ) {
      fail(`create(${JSON.stringify(slot)}) needs an entity definition`);
    }
    this.ops.push({
      op: "create",
      entity: ref as ClientRef,
      slot,
      type: definition.ns,
    });
    return ref as ClientRef;
  }

  delete(entity: MutationRef): ProjectionTx {
    this.open();
    this.ops.push({ op: "delete", entity: requireTarget(entity) });
    return this;
  }
}

/**
 * Run one projection natively, with ordinary JavaScript semantics.
 *
 * This is the whole execution model: build the context, call the function, take
 * what the builder recorded. Nothing is serialized, parsed, validated,
 * rewritten, reconstructed, or interpreted, and no source is ever read.
 */
export const runProjection = <Input>(
  projection: OptimisticProjection<Input>,
  invocation: ProjectionInvocation<Input>,
): ProjectionOutcome => {
  const builder = new Builder(invocation.allocations ?? {});
  try {
    const returned: unknown = projection({
      input: invocation.input,
      self: invocation.self,
      tx: builder,
    });
    // An async projection would resolve after the layer is already visible, so
    // its later writes could never be part of the same view. Refusing it is the
    // API constraint that keeps a projection a pure function of its input.
    if (
      typeof (returned as { readonly then?: unknown } | undefined)?.then ===
        "function"
    ) {
      return Object.freeze({
        type: "failed" as const,
        reason: "ramose/projection: a projection must be synchronous",
      });
    }
  } catch (cause) {
    return Object.freeze({
      type: "failed" as const,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    builder.seal();
  }
  return Object.freeze({
    type: "changeset" as const,
    changeset: Object.freeze(builder.ops.map((op) => Object.freeze(op))),
  });
};
