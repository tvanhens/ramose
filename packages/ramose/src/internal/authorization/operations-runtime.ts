/** Authoritative native execution for deployed owned operations (#417). */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  InvalidRequest,
  OperationRejected,
  Unauthorized,
} from "../../db/Errors.ts";
import type {
  DeployedOperationBinding,
} from "./authoring/operations.ts";
import type {
  OpPrincipal,
  OperationEffectContext,
} from "../../db/Operation.ts";
import { cloneBindingValue } from "../../db/Binding.ts";
import {
  isQueryObject,
  tryLowerQueryObject,
} from "../../db/query/query.ts";
import { lowerAttr } from "../../db/attrRef.ts";
import {
  asLookupRef,
  lowerEntityArg,
  lowerWriteValue,
  tempid,
} from "../../db/entityArg.ts";
import { markEngineTypeAssertion } from "../core/tx-provenance.ts";
import type { Connection, TxReport } from "../core/conn.ts";
import { Index, ValueTag, type Datom } from "../core/datom.ts";
import type { Db, EntityRef } from "../core/db.ts";
import { query } from "../core/query/engine.ts";
import { pull } from "../core/query/pull.ts";
import { RAMOSE_TYPE, RAMOSE_TYPE_IDENT, isTxEid } from "../core/schema.ts";
import type { TxData } from "../core/tx.ts";
import { toJson } from "../core/json.ts";
import type {
  FieldDescriptor,
  FieldRefTarget,
  OperationDescriptor,
  OperationInputShape,
} from "./catalog.ts";
import {
  requireCatalogKey,
  requireUnitHash,
} from "./deployed.ts";
import {
  resolveDeployedCatalogDefinition,
  type DeployedCatalogDefinitions,
  type InstalledCatalogDefinition,
} from "./definitions.ts";
import type {
  CatalogId,
  CatalogUnitHash,
  DatabaseId,
  OwnerRef,
} from "./identities.ts";
import { operationGrantAllows } from "./operation-grant.ts";
import {
  constructAuthorizedRequestContext,
  type AuthenticatedCaller,
  type AuthorizedRequestContext,
} from "./request.ts";
import { uniqueCanonicalTypeName } from "./read-filter.ts";

export type OperationInvocation = {
  readonly database: DatabaseId;
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
  readonly owner: OwnerRef;
  readonly localName: string;
  readonly target?: EntityRef;
  readonly input: unknown;
  readonly caller: AuthenticatedCaller;
};

export type OperationExecution = {
  readonly report: TxReport;
  readonly output: unknown;
  /** Private lease fence retained by the serialized Transactor only. */
  readonly assertFresh: () => void;
};

export type OperationRuntime = {
  readonly catalogs: DeployedCatalogDefinitions;
  readonly environment: unknown;
  readonly now: () => number;
};

/** Private operation defect: the public HTTP boundary sees only `message`. */
export class OperationRuntimeFault extends Error {
  readonly stage: string;
  readonly detail: unknown;

  constructor(stage: string, detail: unknown) {
    super("operation execution failed");
    this.name = "OperationRuntimeFault";
    this.stage = stage;
    this.detail = detail;
  }
}

type RuntimeEntity = {
  readonly ns: string;
  readonly fields?: Readonly<Record<string, { readonly ident?: unknown; readonly cardinality?: unknown; readonly unique?: unknown }>>;
};

type RuntimeHandle = {
  readonly _tag: "TxHandle";
  readonly eid: unknown;
  readonly set: (field: unknown, value: unknown) => void;
  readonly remove: (field: unknown, value?: unknown) => void;
  readonly delete: () => void;
};

type ReadReceipt = {
  readonly before: unknown;
  readonly rerun: (db: Db) => Promise<unknown>;
};

type ReadLeafReplacement = {
  readonly before: unknown;
  readonly after: unknown;
  readonly present: boolean;
};

type Collector = {
  readonly op: unknown;
  readonly tx: TxData;
  readonly creationCandidates: ReadonlySet<string>;
  readonly receipts: readonly ReadReceipt[];
};

/** Opaque denial shared by every authenticated operation-admission failure. */
export const opaqueOperationDenial = (): Unauthorized =>
  new Unauthorized({ status: 403 });

const deny = opaqueOperationDenial;

const operationLabel = (descriptor: OperationDescriptor): string =>
  `${descriptor.id.owner.name}/${descriptor.id.localName}`;

const rejected = (
  descriptor: OperationDescriptor,
  message: string,
  step?: string,
  reason?: string,
): OperationRejected => new OperationRejected({
  message,
  operation: operationLabel(descriptor),
  ...(step === undefined ? {} : { step }),
  ...(reason === undefined ? {} : { reason }),
});

const requireFreshAuthorization = (
  runtime: OperationRuntime,
  caller: AuthenticatedCaller,
  descriptor: OperationDescriptor,
): number => {
  let now: number;
  try {
    now = runtime.now();
  } catch (cause) {
    throw new OperationRuntimeFault("clock", cause);
  }
  if (!Number.isFinite(now)) {
    throw rejected(descriptor, "authoritative operation clock is invalid");
  }
  if (!Number.isSafeInteger(caller.exp) || caller.exp * 1_000 <= now) {
    throw deny();
  }
  return now;
};

const descriptorKey = (owner: OwnerRef, localName: string): string =>
  `${owner.kind}\0${owner.name}\0${localName}`;

