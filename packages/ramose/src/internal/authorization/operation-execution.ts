/** Authoritative owned-operation admission, provenance planning, and commit validation. */

import * as Result from "effect/Result";
import {
  InvalidRequest,
  OperationRejected,
  Unauthorized,
} from "../../db/Errors.ts";
import type { AnyOpHandle, Op, OpPrincipal } from "../../db/Operation.ts";
import {
  resolveCompiledCreationEffects,
  type CompiledCreationEffect,
  type CompiledCreationField,
  type CompiledCreationPlan,
} from "../../db/creation.ts";
import {
  lowerEntityArg,
  lowerWriteValue,
  tempid,
} from "../../db/entityArg.ts";
import type { TxOp } from "../../db/Tx.ts";
import { lowerPullPattern } from "../../db/Pull.ts";
import { tryLowerQueryObject, type AnyQueryObject } from "../../db/query/index.ts";
import type { Principal } from "../../worker/auth.ts";
import { Index, type Datom } from "../core/datom.ts";
import { Db, type EntityRef } from "../core/db.ts";
import { Novelty } from "../core/novelty.ts";
import { processTx, type TxData } from "../core/tx.ts";
import { query } from "../core/query/engine.ts";
import { normalizePullPattern, pull } from "../core/query/pull.ts";
import { RAMOSE_TYPE } from "../core/schema.ts";
import { markEngineTypeAssertion } from "../core/tx-provenance.ts";
import type { TxReport } from "../core/conn.ts";
import type {
  DeployedCatalog,
  DeployedOperation,
} from "./deployed.ts";
import type { CanonicalAuthorizationExpr, CanonicalValueTerm } from "./expr.ts";
import type { OperationId } from "./identities.ts";
import type {
  FieldDescriptor,
  OperationInputShape,
} from "./catalog.ts";
import type { AuthenticatedCaller } from "./request.ts";
import { authorizeCurrentDb } from "./request.ts";
import { compileReadFilter, uniqueCanonicalTypeName } from "./read-filter.ts";
import type { AuthorizationPrincipal } from "./principal.ts";
import {
  catalogSymbolOf,
  fieldSymbolOf,
} from "./operation-body.ts";

const policyDenied = (): Unauthorized =>
  new Unauthorized({ status: 403, code: "policy" });

const operationLabel = (id: OperationId): string =>
  `${id.owner.kind}:${id.owner.name}.${id.localName}`;

const sameAtom = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return left.length === right.length &&
      left.every((value, index) => value === right[index]);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((item, index) => sameAtom(item, right[index]));
  }
  return false;
};

const principalTerm = (
  term: CanonicalValueTerm,
  principal: AuthorizationPrincipal,
): { readonly present: boolean; readonly value?: unknown } => {
  switch (term._tag) {
    case "lit": return { present: true, value: term.value };
    case "subject": return { present: true, value: principal.subject };
    case "claim":
      return Object.hasOwn(principal.claims, term.key)
        ? { present: true, value: principal.claims[term.key] }
        : { present: false };
    case "me":
      return principal.me === undefined
        ? { present: false }
        : { present: true, value: principal.me.eid };
    case "ref": return { present: false };
  }
};

const evalGrant = (
  expr: CanonicalAuthorizationExpr,
  principal: AuthorizationPrincipal,
): boolean => {
  switch (expr._tag) {
    case "const": return expr.value;
    case "hasClass": return principal.classes.includes(expr.class);
    case "and": return expr.exprs.every((child) => evalGrant(child, principal));
    case "or": return expr.exprs.some((child) => evalGrant(child, principal));
    case "not": return !evalGrant(expr.expr, principal);
    case "eq": {
      const left = principalTerm(expr.left, principal);
      const right = principalTerm(expr.right, principal);
      return left.present && right.present && sameAtom(left.value, right.value);
    }
    case "has": return principalTerm(expr.term, principal).present;
    case "in": {
      const value = principalTerm(expr.value, principal);
      const collection = principalTerm(expr.collection, principal);
      return value.present && collection.present && Array.isArray(collection.value) &&
        collection.value.some((item) => sameAtom(value.value, item));
    }
  }
};

const isGranted = (
  deployed: DeployedCatalog,
  operation: OperationId,
  principal: AuthorizationPrincipal,
): boolean => {
  const entry = deployed.unit.policy.decisions.operations.find((candidate) =>
    candidate.target.catalog === operation.catalog &&
    candidate.target.owner.kind === operation.owner.kind &&
    candidate.target.owner.name === operation.owner.name &&
    candidate.target.localName === operation.localName &&
    candidate.target.target === operation.target
  );
  if (entry === undefined) return false;
  const rules = new Map(deployed.unit.policy.rules.map((rule) => [rule.id, rule] as const));
  if (entry.decision.deny.some((id) => {
    const rule = rules.get(id);
    return rule !== undefined && evalGrant(rule.expr, principal);
  })) return false;
  return entry.decision.allow.some((id) => {
    const rule = rules.get(id);
    return rule !== undefined && evalGrant(rule.expr, principal);
  });
};

