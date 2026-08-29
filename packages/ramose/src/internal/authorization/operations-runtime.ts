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
import { Index } from "../core/datom.ts";
import type { Db, EntityRef } from "../core/db.ts";
import { query } from "../core/query/engine.ts";
import { pull } from "../core/query/pull.ts";
import { RAMOSE_TYPE, RAMOSE_TYPE_IDENT } from "../core/schema.ts";
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

type ReferenceWrite = {
  readonly source: unknown;
  readonly field: FieldDescriptor & { readonly valueType: "ref" };
  readonly target: unknown;
};

type DeferredFieldWrite = {
  readonly source: unknown;
  readonly field: FieldDescriptor;
};

type Collector = {
  readonly op: unknown;
  readonly tx: TxData;
  readonly refs: readonly ReferenceWrite[];
  readonly deferredFields: readonly DeferredFieldWrite[];
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
  expiresAtSeconds: number,
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
  if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds * 1_000 <= now) {
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

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const sameTransportValue = (
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
      left.every((value, index) => sameTransportValue(value, right[index], seen));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      Object.hasOwn(rightRecord, key) &&
      sameTransportValue(leftRecord[key], rightRecord[key], seen)
    );
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
  const refs: ReferenceWrite[] = [];
  const deferredFields: DeferredFieldWrite[] = [];
  const deployedDefinitions = new Map<string, RuntimeEntity>(
    args.binding.entityDefinitions.map((entity) => [entity.ns, entity] as const),
  );
  const generatedPrefix = "__ramose.operation/";
  let nextTempid = 0;

  const requireDefinition = (value: unknown): RuntimeEntity => {
    const entity = runtimeEntity(value);
    const deployed = entity === undefined ? undefined : deployedDefinitions.get(entity.ns);
    if (deployed === undefined) {
      throw rejected(descriptor, "operation used an undeployed entity definition");
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
    deferConcreteField = false,
  ): void => {
    const ident = fieldIdent(field);
    const capturedEid = snapshotStoredValue(descriptor, lowerEntityArg(eid));
    const loweredValue = hasValue ? lowerWriteValue(value) : undefined;
    const capturedValue = hasValue
      ? snapshotStoredValue(descriptor, loweredValue)
      : undefined;
    if (deferConcreteField) {
      // A targetless trait handle has no concrete composer until its subject
      // resolves on the staged basis. Retain this helper intent so ordinary
      // composer field/fixed-binding semantics can be checked before commit.
      deferredFields.push({ source: capturedEid, field });
    }
    if (hasValue && field.valueType !== "ref") {
      try {
        definition.validateFieldValue(ident, loweredValue);
      } catch (cause) {
        throw new InvalidRequest({
          message: `invalid operation value for ${ident}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        });
      }
    }
    if (kind !== "retract" && field.valueType === "ref") {
      refs.push({ source: capturedEid, field, target: capturedValue });
    }
    if (kind === "retract") {
      tx.push(hasValue
        ? [":db/retract", capturedEid, ident, capturedValue]
        : [":db/retract", capturedEid, ident]);
      return;
    }
    tx.push([
      kind === "add" ? ":db/add" : ":db/update",
      capturedEid,
      ident,
      capturedValue,
    ]);
  };

  const makeHandle = (
    eid: unknown,
    resolveField: (argument: unknown) => FieldDescriptor,
    deferConcreteField = false,
  ): RuntimeHandle => {
    const capturedEid = snapshotStoredValue(descriptor, lowerEntityArg(eid));
    return {
      _tag: "TxHandle",
      eid: capturedEid,
      set: (field, value) => appendWrite(
        "add",
        capturedEid,
        resolveField(field),
        value,
        true,
        deferConcreteField,
      ),
      remove: (field, value) => appendWrite(
        "retract",
        capturedEid,
        resolveField(field),
        value,
        value !== undefined,
        deferConcreteField,
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

  const ownerHandle = (eid: unknown): RuntimeHandle => makeHandle(
    eid,
    requireOwnerField,
    descriptor.id.owner.kind === "trait" && args.target === undefined,
  );

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
        const ident = fieldIdent(field);
        const loweredValue = lowerWriteValue(value);
        const capturedValue = snapshotStoredValue(descriptor, loweredValue);
        if (field.valueType === "ref") {
          refs.push({ source: map[":db/id"], field, target: capturedValue });
        } else {
          try {
            definition.validateFieldValue(ident, loweredValue);
          } catch (cause) {
            throw new InvalidRequest({
              message: `invalid operation value for ${ident}: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            });
          }
        }
        map[ident] = capturedValue;
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
        const entity = deployedDefinitions.get(descriptor.id.owner.name);
        if (entity === undefined) {
          throw rejected(descriptor, "operation owner definition is unavailable");
        }
        const eid = `${generatedPrefix}${++nextTempid}`;
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
      const lowered = tryLowerQueryObject(input);
      return lowered.finalize(await query(args.context.currentDb, lowered.query));
    },
    pull: async (subject: unknown, pattern: unknown) => {
      const ref = lowerEntityArg(subject);
      const eid = typeof ref === "number"
        ? ref
        : Array.isArray(ref) && asLookupRef(ref) !== undefined
          ? await args.context.currentDb.entid(ref as [string, unknown])
          : undefined;
      return eid === undefined
        ? null
        : pull(args.context.currentDb, eid, pattern as never);
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
  return { op, tx, refs, deferredFields };
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
  if (!sameTransportValue(wire, materialized)) {
    throw new TypeError("operation output changes during JSON transport");
  }
  return materialized;
};

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

const validateAuthoritativeRefs = async (
  definition: InstalledCatalogDefinition,
  shape: OperationInputShape,
  value: unknown,
  db: Db,
  selfType: string | undefined,
): Promise<void> => {
  switch (shape._tag) {
    case "ref": {
      if (typeof value !== "number" || !(await db.exists(value))) {
        throw new InvalidRequest({ message: "operation ref does not resolve" });
      }
      const concrete = await typeName(db, value);
      if (concrete === undefined || !refCompatible(definition, shape.refTarget, concrete, selfType)) {
        throw new InvalidRequest({ message: "operation ref has an incompatible entity type" });
      }
      return;
    }
    case "array":
      if (Array.isArray(value)) {
        for (const item of value) {
          await validateAuthoritativeRefs(definition, shape.items, item, db, selfType);
        }
      }
      return;
    case "struct":
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const field of shape.fields) {
          if (Object.hasOwn(value, field.key)) {
            await validateAuthoritativeRefs(
              definition,
              field.shape,
              (value as Record<string, unknown>)[field.key],
              db,
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

const resolveReportEntity = async (
  report: TxReport,
  value: unknown,
): Promise<number | undefined> => {
  if (typeof value === "number") return value;
  if (typeof value === "string") return report.tempids[value];
  if (Array.isArray(value) && asLookupRef(value) !== undefined) {
    return report.dbAfter.entid(value as [string, unknown]);
  }
  return undefined;
};

const validateReferenceWrites = async (
  definition: InstalledCatalogDefinition,
  refs: readonly ReferenceWrite[],
  report: TxReport,
): Promise<void> => {
  for (const ref of refs) {
    const ident = fieldIdent(ref.field);
    const source = await resolveReportEntity(report, ref.source);
    const target = await resolveReportEntity(report, ref.target);
    if (source === undefined || target === undefined || !(await report.dbAfter.exists(target))) {
      throw new InvalidRequest({ message: `operation ref for ${ident} does not resolve` });
    }
    const sourceType = await typeName(report.dbAfter, source) ??
      await typeName(report.dbBefore, source);
    const targetType = await typeName(report.dbAfter, target);
    if (
      sourceType === undefined ||
      targetType === undefined ||
      !refCompatible(definition, ref.field.refTarget, targetType, sourceType)
    ) {
      throw new InvalidRequest({ message: `operation ref for ${ident} has an incompatible entity type` });
    }
  }
};

const validateDeferredFieldWrites = async (
  definition: InstalledCatalogDefinition,
  descriptor: OperationDescriptor,
  writes: readonly DeferredFieldWrite[],
  report: TxReport,
): Promise<void> => {
  for (const write of writes) {
    const ident = fieldIdent(write.field);
    const source = await resolveReportEntity(report, write.source);
    if (source === undefined) {
      throw new InvalidRequest({ message: `operation field ${ident} has an unresolved entity` });
    }
    const concrete = await typeName(report.dbAfter, source) ??
      await typeName(report.dbBefore, source);
    if (concrete === undefined) {
      throw new InvalidRequest({ message: `operation field ${ident} has no canonical entity type` });
    }
    let runtime;
    try {
      runtime = definition.requireFieldRuntime(concrete, ident);
    } catch {
      throw new InvalidRequest({
        message: `operation field ${ident} is incompatible with entity type ${concrete}`,
      });
    }
    if (runtime.fixed._tag === "fixed") {
      throw rejected(descriptor, "operation cannot mutate an engine-owned fixed field");
    }
  }
};

/** Execute one invocation while the Transactor's serialized writer owns the basis. */
export const executeCatalogOperation = async (
  connection: Connection,
  runtime: OperationRuntime,
  invocation: OperationInvocation,
): Promise<OperationExecution> => {
  const authorizationCaller = invocation.caller;
  // Admission finishes before native code runs. Keep the later lease fences
  // on this primitive snapshot; body-visible claims are intentionally ordinary
  // trusted application data and are never consulted for post-body policy.
  const expiresAtSeconds = authorizationCaller.exp;
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
    expiresAtSeconds,
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
  await validateAuthoritativeRefs(
    deployed.definition,
    descriptor.input,
    decoded,
    context.currentDb,
    target?.type ?? (descriptor.id.owner.kind === "entity" ? descriptor.id.owner.name : undefined),
  );

  const collector = createCollector({
    definition: deployed.definition,
    descriptor,
    context,
    caller: authorizationCaller,
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
      await validateDeferredFieldWrites(
        deployed.definition,
        descriptor,
        collector.deferredFields,
        report,
      );
      await validateReferenceWrites(deployed.definition, collector.refs, report);
      const resolved = await resolveOutputHandles(descriptor.output, draft, report);
      await validateAuthoritativeRefs(
        deployed.definition,
        descriptor.output,
        resolved,
        report.dbAfter,
        target?.type ?? (descriptor.id.owner.kind === "entity" ? descriptor.id.owner.name : undefined),
      );
      let encoded: unknown;
      try {
        encoded = binding.output.encode(resolved);
        encoded = materializeOutputTransport(encoded);
      } catch (cause) {
        throw new OperationRuntimeFault("output", cause);
      }
      return encoded;
    },
    authoritativeNowMs,
    // Synchronous Connection pre-apply hook: every body/effect/read/output
    // await is complete, and no further await can intervene before commit.
    () => requireFreshAuthorization(runtime, expiresAtSeconds, descriptor),
  );
  return {
    report: staged.report,
    output: staged.value,
    assertFresh: () => requireFreshAuthorization(runtime, expiresAtSeconds, descriptor),
  };
};