const bindingFor = (
  definition: InstalledCatalogDefinition,
  owner: OwnerRef,
  localName: string,
) => definition.operations.find((binding) =>
  descriptorKey(binding.descriptor.id.owner, binding.descriptor.id.localName) ===
    descriptorKey(owner, localName)
);

const fieldIdent = (field: FieldDescriptor): string =>
  `:${field.id.owner.name}/${field.id.localName}`;

const fieldTables = (definition: InstalledCatalogDefinition) => {
  const byIdent = new Map<string, FieldDescriptor>();
  for (const field of definition.unit.catalog.fields) byIdent.set(fieldIdent(field), field);
  return byIdent;
};

const typeName = async (db: Db, eid: number): Promise<string | undefined> => {
  const datoms = await db.datomsArray(Index.EAVT, { e: eid, a: RAMOSE_TYPE });
  return uniqueCanonicalTypeName(datoms);
};

const typeCompatible = (
  definition: InstalledCatalogDefinition,
  owner: OwnerRef,
  concrete: string,
): boolean => owner.kind === "entity"
  ? concrete === owner.name
  : definition.composition.transitiveTraits(`:${concrete}`).includes(`:${owner.name}`);

const refCompatible = (
  definition: InstalledCatalogDefinition,
  target: FieldRefTarget,
  concrete: string,
  selfType: string | undefined,
): boolean => {
  switch (target._tag) {
    case "entity":
      return concrete === target.entity.name;
    case "trait":
      return definition.composition.transitiveTraits(`:${concrete}`).includes(`:${target.trait.name}`);
    case "self":
      return selfType !== undefined && concrete === selfType;
    case "untargeted":
      return definition.composition.isEntityIdent(`:${concrete}`);
  }
};

const resolveVisibleTarget = async (
  context: AuthorizedRequestContext,
  target: EntityRef,
): Promise<{ readonly eid: number; readonly type: string } | undefined> => {
  const eid = typeof target === "number" ? target : await context.filteredDb.entid(target);
  if (eid === undefined || !(await context.filteredDb.exists(eid))) return undefined;
  const concrete = await typeName(context.currentDb, eid);
  return concrete === undefined ? undefined : { eid, type: concrete };
};

const jsValue = (datom: Datom): unknown => {
  if (datom.vt === ValueTag.Inst) return new Date(datom.v as number);
  return datom.v;
};

const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  return false;
};

const sameManyValue = (left: unknown, right: unknown): boolean => {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return (
    left.every((value) => right.some((candidate) => sameValue(value, candidate))) &&
    right.every((value) => left.some((candidate) => sameValue(value, candidate)))
  );
};

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const sameReadResult = (
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, object>(),
): boolean => {
  if (sameValue(left, right)) return true;
  if (
    typeof left !== "object" || left === null ||
    typeof right !== "object" || right === null
  ) return false;
  if (
    !(Array.isArray(left) || isPlainRecord(left)) ||
    !(Array.isArray(right) || isPlainRecord(right)) ||
    Array.isArray(left) !== Array.isArray(right)
  ) return false;
  const prior = seen.get(left);
  if (prior !== undefined) return prior === right;
  seen.set(left, right);
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((value, index) => sameReadResult(value, right[index], seen));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      Object.hasOwn(rightRecord, key) &&
      sameReadResult(leftRecord[key], rightRecord[key], seen)
    );
};

const cloneAndFreezeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezeJson));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = cloneAndFreezeJson(child);
    }
    return Object.freeze(out);
  }
  return value;
};

const isolateCaller = (caller: AuthenticatedCaller): AuthenticatedCaller =>
  Object.freeze({
    claims: cloneAndFreezeJson(caller.claims) as AuthenticatedCaller["claims"],
    classes: Object.freeze([...caller.classes]),
    exp: caller.exp,
  });

/**
 * Private snapshot for filtered read values and their inert arguments. The
 * snapshot is never exposed to operation code, and containers are frozen so
 * later reruns cannot observe body-owned mutation.
 */
const snapshotReadValue = (
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (value instanceof Date) return Object.freeze(new Date(value.getTime()));
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof URL) return Object.freeze(new URL(value.href));
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(snapshotReadValue(item, seen));
    return Object.freeze(out);
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    seen.set(value, out);
    for (const [key, item] of value) {
      out.set(snapshotReadValue(key, seen), snapshotReadValue(item, seen));
    }
    return Object.freeze(out);
  }
  if (value instanceof Set) {
    const out = new Set<unknown>();
    seen.set(value, out);
    for (const item of value) out.add(snapshotReadValue(item, seen));
    return Object.freeze(out);
  }
  const prototype = Object.getPrototypeOf(value);
  const out = Object.create(prototype) as Record<PropertyKey, unknown>;
  seen.set(value, out);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property === undefined) continue;
    Object.defineProperty(out, key, "value" in property
      ? { ...property, value: snapshotReadValue(property.value, seen) }
      : property);
  }
  return Object.freeze(out);
};

/** Capture exactly the stored-data vocabulary without retaining body values. */
const snapshotStoredValue = (
  descriptor: OperationDescriptor,
  value: unknown,
): unknown => {
  try {
    return cloneBindingValue(value);
  } catch {
    throw rejected(descriptor, "operation produced an unsupported stored value");
  }
};

const attrsOf = (
  value: unknown,
  descriptor: OperationDescriptor,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw rejected(descriptor, "operation write attributes must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
};

const runtimeEntity = (value: unknown): RuntimeEntity | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as RuntimeEntity;
  return typeof candidate.ns === "string" ? candidate : undefined;
};