const resolveTarget = async (
  db: Db,
  target: unknown,
): Promise<number | undefined> => {
  try {
    const lowered = lowerEntityArg(target);
    if (typeof lowered === "number") return (await db.exists(lowered)) ? lowered : undefined;
    if (typeof lowered === "string" || Array.isArray(lowered)) {
      const eid = await db.entid(lowered as EntityRef);
      return eid !== undefined && (await db.exists(eid)) ? eid : undefined;
    }
  } catch {}
  return undefined;
};

const targetType = async (db: Db, eid: number): Promise<string | undefined> =>
  uniqueCanonicalTypeName(await db.datomsArray(Index.EAVT, { e: eid, a: RAMOSE_TYPE }));

const ownerFitsType = (
  deployed: DeployedCatalog,
  owner: { readonly kind: "entity" | "trait"; readonly name: string },
  type: string,
): boolean => owner.kind === "entity"
  ? owner.name === type
  : deployed.composition.transitiveTraits(`:${type}`).includes(`:${owner.name}`);

const targetFits = (
  deployed: DeployedCatalog,
  operation: OperationId,
  type: string,
): boolean => ownerFitsType(deployed, operation.owner, type);

type IntentSource = "self" | "declared";

type BodyIntent =
  | {
      readonly _tag: "field";
      readonly action: "set" | "remove";
      readonly entity: unknown;
      readonly type: string;
      readonly field: FieldDescriptor;
      readonly value?: unknown;
      readonly source: IntentSource;
    }
  | {
      readonly _tag: "delete";
      readonly entity: unknown;
      readonly type: string;
      readonly source: IntentSource;
    }
  | {
      readonly _tag: "put" | "update";
      readonly entity: unknown;
      readonly type: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly source: "declared";
    };

export type PlannedFieldEffect = {
  readonly entity: unknown;
  readonly type: string;
  readonly field: string;
  readonly value: unknown;
  readonly source:
    | "body"
    | "engine-default"
    | "fixed-value"
    | "protected-type";
};

export type PlannedCascadeRetraction = {
  readonly parent: number;
  readonly entity: number;
  readonly type: string;
  readonly field: string;
};

export type OperationPlan = {
  readonly bodyIntents: readonly BodyIntent[];
  readonly engineDefaults: readonly PlannedFieldEffect[];
  readonly fixedValues: readonly PlannedFieldEffect[];
  readonly protectedTypeStamps: readonly PlannedFieldEffect[];
  readonly cascadeRetractions: readonly PlannedCascadeRetraction[];
};

type InternalOperationPlan = OperationPlan & {
  readonly tx: TxData;
  readonly expectedDatoms: readonly Datom[];
  readonly aliases: ReadonlyMap<string, number>;
  readonly dbAfter: Db;
};

type HandleMetadata = {
  readonly type: string;
  readonly source: IntentSource;
};

const handleMetadata = new WeakMap<object, HandleMetadata>();

const asRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRequest({ message: "operation attrs must be an object" });
  }
  return value as Readonly<Record<string, unknown>>;
};

const fieldIdent = (field: FieldDescriptor): string =>
  `:${field.id.owner.name}/${field.id.localName}`;

const fieldFitsType = (
  deployed: DeployedCatalog,
  field: FieldDescriptor,
  type: string,
): boolean => ownerFitsType(deployed, field.id.owner, type);

const creationPlanOf = (
  deployed: DeployedCatalog,
  type: string,
): CompiledCreationPlan => {
  const plan = deployed.creationPlans.find((candidate) => candidate.entity === type);
  if (plan === undefined) {
    throw new InvalidRequest({ message: `operation cannot use unknown entity type ${type}` });
  }
  return plan;
};

const fieldPlanOf = (
  deployed: DeployedCatalog,
  type: string,
  field: FieldDescriptor,
): CompiledCreationField | undefined =>
  creationPlanOf(deployed, type).fields.find((candidate) =>
    candidate.ident === fieldIdent(field)
  );

const principalIdent = (deployed: DeployedCatalog): string | undefined => {
  const field = deployed.unit.policy.principal.entity;
  return field === undefined ? undefined : `:${field.owner.name}/${field.localName}`;
};

const definitionType = (value: unknown): string => {
  const symbol = catalogSymbolOf(value);
  if (symbol?.kind !== "entity") {
    throw new InvalidRequest({ message: "operation requires a deployed entity definition" });
  }
  return symbol.id.name;
};

const definitionField = (
  value: unknown,
  operation: DeployedOperation,
): FieldDescriptor => {
  const field = fieldSymbolOf(value);
  if (field !== undefined) return field;
  if (typeof value === "string" && /^:[^/]+\/[^/]+$/.test(value)) {
    if (value === ":ramose/type" || value.startsWith(":db/") || value.startsWith(":ramose/")) {
      throw new OperationRejected({
        message: "operation cannot mutate control-plane data",
        operation: operationLabel(operation.id),
        step: "body",
        reason: "protected-type",
      });
    }
    throw new InvalidRequest({ message: `operation field ${value} is not from the deployed catalog plan` });
  }
  throw new InvalidRequest({ message: "operation requires a deployed field definition" });
};

const declaredTypes = (operation: DeployedOperation): ReadonlySet<string> =>
  new Set([
    ...(operation.owner.kind === "entity" ? [operation.owner.name] : []),
    ...operation.descriptor.writes.map((entry) => entry.name),
  ]);

