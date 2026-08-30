import { bytesToBase64 } from "../internal/core/log.ts";
import type { Cardinality } from "./Field.ts";
import { isClientRef, isMutationRef, type ClientRef, type MutationRef } from "./refs.ts";
import type { DbValueType } from "./valueTypes.ts";

const fail = (detail: string): never => {
  throw new Error(`ramose/projection: ${detail}`);
};

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
  | { readonly type: "bytes"; readonly value: string };

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
    readonly value: ProjectionValue | null;
  }
  | {
    readonly op: "create";
    readonly entity: ClientRef;
    readonly slot: string;
    readonly type: string;
  }
  | { readonly op: "delete"; readonly entity: MutationRef };

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
  create(slot: string, definition: ProjectionEntity): ClientRef;
  delete(entity: MutationRef): ProjectionTx;
}

/** Everything a projection may observe. */
export type ProjectionContext<Input> = {
  readonly input: Input;
  readonly self: MutationRef | undefined;
  readonly tx: ProjectionTx;
};

/** One declared optimistic projection. Synchronous, and returns nothing. */
export type OptimisticProjection<Input> = (
  context: ProjectionContext<Input>,
) => void;

/** Erased projection, for registries that cannot name the input type. */
export type AnyOptimisticProjection = OptimisticProjection<never>;

export const DEFAULT_PROJECTION_REVISION = 1;

export const normalizeProjectionRevision = (value: unknown): number => {
  if (value === undefined) return DEFAULT_PROJECTION_REVISION;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(
      `a projection revision must be a positive integer, not ${JSON.stringify(value)}`,
    );
  }
  return value as number;
};

export type ProjectionInvocation<Input> = {
  readonly input: Input;
  readonly self?: MutationRef | undefined;
  readonly allocations?: Readonly<Record<string, ClientRef>> | undefined;
};

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
    if (
      typeof (returned as { readonly then?: unknown } | undefined)?.then ===
        "function"
    ) {
      void (returned as Promise<unknown>).catch(() => {});
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