const deployedFieldFromArgument = (
  definition: InstalledCatalogDefinition,
  argument: unknown,
  descriptor: OperationDescriptor,
): FieldDescriptor => {
  let ident: string;
  try {
    ident = lowerAttr(argument);
  } catch {
    throw rejected(descriptor, "operation used an invalid field");
  }
  const field = fieldTables(definition).get(ident);
  if (field === undefined) throw rejected(descriptor, "operation used an undeployed field");
  return field;
};

const fieldFromArgument = (
  definition: InstalledCatalogDefinition,
  entityName: string,
  argument: unknown,
  descriptor: OperationDescriptor,
): FieldDescriptor => {
  const field = deployedFieldFromArgument(definition, argument, descriptor);
  try {
    definition.requireFieldRuntime(entityName, fieldIdent(field));
  } catch {
    throw rejected(descriptor, "operation field is incompatible with its entity definition");
  }
  return field;
};

const isFieldMutable = (
  definition: InstalledCatalogDefinition,
  entityName: string,
  field: FieldDescriptor,
): boolean => definition.requireFieldRuntime(entityName, fieldIdent(field)).fixed._tag === "mutable";

const isMany = (entity: RuntimeEntity, key: string): boolean =>
  entity.fields?.[key]?.cardinality === "many";

const uniqueLookup = (
  entity: RuntimeEntity,
  attrs: Readonly<Record<string, unknown>>,
): readonly [string, unknown] | undefined => {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || entity.fields?.[key]?.unique !== "upsert") continue;
    const ident = entity.fields[key]?.ident;
    if (typeof ident === "string") return [ident, lowerWriteValue(value)];
  }
  return undefined;
};