const ensureDeclaredType = (
  operation: DeployedOperation,
  type: string,
): void => {
  if (!declaredTypes(operation).has(type)) {
    throw new InvalidRequest({ message: "operation cannot use an undeclared entity definition" });
  }
};

const ensureBodyField = (
  deployed: DeployedCatalog,
  operation: DeployedOperation,
  type: string,
  field: FieldDescriptor,
  source: IntentSource,
): void => {
  if (source === "declared") ensureDeclaredType(operation, type);
  if (!fieldFitsType(deployed, field, type)) {
    throw new InvalidRequest({ message: `operation cannot write ${fieldIdent(field)} on this entity` });
  }
  const ident = fieldIdent(field);
  if (ident === ":ramose/type" || ident.startsWith(":db/") || ident.startsWith(":ramose/")) {
    throw new InvalidRequest({ message: "operation cannot mutate control-plane data" });
  }
  if (principalIdent(deployed) === ident) {
    throw new InvalidRequest({ message: "operation cannot mutate principal identity" });
  }
  if (fieldPlanOf(deployed, type, field)?.fixed !== undefined) {
    throw new InvalidRequest({ message: `operation cannot mutate fixed field ${ident}` });
  }
};

const makeHandle = (
  eid: unknown,
  metadata: HandleMetadata,
  intents: BodyIntent[],
  deployed: DeployedCatalog,
  operation: DeployedOperation,
): AnyOpHandle => {
  const handle: AnyOpHandle = {
    _tag: "TxHandle",
    eid: eid as never,
    set: (fieldValue, value) => {
      const field = definitionField(fieldValue, operation);
      ensureBodyField(deployed, operation, metadata.type, field, metadata.source);
      intents.push({
        _tag: "field",
        action: "set",
        entity: eid,
        type: metadata.type,
        field,
        value,
        source: metadata.source,
      });
    },
    remove: (fieldValue, value) => {
      const field = definitionField(fieldValue, operation);
      ensureBodyField(deployed, operation, metadata.type, field, metadata.source);
      intents.push({
        _tag: "field",
        action: "remove",
        entity: eid,
        type: metadata.type,
        field,
        ...(value === undefined ? {} : { value }),
        source: metadata.source,
      });
    },
    delete: () => {
      intents.push({
        _tag: "delete",
        entity: eid,
        type: metadata.type,
        source: metadata.source,
      });
    },
  };
  handleMetadata.set(handle as object, metadata);
  return Object.freeze(handle);
};

const subjectMetadata = (
  value: unknown,
): HandleMetadata | undefined =>
  typeof value === "object" && value !== null
    ? handleMetadata.get(value)
    : undefined;

const lowerSubject = (value: unknown): unknown => lowerEntityArg(value);

const fieldByKey = (
  deployed: DeployedCatalog,
  type: string,
  key: string,
): FieldDescriptor => {
  const matches = deployed.unit.catalog.fields.filter((field) =>
    field.id.localName === key && fieldFitsType(deployed, field, type)
  );
  if (matches.length !== 1) {
    throw new InvalidRequest({ message: `operation attrs contain unknown or ambiguous field ${key}` });
  }
  return matches[0]!;
};