const createCollector = (args: {
  readonly definition: InstalledCatalogDefinition;
  readonly descriptor: OperationDescriptor;
  readonly context: AuthorizedRequestContext;
  readonly caller: AuthenticatedCaller;
  readonly database: DatabaseId;
  readonly environment: unknown;
  readonly authoritativeNow: Date;
  readonly binding: DeployedOperationBinding;
  readonly target?: { readonly eid: number; readonly type: string };
}): Collector => {
  const { definition, descriptor } = args;
  const tx: unknown[] = [];
  const creationCandidates = new Set<string>();
  const receipts: ReadReceipt[] = [];
  const allowedDefinitions = new Map<string, RuntimeEntity>(
    args.binding.writeDefinitions.map((entity) => [entity.ns, entity] as const),
  );
  if (descriptor.id.owner.kind === "entity" && args.binding.ownerDefinition !== undefined) {
    allowedDefinitions.set(descriptor.id.owner.name, args.binding.ownerDefinition);
  }
  const generatedPrefix = "__ramose.operation/";
  let nextTempid = 0;

  const requireDefinition = (value: unknown): RuntimeEntity => {
    const entity = runtimeEntity(value);
    const deployed = entity === undefined ? undefined : allowedDefinitions.get(entity.ns);
    if (deployed === undefined) {
      throw rejected(descriptor, "operation used an undeclared write definition");
    }
    return deployed;
  };

  const requireOwnerField = (argument: unknown): FieldDescriptor => {
    const concrete = args.target?.type ??
      (descriptor.id.owner.kind === "entity" ? descriptor.id.owner.name : undefined);
    // A targetless trait handle does not know its concrete composer until the
    // staged transaction resolves its eid. Validate trait ownership here and
    // defer concrete composition/fixed-value checks to the authoritative
    // resulting transaction report.
    const field = concrete === undefined
      ? deployedFieldFromArgument(definition, argument, descriptor)
      : fieldFromArgument(definition, concrete, argument, descriptor);
    const owner = field.id.owner;
    const allowed = owner.kind === "entity"
      ? descriptor.id.owner.kind === "entity" && owner.name === descriptor.id.owner.name
      : owner.name === descriptor.id.owner.name ||
        definition.composition.transitiveTraits(`:${descriptor.id.owner.name}`).includes(`:${owner.name}`) ||
        (descriptor.id.owner.kind === "entity" &&
          definition.composition.transitiveTraits(`:${descriptor.id.owner.name}`).includes(`:${owner.name}`));
    if (!allowed) throw rejected(descriptor, "operation used a field outside its owner");
    if (concrete !== undefined && !isFieldMutable(definition, concrete, field)) {
      throw rejected(descriptor, "operation cannot mutate an engine-owned fixed field");
    }
    return field;
  };

  const appendWrite = (
    kind: "add" | "update" | "retract",
    eid: unknown,
    field: FieldDescriptor,
    value?: unknown,
    hasValue = true,
  ): void => {
    const ident = fieldIdent(field);
    const capturedEid = snapshotStoredValue(descriptor, lowerEntityArg(eid));
    if (kind === "retract") {
      tx.push(hasValue
        ? [":db/retract", capturedEid, ident, snapshotStoredValue(descriptor, lowerWriteValue(value))]
        : [":db/retract", capturedEid, ident]);
      return;
    }
    tx.push([
      kind === "add" ? ":db/add" : ":db/update",
      capturedEid,
      ident,
      snapshotStoredValue(descriptor, lowerWriteValue(value)),
    ]);
  };

  const makeHandle = (
    eid: unknown,
    resolveField: (argument: unknown) => FieldDescriptor,
  ): RuntimeHandle => {
    const capturedEid = snapshotStoredValue(descriptor, lowerEntityArg(eid));
    return {
      _tag: "TxHandle",
      eid: capturedEid,
      set: (field, value) => appendWrite("add", capturedEid, resolveField(field), value),
      remove: (field, value) => appendWrite(
        "retract",
        capturedEid,
        resolveField(field),
        value,
        value !== undefined,
      ),
      delete: () => {
        tx.push([":db/retractEntity", capturedEid]);
      },
    };
  };

  const explicitHandle = (entity: RuntimeEntity, eid: unknown): RuntimeHandle =>
    makeHandle(eid, (argument) => {
      const field = fieldFromArgument(definition, entity.ns, argument, descriptor);
      if (!isFieldMutable(definition, entity.ns, field)) {
        throw rejected(descriptor, "operation cannot mutate an engine-owned fixed field");
      }
      return field;
    });

  const ownerHandle = (eid: unknown): RuntimeHandle => makeHandle(eid, requireOwnerField);

  const addPut = (
    entity: RuntimeEntity,
    eid: unknown,
    values: Readonly<Record<string, unknown>>,
    creation: boolean,
  ): RuntimeHandle => {
    const resolved = creation
      ? definition.resolveCreationValues(entity.ns, values, { now: args.authoritativeNow })
      : values;
    const map: Record<string, unknown> = {
      ":db/id": snapshotStoredValue(descriptor, lowerEntityArg(eid)),
    };
    map[RAMOSE_TYPE_IDENT] = `:${entity.ns}`;
    markEngineTypeAssertion(map);
    for (const [key, value] of Object.entries(resolved)) {
      if (value === undefined) continue;
      const fieldArg = entity.fields?.[key];
      const field = fieldFromArgument(definition, entity.ns, fieldArg, descriptor);
      if (!creation && !isFieldMutable(definition, entity.ns, field)) {
        throw rejected(descriptor, "operation cannot mutate an engine-owned fixed field");
      }
      if (isMany(entity, key) && Array.isArray(value)) {
        for (const item of value) appendWrite("add", eid, field, item);
      } else {
        map[fieldIdent(field)] = snapshotStoredValue(descriptor, lowerWriteValue(value));
      }
    }
    tx.push(map);
    return explicitHandle(entity, eid);
  };

  const put = (definitionArg: unknown, a: unknown, b?: unknown): RuntimeHandle => {
    const entity = requireDefinition(definitionArg);
    const creation = b === undefined || typeof lowerEntityArg(a) === "string";
    const attrs = attrsOf(b === undefined ? a : b, descriptor);
    const eid = b === undefined
      ? `${generatedPrefix}${++nextTempid}`
      : lowerEntityArg(a);
    if (typeof eid === "string") creationCandidates.add(eid);
    return addPut(entity, eid, attrs, creation);
  };

  const update = (definitionArg: unknown, a: unknown, b?: unknown): RuntimeHandle => {
    const entity = requireDefinition(definitionArg);
    const attrs = attrsOf(b === undefined ? a : b, descriptor);
    const eid = b === undefined ? uniqueLookup(entity, attrs) : lowerEntityArg(a);
    if (eid === undefined) {
      throw rejected(descriptor, 'update map form needs a unique: "upsert" field');
    }
    let wrote = false;
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined) continue;
      const field = fieldFromArgument(definition, entity.ns, entity.fields?.[key], descriptor);
      if (!isFieldMutable(definition, entity.ns, field)) {
        throw rejected(descriptor, "operation cannot mutate an engine-owned fixed field");
      }
      if (isMany(entity, key) && Array.isArray(value)) {
        for (const item of value) appendWrite("update", eid, field, item);
      } else {
        appendWrite("update", eid, field, value);
      }
      wrote = true;
    }
    if (!wrote) tx.push([":db/update", snapshotStoredValue(descriptor, eid)]);
    return explicitHandle(entity, eid);
  };

  const principal: OpPrincipal = Object.freeze({
    eid: args.context.principal.me?.eid ?? null,
    class: args.caller.classes[0] ?? "",
    sub: args.context.principal.subject,
    claims: args.caller.claims,
  });
  const effectContext: OperationEffectContext = Object.freeze({
    env: args.environment,
    principal,
  });
  const op = {
    principal,
    db: args.database,
    self: args.target === undefined ? undefined : ownerHandle(args.target.eid),
    create: descriptor.id.target === "none" && descriptor.id.owner.kind === "entity"
      ? (attrs: unknown) => {
        const entity = args.binding.ownerDefinition;
        if (entity === undefined) {
          throw rejected(descriptor, "operation owner definition is unavailable");
        }
        const eid = `${generatedPrefix}${++nextTempid}`;
        creationCandidates.add(eid);
        return addPut(entity, eid, attrsOf(attrs, descriptor), true);
      }
      : undefined,
    entity: (...values: readonly unknown[]) => {
      if (values.length === 1) return ownerHandle(lowerEntityArg(values[0]));
      if (values.length === 2) {
        const entity = requireDefinition(values[0]);
        return explicitHandle(entity, lowerEntityArg(values[1]));
      }
      throw rejected(descriptor, "operation entity() needs an id or a definition and id");
    },
    tempid: (name: string) => {
      if (name.startsWith(generatedPrefix)) {
        throw rejected(descriptor, "operation tempid uses a reserved prefix");
      }
      return tempid(name);
    },
    set: (definitionArg: unknown, eid: unknown, fieldArg: unknown, value: unknown) => {
      const entity = requireDefinition(definitionArg);
      explicitHandle(entity, lowerEntityArg(eid)).set(fieldArg, value);
    },
    remove: (definitionArg: unknown, eid: unknown, fieldArg: unknown, value?: unknown) => {
      const entity = requireDefinition(definitionArg);
      explicitHandle(entity, lowerEntityArg(eid)).remove(fieldArg, value);
    },
    delete: (definitionArg: unknown, eid: unknown) => {
      const entity = requireDefinition(definitionArg);
      explicitHandle(entity, lowerEntityArg(eid)).delete();
    },
    put,
    update,
    query: async (input: unknown) => {
      if (!isQueryObject(input)) {
        throw rejected(descriptor, "operation query needs a deployed Query value");
      }
      // Lower synchronously before the first await, then retain only a private
      // immutable wire AST/finalizer. Mutating the authored query object after
      // calling op.query cannot alter either execution or the resulting rerun.
      const lowered = tryLowerQueryObject(input);
      const capturedQuery = snapshotReadValue(lowered.query) as object;
      const runQuery = async (db: Db): Promise<unknown> =>
        lowered.finalize(await query(db, capturedQuery));
      const before = await runQuery(args.context.filteredDb);
      receipts.push({ before: snapshotReadValue(before), rerun: runQuery });
      return before;
    },
    pull: async (subject: unknown, pattern: unknown) => {
      // Capture both arguments before any await so later body mutation cannot
      // rewrite the authoritative rerun.
      const ref = snapshotReadValue(lowerEntityArg(subject));
      const capturedPattern = snapshotReadValue(pattern);
      const eid = typeof ref === "number"
        ? ref
        : Array.isArray(ref) && asLookupRef(ref) !== undefined
          ? await args.context.filteredDb.entid(ref as [string, unknown])
          : undefined;
      const before = eid === undefined
        ? null
        : await pull(args.context.filteredDb, eid, capturedPattern as never);
      receipts.push({
        before: snapshotReadValue(before),
        rerun: async (db) => eid === undefined ? null : pull(db, eid, capturedPattern as never),
      });
      return before;
    },
    effect: async (name: string, run: (context: OperationEffectContext) => unknown) => {
      if (typeof name !== "string" || name.length === 0 || typeof run !== "function") {
        throw rejected(descriptor, "operation effect needs a name and native callback");
      }
      try {
        return await run(effectContext);
      } catch (cause) {
        if (
          cause instanceof Unauthorized || cause instanceof InvalidRequest ||
          cause instanceof OperationRejected || cause instanceof OperationRuntimeFault
        ) throw cause;
        throw new OperationRuntimeFault(`effect:${name}`, cause);
      }
    },
  };
  // The collector exposes only this invocation's definition-directed write
  // surface; the trusted body still runs with ordinary JavaScript semantics.
  return { op, tx, creationCandidates, receipts };
};

const replaceReadResults = async (
  value: unknown,
  receipts: readonly ReadReceipt[],
  resultingDb: Db,
  outputShape: OperationInputShape,
): Promise<{
  readonly value: unknown;
  readonly requireEmptyWireOutput: boolean;
}> => {
  // A declared empty struct can permit reads to decide writes, but Effect
  // struct codecs preserve excess properties and transformations may have a
  // value-bearing encoded side. Defer changed-receipt admission until the
  // exact materialized wire value is proven to be `{}` below.
  if (outputShape._tag === "struct" && outputShape.fields.length === 0) {
    let changed = false;
    for (const receipt of receipts) {
      const after = await receipt.rerun(resultingDb);
      if (!sameReadResult(receipt.before, after)) changed = true;
    }
    return { value, requireEmptyWireOutput: changed };
  }
  const replacements = new Map<object, unknown>();
  const leafReplacements: ReadLeafReplacement[] = [];
  const collect = (before: unknown, after: unknown, present: boolean): void => {
    if (typeof before !== "object" || before === null) {
      leafReplacements.push({ before, after, present });
      return;
    }
    if (before instanceof Date || before instanceof Uint8Array || !(
      Array.isArray(before) || isPlainRecord(before)
    )) {
      leafReplacements.push({ before, after, present });
      return;
    }
    replacements.set(before, present ? after : undefined);
    if (Array.isArray(before)) {
      const afterArray = Array.isArray(after) ? after : undefined;
      for (let index = 0; index < before.length; index++) {
        collect(before[index], afterArray?.[index], afterArray !== undefined && index in afterArray);
      }
      return;
    }
    const afterRecord =
      typeof after === "object" && after !== null && isPlainRecord(after)
        ? after
        : undefined;
    for (const [key, child] of Object.entries(before)) {
      collect(
        child,
        afterRecord?.[key],
        afterRecord !== undefined && Object.hasOwn(afterRecord, key),
      );
    }
  };
  let top = value;
  for (const receipt of receipts) {
    const after = await receipt.rerun(resultingDb);
    // With ordinary JavaScript bodies there is no sound way to propagate
    // taint through arbitrary scalar transformations. If a representation
    // observed before the write would change in the resulting authorized
    // snapshot, reject the invocation atomically instead of risking a stale
    // derived disclosure.
    if (!sameReadResult(receipt.before, after)) throw deny();
    if (Object.is(top, receipt.before)) top = after;
    collect(receipt.before, after, true);
  }
  const visit = (current: unknown, seen = new WeakMap<object, unknown>()): unknown => {
    if (typeof current !== "object" || current === null) {
      const candidates = leafReplacements.filter((replacement) =>
        sameValue(current, replacement.before)
      );
      if (candidates.length === 0) return current;
      if (candidates.some((candidate) => !candidate.present)) throw deny();
      const [first] = candidates;
      if (
        first === undefined ||
        candidates.some((candidate) => !sameValue(candidate.after, first.after))
      ) throw deny();
      return first.after;
    }
    if (current instanceof Date || current instanceof Uint8Array || !(
      Array.isArray(current) || isPlainRecord(current)
    )) {
      return current;
    }
    const replacement = replacements.get(current);
    if (replacement !== undefined || replacements.has(current)) return replacement;
    const cached = seen.get(current);
    if (cached !== undefined) return cached;
    if (Array.isArray(current)) {
      const out: unknown[] = [];
      seen.set(current, out);
      for (const item of current) out.push(visit(item, seen));
      return out;
    }
    const out: Record<string, unknown> = Object.create(Object.getPrototypeOf(current));
    seen.set(current, out);
    for (const [key, item] of Object.entries(current)) out[key] = visit(item, seen);
    return out;
  };
  return { value: visit(top), requireEmptyWireOutput: false };
};