const validateExplicit = (
  field: CompiledCreationField,
  value: unknown,
): unknown => {
  try {
    if (field.cardinality === "many") {
      if (!Array.isArray(value)) throw new Error("expected an array");
      for (const item of value) field.encoder(item);
    } else {
      field.encoder(value);
    }
    return value;
  } catch (cause) {
    throw new InvalidRequest({
      message: `invalid operation value for ${field.ident}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    });
  }
};

const explicitEffects = (
  deployed: DeployedCatalog,
  type: string,
  input: Readonly<Record<string, unknown>>,
): readonly CompiledCreationEffect[] => {
  const plan = creationPlanOf(deployed, type);
  const out: CompiledCreationEffect[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const field = plan.fields.find((candidate) => candidate.key === key);
    if (field === undefined) {
      throw new InvalidRequest({ message: `operation attrs contain unknown field ${key}` });
    }
    if (field.fixed !== undefined) {
      throw new InvalidRequest({ message: `operation cannot mutate fixed field ${field.ident}` });
    }
    out.push(Object.freeze({
      entity: type,
      key,
      ident: field.ident,
      value: validateExplicit(field, value),
      source: "explicit" as const,
    }));
  }
  return Object.freeze(out);
};

const appendFieldOps = (
  out: TxOp[],
  subject: unknown,
  effect: CompiledCreationEffect,
  field: FieldDescriptor,
  update: boolean,
): void => {
  if (field.cardinality === "many") {
    const values = effect.value as readonly unknown[];
    for (const value of values) {
      out.push([update ? ":db/update" : ":db/add", subject, effect.ident, lowerWriteValue(value)]);
    }
    return;
  }
  out.push([update ? ":db/update" : ":db/add", subject, effect.ident, lowerWriteValue(effect.value)]);
};

const resolveExisting = async (
  db: Db,
  type: string,
  subject: unknown,
  explicit: readonly CompiledCreationEffect[],
  deployed: DeployedCatalog,
): Promise<number | undefined> => {
  const lowered = lowerSubject(subject);
  if (typeof lowered === "number") return (await db.exists(lowered)) ? lowered : undefined;
  if (Array.isArray(lowered)) return db.entid(lowered as EntityRef);
  const fields = deployed.unit.catalog.fields;
  for (const effect of explicit) {
    const descriptor = fields.find((field) => fieldIdent(field) === effect.ident);
    if (descriptor?.unique !== "upsert") continue;
    const found = await db.entid([effect.ident, lowerWriteValue(effect.value)] as EntityRef);
    if (found !== undefined) {
      const foundType = await targetType(db, found);
      if (foundType !== type) {
        throw new InvalidRequest({ message: "operation upsert resolved the wrong entity type" });
      }
      return found;
    }
  }
  return undefined;
};

const dbAfter = (
  before: Db,
  datoms: readonly Datom[],
  nextEid: number,
  deployed: DeployedCatalog,
): Db => {
  const novelty = new Novelty();
  const schema = before.schema.clone().apply(datoms);
  novelty.add(before.novelty.byIndex[Index.EAVT].all(), (a) => schema.isAvet(a), (a) => schema.isVaet(a));
  novelty.add(datoms, (a) => schema.isAvet(a), (a) => schema.isVaet(a));
  return new Db({
    store: before.store,
    roots: before.roots,
    novelty,
    basisT: before.basisT + 1,
    schema,
    nextEid,
    composition: deployed.composition,
  });
};

const resolvePlanSubject = async (
  value: unknown,
  aliases: ReadonlyMap<string, number>,
  tempids: Readonly<Record<string, number>>,
  db: Db,
): Promise<number | undefined> => {
  try {
    const lowered = lowerSubject(value);
    if (typeof lowered === "number") return lowered;
    if (typeof lowered === "string") return aliases.get(lowered) ?? tempids[lowered];
    if (Array.isArray(lowered)) return db.entid(lowered as EntityRef);
  } catch {}
  return undefined;
};

const validateRefEffects = async (
  effects: readonly PlannedFieldEffect[],
  deployed: DeployedCatalog,
  after: Db,
  aliases: ReadonlyMap<string, number>,
  tempids: Readonly<Record<string, number>>,
): Promise<void> => {
  for (const effect of effects) {
    const descriptor = deployed.unit.catalog.fields.find((field) =>
      fieldIdent(field) === effect.field
    );
    if (descriptor?.valueType !== "ref") continue;
    const values = descriptor.cardinality === "many"
      ? effect.value as readonly unknown[]
      : [effect.value];
    for (const value of values) {
      const eid = await resolvePlanSubject(value, aliases, tempids, after);
      if (eid === undefined || !(await after.exists(eid))) {
        throw new InvalidRequest({ message: `invalid ref target for ${effect.field}` });
      }
      const type = await targetType(after, eid);
      if (type === undefined) throw new InvalidRequest({ message: `invalid ref target for ${effect.field}` });
      const target = descriptor.refTarget;
      if (target._tag === "entity" && target.entity.name !== type) {
        throw new InvalidRequest({ message: `wrong ref target for ${effect.field}` });
      }
      if (
        target._tag === "trait" &&
        !deployed.composition.transitiveTraits(`:${type}`).includes(`:${target.trait.name}`)
      ) {
        throw new InvalidRequest({ message: `wrong trait ref target for ${effect.field}` });
      }
    }
  }
};

const ownedChildren = async (
  deployed: DeployedCatalog,
  db: Db,
  parent: number,
): Promise<readonly { readonly eid: number; readonly field: string }[]> => {
  const out: { eid: number; field: string }[] = [];
  for (const datom of await db.datomsArray(Index.EAVT, { e: parent })) {
    const ident = db.schema.ident(datom.a);
    if (ident === undefined || typeof datom.v !== "number") continue;
    const descriptor = deployed.unit.catalog.fields.find((field) =>
      field.owned && field.valueType === "ref" && fieldIdent(field) === ident
    );
    if (descriptor !== undefined) out.push({ eid: datom.v, field: ident });
  }
  return out;
};

const planCascades = async (
  deployed: DeployedCatalog,
  before: Db,
  after: Db,
  direct: readonly number[],
): Promise<readonly PlannedCascadeRetraction[]> => {
  const out: PlannedCascadeRetraction[] = [];
  const seen = new Set(direct);
  const queue = direct.map((eid) => ({ parent: eid, eid }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of await ownedChildren(deployed, before, current.eid)) {
      if (seen.has(child.eid)) continue;
      seen.add(child.eid);
      const type = await targetType(before, child.eid);
      if (type === undefined || await after.exists(child.eid)) continue;
      out.push(Object.freeze({
        parent: current.eid,
        entity: child.eid,
        type,
        field: child.field,
      }));
      queue.push({ parent: current.eid, eid: child.eid });
    }
  }
  return Object.freeze(out);
};

const plannedField = (
  entity: unknown,
  type: string,
  effect: CompiledCreationEffect,
): PlannedFieldEffect => Object.freeze({
  entity,
  type,
  field: effect.ident,
  value: effect.value,
  source: effect.source === "fixed"
    ? "fixed-value"
    : effect.source === "explicit"
    ? "body"
    : "engine-default",
});

const buildPlan = async (
  deployed: DeployedCatalog,
  operation: DeployedOperation,
  intents: readonly BodyIntent[],
  currentDb: Db,
  now: number,
): Promise<InternalOperationPlan> => {
  const aliases = new Map<string, number>();
  const putState = new Map<BodyIntent, {
    readonly explicit: readonly CompiledCreationEffect[];
    readonly existing: number | undefined;
  }>();
  for (const intent of intents) {
    if (intent._tag !== "put") continue;
    const explicit = explicitEffects(deployed, intent.type, intent.input);
    const existing = await resolveExisting(
      currentDb,
      intent.type,
      intent.entity,
      explicit,
      deployed,
    );
    const lowered = lowerSubject(intent.entity);
    if (existing !== undefined && typeof lowered === "string") aliases.set(lowered, existing);
    putState.set(intent, { explicit, existing });
  }
  const plannedTypes = new Map<string, string>();
  for (const [intent, state] of putState) {
    const lowered = lowerSubject(intent.entity);
    if (state.existing === undefined && typeof lowered === "string") {
      plannedTypes.set(lowered, intent.type);
    }
  }

  const tx: TxOp[] = [];
  const engineDefaults: PlannedFieldEffect[] = [];
  const fixedValues: PlannedFieldEffect[] = [];
  const protectedTypeStamps: PlannedFieldEffect[] = [];
  const allAdds: PlannedFieldEffect[] = [];
  const requireConcreteType = async (
    intent: BodyIntent,
    subject: unknown,
  ): Promise<string> => {
    if (typeof subject === "string") {
      const planned = plannedTypes.get(subject);
      if (planned !== undefined) {
        if (planned !== intent.type) {
          throw new InvalidRequest({
            message: "operation declared entity does not match the planned row type",
          });
        }
        if (intent.source === "declared") ensureDeclaredType(operation, planned);
        return planned;
      }
    }
    const eid = await resolvePlanSubject(subject, aliases, {}, currentDb);
    if (eid === undefined || !(await currentDb.exists(eid))) {
      throw new InvalidRequest({ message: "operation write target does not exist" });
    }
    const concrete = await targetType(currentDb, eid);
    if (concrete === undefined || concrete !== intent.type) {
      throw new InvalidRequest({
        message: "operation declared entity does not match the concrete row type",
      });
    }
    if (intent.source === "declared") ensureDeclaredType(operation, concrete);
    return concrete;
  };
  for (const intent of intents) {
    const loweredSubject = lowerSubject(intent.entity);
    const subject = typeof loweredSubject === "string"
      ? aliases.get(loweredSubject) ?? loweredSubject
      : loweredSubject;
    if (intent._tag === "field") {
      const concreteType = await requireConcreteType(intent, subject);
      ensureBodyField(deployed, operation, concreteType, intent.field, intent.source);
      const effect: PlannedFieldEffect = Object.freeze({
        entity: subject,
        type: concreteType,
        field: fieldIdent(intent.field),
        value: intent.value,
        source: "body",
      });
      if (intent.action === "set") {
        tx.push([":db/add", subject, effect.field, lowerWriteValue(intent.value)]);
        allAdds.push(effect);
      } else if (intent.value === undefined) {
        tx.push([":db/retract", subject, effect.field]);
      } else {
        tx.push([":db/retract", subject, effect.field, lowerWriteValue(intent.value)]);
      }
      continue;
    }
    if (intent._tag === "delete") {
      await requireConcreteType(intent, subject);
      tx.push([":db/retractEntity", subject]);
      continue;
    }

    const explicit = intent._tag === "put"
      ? putState.get(intent)!.explicit
      : explicitEffects(deployed, intent.type, intent.input);
    const existing = intent._tag === "put" ? putState.get(intent)!.existing : undefined;
    const creates = intent._tag === "put" && existing === undefined && typeof subject === "string";
    if (!creates) {
      await requireConcreteType(intent, subject);
      for (const effect of explicit) {
        const field = fieldByKey(deployed, intent.type, effect.key);
        appendFieldOps(tx, subject, effect, field, true);
        allAdds.push(plannedField(subject, intent.type, effect));
      }
      if (intent._tag === "update" && explicit.length === 0) {
        tx.push([":db/update", subject]);
      }
      continue;
    }

    let effects: readonly CompiledCreationEffect[];
    try {
      effects = resolveCompiledCreationEffects(
        creationPlanOf(deployed, intent.type),
        intent.input,
        { now: new Date(now) },
      );
    } catch (cause) {
      throw new InvalidRequest({
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const map: Record<string, unknown> = {
      ":db/id": subject,
      ":ramose/type": `:${intent.type}`,
    };
    markEngineTypeAssertion(map);
    const extras: TxOp[] = [];
    for (const effect of effects) {
      const field = fieldByKey(deployed, intent.type, effect.key);
      const planned = plannedField(subject, intent.type, effect);
      allAdds.push(planned);
      if (planned.source === "fixed-value") fixedValues.push(planned);
      if (planned.source === "engine-default") engineDefaults.push(planned);
      if (field.cardinality === "many") {
        appendFieldOps(extras, subject, effect, field, false);
      } else {
        map[effect.ident] = lowerWriteValue(effect.value);
      }
    }
    tx.push(map, ...extras);
    protectedTypeStamps.push(Object.freeze({
      entity: subject,
      type: intent.type,
      field: ":ramose/type",
      value: `:${intent.type}`,
      source: "protected-type",
    }));
  }

  const result = await processTx(
    currentDb,
    tx,
    currentDb.basisT + 1,
    currentDb.nextEid,
    now,
    { composition: deployed.composition },
  );
  const after = dbAfter(currentDb, result.datoms, result.nextEid, deployed);
  await validateRefEffects(allAdds, deployed, after, aliases, result.tempids);
  const directDeletes: number[] = [];
  for (const intent of intents) {
    if (intent._tag !== "delete") continue;
    const eid = await resolvePlanSubject(intent.entity, aliases, result.tempids, currentDb);
    if (eid !== undefined) directDeletes.push(eid);
  }
  const cascadeRetractions = await planCascades(
    deployed,
    currentDb,
    after,
    directDeletes,
  );
  return Object.freeze({
    bodyIntents: Object.freeze([...intents]),
    engineDefaults: Object.freeze(engineDefaults),
    fixedValues: Object.freeze(fixedValues),
    protectedTypeStamps: Object.freeze(protectedTypeStamps),
    cascadeRetractions,
    tx: [...tx],
    expectedDatoms: Object.freeze([...result.datoms]),
    aliases: Object.freeze(aliases),
    dbAfter: after,
  });
};

const sameDatom = (left: Datom, right: Datom): boolean =>
  left.e === right.e && left.a === right.a && left.t === right.t &&
  left.op === right.op && left.vt === right.vt && sameAtom(left.v, right.v);

const validateReport = (
  plan: InternalOperationPlan,
  report: TxReport,
): void => {
  if (
    report.txData.length !== plan.expectedDatoms.length ||
    report.txData.some((datom, index) => !sameDatom(datom, plan.expectedDatoms[index]!))
  ) {
    throw new InvalidRequest({
      message: "operation transaction report does not match its authoritative plan",
    });
  }
};

const makeBodyOp = (args: {
  readonly definition: DeployedOperation;
  readonly dbName: string;
  readonly principal: AuthorizationPrincipal;
  readonly filteredDb: Db;
  readonly currentDb: Db;
  readonly deployed: DeployedCatalog;
  readonly target: number | undefined;
  readonly targetType: string | undefined;
  readonly now: number;
}): {
  readonly op: Op<any, any>;
  readonly intents: readonly BodyIntent[];
  readonly plan: () => Promise<InternalOperationPlan>;
} => {
  const intents: BodyIntent[] = [];
  let nextTempid = 0;
  const declaredHandle = (type: string, entity: unknown): AnyOpHandle => {
    ensureDeclaredType(args.definition, type);
    return makeHandle(entity, { type, source: "declared" }, intents, args.deployed, args.definition);
  };
  const self = args.target === undefined || args.targetType === undefined
    ? undefined
    : makeHandle(
        args.target,
        { type: args.targetType, source: "self" },
        intents,
        args.deployed,
        args.definition,
      );
  const opPrincipal: OpPrincipal = Object.freeze({
    eid: args.principal.me?.eid ?? null,
    class: args.principal.classes[0] ?? "",
    sub: args.principal.subject,
    claims: args.principal.claims,
  });
  const tentative = async (): Promise<Db> => {
    const plan = await buildPlan(
      args.deployed,
      args.definition,
      intents,
      args.currentDb,
      args.now,
    );
    return plan.dbAfter.filter(compileReadFilter({
      unit: args.deployed.unit,
      principal: args.principal,
      currentDb: plan.dbAfter,
    }));
  };
  const bodyOp: Op<any, any> = {
    self: self as never,
    principal: opPrincipal,
    db: args.dbName,
    entity: ((first?: unknown, second?: unknown) => {
      if (second !== undefined) {
        return declaredHandle(definitionType(first), second);
      }
      const metadata = subjectMetadata(first);
      if (metadata !== undefined) {
        return makeHandle(lowerSubject(first), metadata, intents, args.deployed, args.definition);
      }
      const type = args.definition.owner.kind === "entity"
        ? args.definition.owner.name
        : args.targetType;
      if (type === undefined) {
        throw new InvalidRequest({ message: "static trait operation needs an entity definition" });
      }
      return makeHandle(first, {
        type,
        source: args.definition.owner.kind === "entity" ? "declared" : "self",
      }, intents, args.deployed, args.definition);
    }) as Op<any, any>["entity"],
    tempid,
    set: ((...values: unknown[]) => {
      const withDefinition = catalogSymbolOf(values[0])?.kind === "entity";
      const subject = values[withDefinition ? 1 : 0];
      const field = definitionField(values[withDefinition ? 2 : 1], args.definition);
      const value = values[withDefinition ? 3 : 2];
      const metadata = withDefinition
        ? { type: definitionType(values[0]), source: "declared" as const }
        : subjectMetadata(subject) ?? (
          args.targetType === undefined
            ? undefined
            : { type: args.targetType, source: "self" as const }
        );
      if (metadata === undefined) throw new InvalidRequest({ message: "operation write has no entity type" });
      ensureBodyField(args.deployed, args.definition, metadata.type, field, metadata.source);
      intents.push({
        _tag: "field",
        action: "set",
        entity: subject,
        type: metadata.type,
        field,
        value,
        source: metadata.source,
      });
    }) as Op<any, any>["set"],
    remove: ((...values: unknown[]) => {
      const withDefinition = catalogSymbolOf(values[0])?.kind === "entity";
      const subject = values[withDefinition ? 1 : 0];
      const field = definitionField(values[withDefinition ? 2 : 1], args.definition);
      const value = values[withDefinition ? 3 : 2];
      const metadata = withDefinition
        ? { type: definitionType(values[0]), source: "declared" as const }
        : subjectMetadata(subject) ?? (
          args.targetType === undefined
            ? undefined
            : { type: args.targetType, source: "self" as const }
        );
      if (metadata === undefined) throw new InvalidRequest({ message: "operation write has no entity type" });
      ensureBodyField(args.deployed, args.definition, metadata.type, field, metadata.source);
      intents.push({
        _tag: "field",
        action: "remove",
        entity: subject,
        type: metadata.type,
        field,
        ...(value === undefined ? {} : { value }),
        source: metadata.source,
      });
    }) as Op<any, any>["remove"],
    delete: ((...values: unknown[]) => {
      const withDefinition = catalogSymbolOf(values[0])?.kind === "entity";
      const subject = values[withDefinition ? 1 : 0];
      const metadata = withDefinition
        ? { type: definitionType(values[0]), source: "declared" as const }
        : subjectMetadata(subject) ?? (
          args.targetType === undefined
            ? undefined
            : { type: args.targetType, source: "self" as const }
        );
      if (metadata === undefined) throw new InvalidRequest({ message: "operation delete has no entity type" });
      if (metadata.source === "declared") ensureDeclaredType(args.definition, metadata.type);
      intents.push({ _tag: "delete", entity: subject, ...metadata });
    }) as Op<any, any>["delete"],
    put: ((definition: unknown, first: unknown, second?: unknown) => {
      const type = definitionType(definition);
      ensureDeclaredType(args.definition, type);
      const entity = second === undefined ? `op-${++nextTempid}` : first;
      const input = asRecord(second === undefined ? first : second);
      explicitEffects(args.deployed, type, input);
      intents.push({ _tag: "put", entity, type, input, source: "declared" });
      return declaredHandle(type, entity);
    }) as Op<any, any>["put"],
    update: ((definition: unknown, first: unknown, second?: unknown) => {
      const type = definitionType(definition);
      ensureDeclaredType(args.definition, type);
      const input = asRecord(second === undefined ? first : second);
      const explicit = explicitEffects(args.deployed, type, input);
      let entity: unknown = first;
      if (second === undefined) {
        const upsert = explicit.find((effect) =>
          args.deployed.unit.catalog.fields.some((field) =>
            field.unique === "upsert" && fieldIdent(field) === effect.ident
          )
        );
        if (upsert === undefined) {
          throw new InvalidRequest({ message: 'update map form needs a unique: "upsert" field' });
        }
        entity = [upsert.ident, lowerWriteValue(upsert.value)];
      }
      intents.push({ _tag: "update", entity, type, input, source: "declared" });
      return declaredHandle(type, entity);
    }) as Op<any, any>["update"],
    query: (async (input: AnyQueryObject) => {
      const lowered = tryLowerQueryObject(input);
      const result = await query(await tentative(), lowered.query, []);
      const finalized = lowered.finalize(result);
      if (finalized instanceof Error) throw finalized;
      return finalized;
    }) as Op<any, any>["query"],
    pull: async (subject, pattern) => {
      const db = await tentative();
      const eid = await resolveTarget(db, subject);
      if (eid === undefined) return null;
      return pull(db, eid, normalizePullPattern(lowerPullPattern(pattern)));
    },
    effect: async () => {
      throw new OperationRejected({
        message: "authoritative operations must be deterministic",
        operation: operationLabel(args.definition.id),
        step: "body",
        reason: "effect",
      });
    },
  };
  if (!args.definition.self && args.definition.owner.kind === "entity") {
    Object.defineProperty(bodyOp, "create", {
      enumerable: true,
      value: (attrs: unknown) => {
        const type = args.definition.owner.name;
        const entity = `op-${++nextTempid}`;
        const input = asRecord(attrs);
        explicitEffects(args.deployed, type, input);
        intents.push({ _tag: "put", entity, type, input, source: "declared" });
        return declaredHandle(type, entity);
      },
    });
  }
  return {
    op: Object.freeze(bodyOp),
    intents,
    plan: () => buildPlan(
      args.deployed,
      args.definition,
      intents,
      args.currentDb,
      args.now,
    ),
  };
};

const resolveOutputHandles = async (
  value: unknown,
  report: TxReport,
  aliases: ReadonlyMap<string, number>,
): Promise<unknown> => {
  if (typeof value !== "object" || value === null) return value;
  if ((value as { readonly _tag?: unknown })._tag === "TxHandle") {
    const eid = lowerSubject(value);
    if (typeof eid === "number") return eid;
    if (typeof eid === "string") return aliases.get(eid) ?? report.tempids[eid];
    if (Array.isArray(eid)) return report.dbAfter.entid(eid as EntityRef);
    return undefined;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveOutputHandles(item, report, aliases)));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    out[key] = await resolveOutputHandles(item, report, aliases);
  }
  return out;
};

const validateOutputVisibility = async (
  shape: OperationInputShape,
  value: unknown,
  db: Db,
  deployed: DeployedCatalog,
  operation: OperationId,
): Promise<void> => {
  switch (shape._tag) {
    case "scalar":
    case "opaque": return;
    case "array":
      if (!Array.isArray(value)) throw new InvalidRequest({ message: "invalid operation output" });
      for (const item of value) {
        await validateOutputVisibility(shape.items, item, db, deployed, operation);
      }
      return;
    case "struct":
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new InvalidRequest({ message: "invalid operation output" });
      }
      for (const field of shape.fields) {
        if (!Object.hasOwn(value, field.key)) {
          if (!field.optional) throw new InvalidRequest({ message: "invalid operation output" });
          continue;
        }
        await validateOutputVisibility(
          field.shape,
          (value as Record<string, unknown>)[field.key],
          db,
          deployed,
          operation,
        );
      }
      return;
    case "ref": {
      if (typeof value !== "number" || !(await db.exists(value))) throw policyDenied();
      const type = await targetType(db, value);
      if (type === undefined) throw policyDenied();
      const target = shape.refTarget;
      if (target._tag === "entity" && target.entity.name !== type) throw policyDenied();
      if (
        target._tag === "trait" &&
        !deployed.composition.transitiveTraits(`:${type}`).includes(`:${target.trait.name}`)
      ) throw policyDenied();
      if (target._tag === "self" && !targetFits(deployed, operation, type)) throw policyDenied();
    }
  }
};

export type PreparedOperation = {
  readonly tx: TxData;
  readonly principal: Principal;
  readonly plan: OperationPlan;
  readonly beforeCommit: (report: TxReport) => Promise<unknown>;
};

export const prepareAuthorizedOperation = async (args: {
  readonly deployed: DeployedCatalog;
  readonly definition: DeployedOperation;
  readonly caller: AuthenticatedCaller;
  readonly principal: Principal;
  readonly dbName: string;
  readonly currentDb: Db;
  readonly target: unknown;
  readonly input: unknown;
  readonly now: number;
}): Promise<PreparedOperation> => {
  const current = await authorizeCurrentDb(
    args.deployed.unit,
    args.caller,
    args.currentDb,
    args.now,
  );
  if (Result.isFailure(current)) throw policyDenied();
  const auth = current.success;
  if (!isGranted(args.deployed, args.definition.id, auth.principal)) throw policyDenied();

  let target: number | undefined;
  let concreteTargetType: string | undefined;
  if (args.definition.self) {
    target = await resolveTarget(auth.db, args.target);
    if (target === undefined) throw policyDenied();
    concreteTargetType = await targetType(auth.db, target);
    if (
      concreteTargetType === undefined ||
      !targetFits(args.deployed, args.definition.id, concreteTargetType)
    ) throw policyDenied();
  } else if (args.target !== undefined) {
    throw policyDenied();
  }

  let decoded: unknown;
  try {
    decoded = args.definition.input.decode(args.input);
  } catch (cause) {
    throw new InvalidRequest({
      message: cause instanceof Error ? cause.message : "invalid operation input",
    });
  }
  await validateOutputVisibility(
    args.definition.descriptor.input,
    decoded,
    auth.db,
    args.deployed,
    args.definition.id,
  );
  const built = makeBodyOp({
    definition: args.definition,
    dbName: args.dbName,
    principal: auth.principal,
    filteredDb: auth.db,
    currentDb: args.currentDb,
    deployed: args.deployed,
    target,
    targetType: concreteTargetType,
    now: args.now,
  });
  let output: unknown;
  try {
    output = await args.definition.body(built.op, decoded);
  } catch (cause) {
    if (
      cause instanceof OperationRejected ||
      cause instanceof InvalidRequest ||
      cause instanceof Unauthorized
    ) throw cause;
    throw new OperationRejected({
      message: cause instanceof Error ? cause.message : String(cause),
      operation: operationLabel(args.definition.id),
      step: "body",
    });
  }
  const plan = await built.plan();
  return {
    tx: plan.tx,
    principal: args.principal,
    plan,
    beforeCommit: async (report) => {
      validateReport(plan, report);
      const resolved = await resolveOutputHandles(output, report, plan.aliases);
      let encoded: unknown;
      try {
        encoded = args.definition.output.encode(resolved);
      } catch (cause) {
        throw new InvalidRequest({
          message: cause instanceof Error ? cause.message : "invalid operation output",
        });
      }
      const filteredAfter = report.dbAfter.filter(compileReadFilter({
        unit: args.deployed.unit,
        principal: auth.principal,
        currentDb: report.dbAfter,
      }));
      await validateOutputVisibility(
        args.definition.descriptor.output,
        resolved,
        filteredAfter,
        args.deployed,
        args.definition.id,
      );
      return encoded;
    },
  };
};