/**
 * Materialize exactly the JSON transport value before commit. `toJson`
 * supports Ramose's Date/bytes/bigint vocabulary; the round-trip comparison
 * rejects values JSON would silently omit or coerce (functions, symbols,
 * non-finite numbers), while recursive `toJson` rejects cycles.
 */
const materializeOutputTransport = (value: unknown): unknown => {
  const wire = toJson(value);
  const text = JSON.stringify(wire);
  if (text === undefined) {
    throw new TypeError("operation output is not JSON transportable");
  }
  const materialized: unknown = JSON.parse(text);
  if (!sameReadResult(wire, materialized)) {
    throw new TypeError("operation output changes during JSON transport");
  }
  return materialized;
};

const isExactEmptyWireStruct = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.keys(value).length === 0;

const resolveOutputHandles = async (
  shape: OperationInputShape,
  value: unknown,
  report: TxReport,
): Promise<unknown> => {
  const resolve = async (input: unknown): Promise<number> => {
    const lowered = lowerEntityArg(input);
    if (typeof lowered === "number") return lowered;
    if (typeof lowered === "string") {
      const eid = report.tempids[lowered];
      if (eid !== undefined) return eid;
    }
    if (Array.isArray(lowered)) {
      const eid = await report.dbAfter.entid(lowered as [string, unknown]);
      if (eid !== undefined) return eid;
    }
    throw new InvalidRequest({ message: "operation output contains an unresolved entity handle" });
  };
  const visit = async (currentShape: OperationInputShape, current: unknown): Promise<unknown> => {
    if (currentShape._tag === "ref") {
      if (
        typeof current === "object" && current !== null && !Array.isArray(current) &&
        (current as { readonly _tag?: unknown })._tag !== "TxHandle" &&
        Object.hasOwn(current, "id")
      ) {
        return resolve((current as { readonly id: unknown }).id);
      }
      return resolve(current);
    }
    if (currentShape._tag === "array" && Array.isArray(current)) {
      return Promise.all(current.map((item) => visit(currentShape.items, item)));
    }
    if (
      currentShape._tag === "struct" &&
      typeof current === "object" && current !== null && !Array.isArray(current)
    ) {
      const fields = new Map(currentShape.fields.map((field) => [field.key, field.shape] as const));
      // Decoded Effect schemas may be prototype-bearing classes. Preserve
      // their runtime representation while recursively replacing actual ref
      // slots; the deployed encoder is authoritative for the final value.
      const out: Record<string, unknown> = Object.create(Object.getPrototypeOf(current));
      for (const [key, item] of Object.entries(current)) {
        const fieldShape = fields.get(key);
        out[key] = fieldShape === undefined ? item : await visit(fieldShape, item);
      }
      return out;
    }
    return current;
  };
  return visit(shape, value);
};

const validateVisibleRefs = async (
  definition: InstalledCatalogDefinition,
  shape: OperationInputShape,
  value: unknown,
  resulting: AuthorizedRequestContext,
  selfType: string | undefined,
): Promise<void> => {
  switch (shape._tag) {
    case "ref": {
      if (typeof value !== "number" || !(await resulting.filteredDb.exists(value))) throw deny();
      const concrete = await typeName(resulting.currentDb, value);
      if (concrete === undefined || !refCompatible(definition, shape.refTarget, concrete, selfType)) {
        throw deny();
      }
      return;
    }
    case "array":
      if (Array.isArray(value)) {
        for (const item of value) {
          await validateVisibleRefs(definition, shape.items, item, resulting, selfType);
        }
      }
      return;
    case "struct":
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const field of shape.fields) {
          if (Object.hasOwn(value, field.key)) {
            await validateVisibleRefs(
              definition,
              field.shape,
              (value as Record<string, unknown>)[field.key],
              resulting,
              selfType,
            );
          }
        }
      }
      return;
    case "scalar":
    case "opaque":
      return;
  }
};

const validateProducedTransaction = async (args: {
  readonly definition: InstalledCatalogDefinition;
  readonly descriptor: OperationDescriptor;
  readonly report: TxReport;
  readonly target?: { readonly eid: number; readonly type: string };
  readonly creationCandidates: ReadonlySet<string>;
}): Promise<void> => {
  const { definition, descriptor, report } = args;
  const fields = fieldTables(definition);
  const allowedTypes = new Set(descriptor.writes.map((write) => write.name));
  if (descriptor.id.owner.kind === "entity") allowedTypes.add(descriptor.id.owner.name);
  const principalField = definition.unit.policy.principal.entity;
  const principalIdent = principalField === undefined
    ? undefined
    : `:${principalField.owner.name}/${principalField.localName}`;
  const candidateEids = new Set<number>();
  for (const tempidName of args.creationCandidates) {
    const eid = report.tempids[tempidName];
    if (eid !== undefined) candidateEids.add(eid);
  }
  const touched = new Set<number>();
  for (const datom of report.txData) {
    if (isTxEid(datom.e)) continue;
    touched.add(datom.e);
    const attr = report.dbAfter.attr(datom.a) ?? report.dbBefore.attr(datom.a);
    const ident = attr?.ident;
    if (ident === undefined) throw rejected(descriptor, "operation produced an unknown attribute");
    if (ident === RAMOSE_TYPE_IDENT) continue;
    if (ident.startsWith(":db/") || ident.startsWith(":ramose/")) {
      throw rejected(descriptor, "operation cannot mutate control-plane facts");
    }
    if (ident === principalIdent) {
      throw rejected(descriptor, "operation cannot mutate principal identity");
    }
    const field = fields.get(ident);
    if (field === undefined) throw rejected(descriptor, "operation produced an undeployed field");
  }

  for (const eid of touched) {
    const beforeType = await typeName(report.dbBefore, eid);
    const afterType = await typeName(report.dbAfter, eid);
    const concrete = afterType ?? beforeType;
    if (concrete === undefined) {
      if (await report.dbAfter.exists(eid)) {
        throw rejected(descriptor, "operation produced an entity without a canonical type");
      }
      continue;
    }
    const isTarget = args.target?.eid === eid;
    const hasDirectOperationDatom = report.txOps.some((op) =>
      op.e === eid && (!op.fromRetractEntity || op.retractEntityRoot)
    );
    const ownerCompatible = typeCompatible(definition, descriptor.id.owner, concrete);
    if (
      hasDirectOperationDatom && !isTarget &&
      !ownerCompatible && !allowedTypes.has(concrete)
    ) {
      throw rejected(descriptor, "operation changed an entity outside its declared write set");
    }
    if (beforeType === undefined && afterType !== undefined && !candidateEids.has(eid)) {
      throw rejected(descriptor, "operation creation must use definition-directed put/create");
    }
    if (afterType !== undefined) {
      const typeDatoms = await report.dbAfter.datomsArray(Index.EAVT, { e: eid, a: RAMOSE_TYPE });
      if (typeDatoms.length !== 1 || uniqueCanonicalTypeName(typeDatoms) !== afterType) {
        throw rejected(descriptor, "operation produced an invalid canonical type");
      }
    }
    for (const datom of report.txData) {
      if (datom.e !== eid || isTxEid(datom.e)) continue;
      const attr = report.dbAfter.attr(datom.a) ?? report.dbBefore.attr(datom.a);
      const ident = attr?.ident;
      if (ident === undefined || ident === RAMOSE_TYPE_IDENT) continue;
      const field = fields.get(ident);
      if (field === undefined) continue;
      const ownerAllowed = field.id.owner.kind === "entity"
        ? field.id.owner.name === concrete
        : definition.composition.transitiveTraits(`:${concrete}`).includes(`:${field.id.owner.name}`);
      if (!ownerAllowed) throw rejected(descriptor, "operation field is incompatible with entity type");
      const runtime = definition.requireFieldRuntime(concrete, ident);
      if (datom.op) {
        try {
          runtime.validate(jsValue(datom));
        } catch (cause) {
          throw new InvalidRequest({
            message: `invalid operation-produced value for ${ident}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          });
        }
        if (field.valueType === "ref") {
          if (typeof datom.v !== "number" || !(await report.dbAfter.exists(datom.v))) {
            throw rejected(descriptor, "operation produced a dangling ref");
          }
          const targetType = await typeName(report.dbAfter, datom.v);
          if (
            targetType === undefined ||
            !refCompatible(definition, field.refTarget, targetType, concrete)
          ) {
            throw rejected(descriptor, "operation produced an incompatible ref target");
          }
        }
      }
    }
    if (afterType !== undefined && await report.dbAfter.exists(eid)) {
      for (const field of definition.unit.catalog.fields) {
        const ident = fieldIdent(field);
        let runtime;
        try {
          runtime = definition.requireFieldRuntime(afterType, ident);
        } catch {
          continue;
        }
        if (runtime.fixed._tag !== "fixed") continue;
        const attr = report.dbAfter.attr(ident);
        if (attr === undefined) throw rejected(descriptor, "fixed field schema is unavailable");
        const datoms = await report.dbAfter.datomsArray(Index.EAVT, { e: eid, a: attr.id });
        const actual = runtime.cardinality === "many"
          ? datoms.map(jsValue)
          : datoms.length === 1 ? jsValue(datoms[0]!) : undefined;
        if (!(
          runtime.cardinality === "many"
            ? sameManyValue(actual, runtime.fixed.value)
            : sameValue(actual, runtime.fixed.value)
        )) {
          throw rejected(descriptor, "operation violated an engine-owned fixed value");
        }
      }
    }
  }
};

/** Execute one invocation while the Transactor's serialized writer owns the basis. */
export const executeCatalogOperation = async (
  connection: Connection,
  runtime: OperationRuntime,
  invocation: OperationInvocation,
): Promise<OperationExecution> => {
  // The body receives a deeply immutable copy. Authorization retains a
  // distinct copy so trusted native code cannot rewrite authenticated claims
  // before resulting-snapshot filtering runs.
  const authorizationCaller = isolateCaller(invocation.caller);
  const bodyCaller = isolateCaller(authorizationCaller);
  const deployed = Result.getOrElse(
    resolveDeployedCatalogDefinition(runtime.catalogs, {
      database: invocation.database,
      catalogKey: invocation.catalogKey,
      unitHash: invocation.unitHash,
    }),
    () => {
      throw deny();
    },
  );
  // Defense in depth: the read adapter and runnable definition must remain
  // the exact same deployment-owned unit.
  if (Result.isFailure(requireCatalogKey(
    invocation.catalogKey,
    deployed.definition.catalogKey,
  ))) throw deny();
  if (Result.isFailure(requireUnitHash(
    invocation.unitHash,
    deployed.definition.unitHash,
    deployed.definition.catalogKey,
  ))) throw deny();
  const binding = bindingFor(deployed.definition, invocation.owner, invocation.localName);
  if (binding === undefined) throw deny();
  const descriptor = binding.descriptor;
  const authoritativeNowMs = requireFreshAuthorization(
    runtime,
    authorizationCaller,
    descriptor,
  );
  const requestInput = {
    authenticate: Effect.succeed(authorizationCaller),
    catalogs: runtime.catalogs.catalogs,
    routeDatabase: invocation.database,
    catalogKey: invocation.catalogKey,
    unitHash: invocation.unitHash,
    currentDb: () => Effect.succeed(connection.db()),
  };
  const context = await Effect.runPromise(
    constructAuthorizedRequestContext(requestInput, authorizationCaller),
  );
  if (!operationGrantAllows(
    deployed.definition.unit,
    descriptor,
    authorizationCaller,
    context.principal.subject,
  )) throw deny();

  let target: { readonly eid: number; readonly type: string } | undefined;
  if (descriptor.id.target === "required") {
    if (invocation.target === undefined) throw deny();
    target = await resolveVisibleTarget(context, invocation.target);
    if (target === undefined || !typeCompatible(deployed.definition, descriptor.id.owner, target.type)) {
      throw deny();
    }
  } else if (invocation.target !== undefined) {
    throw deny();
  }

  let decoded: unknown;
  try {
    decoded = binding.input.decode(invocation.input);
  } catch (cause) {
    throw new InvalidRequest({
      message: `invalid operation input: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
  await validateVisibleRefs(
    deployed.definition,
    descriptor.input,
    decoded,
    context,
    target?.type ?? (descriptor.id.owner.kind === "entity" ? descriptor.id.owner.name : undefined),
  );

  const collector = createCollector({
    definition: deployed.definition,
    descriptor,
    context,
    caller: bodyCaller,
    database: invocation.database,
    environment: runtime.environment,
    authoritativeNow: new Date(authoritativeNowMs),
    binding,
    ...(target === undefined ? {} : { target }),
  });
  let draft: unknown;
  try {
    draft = await binding.run(collector.op, decoded);
  } catch (cause) {
    if (
      cause instanceof Unauthorized || cause instanceof InvalidRequest ||
      cause instanceof OperationRejected || cause instanceof OperationRuntimeFault
    ) throw cause;
    throw new OperationRuntimeFault("body", cause);
  }

  const staged = await connection.transactValidated(
    collector.tx,
    async (report) => {
      await validateProducedTransaction({
        definition: deployed.definition,
        descriptor,
        report,
        creationCandidates: collector.creationCandidates,
        ...(target === undefined ? {} : { target }),
      });
      const resulting = await Effect.runPromise(
        constructAuthorizedRequestContext(
          { ...requestInput, currentDb: () => Effect.succeed(report.dbAfter) },
          authorizationCaller,
        ),
      );
      const rematerialized = await replaceReadResults(
        draft,
        collector.receipts,
        resulting.filteredDb,
        descriptor.output,
      );
      const resolved = await resolveOutputHandles(descriptor.output, rematerialized.value, report);
      await validateVisibleRefs(
        deployed.definition,
        descriptor.output,
        resolved,
        resulting,
        target?.type ?? (descriptor.id.owner.kind === "entity" ? descriptor.id.owner.name : undefined),
      );
      let encoded: unknown;
      try {
        encoded = binding.output.encode(resolved);
        encoded = materializeOutputTransport(encoded);
      } catch (cause) {
        throw new OperationRuntimeFault("output", cause);
      }
      if (
        rematerialized.requireEmptyWireOutput &&
        !isExactEmptyWireStruct(encoded)
      ) throw deny();
      return encoded;
    },
    authoritativeNowMs,
    // Synchronous Connection pre-apply hook: every body/effect/read/output
    // await is complete, and no further await can intervene before commit.
    () => requireFreshAuthorization(runtime, authorizationCaller, descriptor),
  );
  return {
    report: staged.report,
    output: staged.value,
    assertFresh: () => requireFreshAuthorization(runtime, authorizationCaller, descriptor),
  };
};
