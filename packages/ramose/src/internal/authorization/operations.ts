/**
 * Catalog-bound operation admission, execution, and commit (#417).
 *
 * Reuses {@link admitAuthorizedRequest}: deployment-global JWT, trusted
 * route/database, catalog-key/unit-hash agreement, and the ordinary
 * filtered current {@link Db}. Operation permission and target visibility
 * stay separate. There is no second authorizer, raw-write escape, or
 * parallel visibility path.
 */

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { lowerAttr } from "../../db/attrRef.ts";
import {
  InvalidRequest,
  OperationRejected,
  TxRejected,
  Unauthorized,
} from "../../db/Errors.ts";
import type { AnyEntity } from "../../db/Entity.ts";
import {
  decodeInput,
  encodeOutput,
  type AnyOperation,
  type AnyOperations,
  type Op,
  type OpHandle,
  type OpPrincipal,
  type OutputDraft,
} from "../../db/Operation.ts";
import type { AnySchema } from "../../db/Schema.ts";
import {
  isTxHandle,
  txBuilder,
  txOps,
  type TxHandle,
  type TxMap,
  type TxOp,
} from "../../db/Tx.ts";
import { Index } from "../core/datom.ts";
import type { Db } from "../core/db.ts";
import { query } from "../core/query/engine.ts";
import { pull } from "../core/query/pull.ts";
import { RAMOSE_TYPE } from "../core/schema.ts";
import { TxError, type TxData } from "../core/tx.ts";
import { MAX_READ_LEASE_MS } from "./bounds.ts";
import type { FieldDescriptor, FieldRefTarget, OperationDescriptor } from "./catalog.ts";
import type { InstalledCatalogUnitV1 } from "./catalog-unit.ts";
import type { CanonicalAuthorizationExpr, CanonicalValueTerm } from "./expr.ts";
import type { OperationId, OperationTarget, OwnerRef } from "./identities.ts";
import type { Decision } from "./ir.ts";
import type { JsonValue } from "./json.ts";
import type { AuthorizationPrincipal } from "./principal.ts";
import { compileReadFilter, uniqueCanonicalTypeName } from "./read-filter.ts";
import {
  admitAuthorizedRequest,
  type AdmittedAuthorizedRequest,
  type AuthorizedRequestInput,
} from "./request.ts";
import {
  False,
  FieldAbsent,
  Incomplete,
  InvalidTraversalProjection,
  MissingMeProjection,
  Present,
  True,
  type Projected,
  type ProjectedValue,
  type Truth,
} from "./truth.ts";
import {
  entityComposes,
  prepareAuthorizationCatalog,
  type PreparedAuthorizationCatalog,
} from "./validation/catalog.ts";
import { InvalidTraversal, MissingMe } from "./failures.ts";

export type OperationEntityRef = number | string | readonly [string, unknown];

export type OperationInvocation = {
  readonly owner: OwnerRef;
  readonly localName: string;
  readonly target: OperationTarget;
  readonly entity?: OperationEntityRef;
  readonly input: unknown;
};

export type OperationCommitReport = {
  readonly tempids: Record<string, number>;
  readonly dbAfter: Db;
};

export type AuthorizedWriteInput<R = never, EDb = unknown> = AuthorizedRequestInput<R, EDb> & {
  readonly operations?: AnyOperations;
  readonly commit: (tx: TxData) => Effect.Effect<OperationCommitReport, unknown, R>;
  readonly effectEnv?: unknown;
};

const deny = (): Unauthorized => new Unauthorized({});

const rejected = (
  operation: string,
  message: string,
  reason?: string,
): OperationRejected =>
  new OperationRejected({
    message,
    operation,
    ...(reason === undefined ? {} : { reason }),
  });

const wireNameOf = (owner: OwnerRef, localName: string): string =>
  `${owner.name}/${localName}`;

const sameOperation = (left: OperationId, owner: OwnerRef, localName: string, target: OperationTarget) =>
  left.owner.kind === owner.kind &&
  left.owner.name === owner.name &&
  left.localName === localName &&
  left.target === target;

const findDescriptor = (
  unit: InstalledCatalogUnitV1,
  owner: OwnerRef,
  localName: string,
  target: OperationTarget,
): OperationDescriptor | undefined =>
  unit.catalog.operations.find((operation) =>
    sameOperation(operation.id, owner, localName, target),
  );

const findDecision = (
  unit: InstalledCatalogUnitV1,
  owner: OwnerRef,
  localName: string,
  target: OperationTarget,
): Decision | undefined =>
  (unit.policy.decisions.operations ?? []).find((entry) =>
    sameOperation(entry.target, owner, localName, target),
  )?.decision;

const findBody = (
  operations: AnyOperations | undefined,
  owner: OwnerRef,
  localName: string,
): AnyOperation | undefined => {
  if (operations === undefined) return undefined;
  const wire = wireNameOf(owner, localName);
  return operations.get(wire) ?? operations.get(localName);
};

const catalogTargetOf = (unit: InstalledCatalogUnitV1) => ({
  database: unit.catalog.database,
  catalog: unit.catalog.id,
  catalogVersion: unit.catalog.version,
  schemaFingerprint: unit.catalog.fingerprint,
});

const preparedOf = (
  unit: InstalledCatalogUnitV1,
): Result.Result<PreparedAuthorizationCatalog, Unauthorized> => {
  try {
    const prepared = prepareAuthorizationCatalog(catalogTargetOf(unit), unit.catalog);
    return Result.isFailure(prepared) ? Result.fail(deny()) : Result.succeed(prepared.success);
  } catch {
    return Result.fail(deny());
  }
};

const atomsEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }
  return false;
};

const projectedEqual = (left: ProjectedValue, right: ProjectedValue): boolean => {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i++) {
      if (!atomsEqual(left[i], right[i])) return false;
    }
    return true;
  }
  return atomsEqual(left, right);
};

const isIncomplete = (
  value: Projected,
): boolean =>
  value._tag === "NotLoaded" ||
  value._tag === "InvalidTraversal" ||
  value._tag === "BudgetExhausted" ||
  value._tag === "MissingMe";

const incompleteOf = (value: Projected): Truth => {
  if (value._tag === "MissingMe") return Incomplete(MissingMe);
  return Incomplete(InvalidTraversal);
};

const eqTruth = (left: Projected, right: Projected): Truth => {
  if (isIncomplete(left)) return incompleteOf(left);
  if (isIncomplete(right)) return incompleteOf(right);
  if (left._tag !== "Present" || right._tag !== "Present") return False;
  return projectedEqual(left.value, right.value) ? True : False;
};

const hasTruth = (term: Projected): Truth => {
  if (term._tag === "Present") return True;
  if (term._tag === "FieldAbsent" || term._tag === "EntityAbsent") return False;
  return incompleteOf(term);
};

const inTruth = (value: Projected, collection: Projected): Truth => {
  if (isIncomplete(value)) return incompleteOf(value);
  if (isIncomplete(collection)) return incompleteOf(collection);
  if (value._tag !== "Present" || collection._tag !== "Present") return False;
  if (!Array.isArray(collection.value)) return Incomplete(InvalidTraversal);
  for (const item of collection.value) {
    if (atomsEqual(value.value, item)) return True;
  }
  return False;
};

const andTruth = (parts: readonly Truth[]): Truth => {
  let incomplete: Truth | undefined;
  for (const part of parts) {
    if (part._tag === "False") return False;
    if (part._tag === "Incomplete") incomplete = part;
  }
  return incomplete ?? True;
};

const orTruth = (parts: readonly Truth[]): Truth => {
  let incomplete: Truth | undefined;
  for (const part of parts) {
    if (part._tag === "True") return True;
    if (part._tag === "Incomplete") incomplete = part;
  }
  return incomplete ?? False;
};

const notTruth = (value: Truth): Truth => {
  if (value._tag === "True") return False;
  if (value._tag === "False") return True;
  return value;
};

const projectPrincipalTerm = (
  term: CanonicalValueTerm,
  principal: AuthorizationPrincipal,
): Projected => {
  switch (term._tag) {
    case "lit":
      return Present(term.value as ProjectedValue);
    case "subject":
      return Present(principal.subject);
    case "me":
      return principal.me === undefined ? MissingMeProjection : Present(principal.me.eid);
    case "claim": {
      if (!Object.hasOwn(principal.claims, term.key)) return FieldAbsent;
      const value = principal.claims[term.key];
      if (value === undefined) return FieldAbsent;
      return Present(value as ProjectedValue);
    }
    case "ref":
      // Operation grants are principal-only. A resource path is a compile defect.
      return InvalidTraversalProjection;
  }
};

const evalPrincipalExpr = (
  expr: CanonicalAuthorizationExpr,
  principal: AuthorizationPrincipal,
): Truth => {
  switch (expr._tag) {
    case "const":
      return expr.value ? True : False;
    case "hasClass":
      return principal.classes.includes(expr.class) ? True : False;
    case "and": {
      const parts = expr.exprs.map((child) => evalPrincipalExpr(child, principal));
      return andTruth(parts);
    }
    case "or": {
      const parts = expr.exprs.map((child) => evalPrincipalExpr(child, principal));
      return orTruth(parts);
    }
    case "not":
      return notTruth(evalPrincipalExpr(expr.expr, principal));
    case "eq":
      return eqTruth(
        projectPrincipalTerm(expr.left, principal),
        projectPrincipalTerm(expr.right, principal),
      );
    case "has":
      return hasTruth(projectPrincipalTerm(expr.term, principal));
    case "in":
      return inTruth(
        projectPrincipalTerm(expr.value, principal),
        projectPrincipalTerm(expr.collection, principal),
      );
    default:
      return Incomplete(InvalidTraversal);
  }
};

/** Same truth model as the read filter: deny wins, missing is deny, only True allows. */
export const evaluatePrincipalDecision = (
  unit: InstalledCatalogUnitV1,
  principal: AuthorizationPrincipal,
  decision: Decision | undefined,
): boolean => {
  if (decision === undefined) return false;
  const rules = new Map(unit.policy.rules.map((rule) => [rule.id, rule.expr]));
  for (const id of decision.deny) {
    const expr = rules.get(id);
    if (expr === undefined) return false;
    if (evalPrincipalExpr(expr, principal)._tag !== "False") return false;
  }
  for (const id of decision.allow) {
    const expr = rules.get(id);
    if (expr === undefined) continue;
    if (evalPrincipalExpr(expr, principal)._tag === "True") return true;
  }
  return false;
};

const resolveEid = async (db: Db, ref: OperationEntityRef): Promise<number | undefined> => {
  if (typeof ref === "number") return Number.isInteger(ref) && ref >= 0 ? ref : undefined;
  if (typeof ref === "string") return db.entid(ref);
  if (Array.isArray(ref) && ref.length === 2 && typeof ref[0] === "string") {
    return db.entid([ref[0], ref[1]]);
  }
  return undefined;
};

const classifyType = async (db: Db, eid: number): Promise<string | undefined> => {
  const typeDatoms = await db.datomsArray(Index.EAVT, { e: eid, a: RAMOSE_TYPE });
  return uniqueCanonicalTypeName(typeDatoms);
};

const targetCompatible = (
  index: PreparedAuthorizationCatalog,
  owner: OwnerRef,
  typeName: string,
): boolean => {
  const entity = index.entities.get(typeName);
  if (entity === undefined) return false;
  if (owner.kind === "entity") return owner.name === typeName;
  return entityComposes(index, entity, owner.name);
};

const isProtectedIdent = (ident: string): boolean =>
  ident === ":db/id" ? false : ident.startsWith(":db/") || ident.startsWith(":ramose/");

const fieldIdentOf = (field: FieldDescriptor): string =>
  `:${field.id.owner.name}/${field.id.localName}`;

const fieldsOfComposer = (
  unit: InstalledCatalogUnitV1,
  typeName: string,
): FieldDescriptor[] => {
  const composed = new Set<string>([typeName]);
  for (const row of unit.catalog.traitComposition) {
    if (row.composer.name === typeName) {
      composed.add(row.trait.name);
      for (const trait of row.transitive) composed.add(trait.name);
    }
  }
  return unit.catalog.fields.filter((field) => composed.has(field.id.owner.name));
};

const compositionValuesOf = (
  unit: InstalledCatalogUnitV1,
  typeName: string,
): Readonly<Record<string, JsonValue>> => {
  const values: Record<string, JsonValue> = {};
  for (const row of unit.catalog.traitComposition) {
    if (row.composer.name !== typeName || row.values === undefined) continue;
    for (const [key, value] of Object.entries(row.values)) values[key] = value;
  }
  return values;
};

const jsonEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  if (typeof left !== "object") return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

const applyCreateBindings = (
  unit: InstalledCatalogUnitV1,
  typeName: string,
  attrs: Record<string, unknown>,
  operation: string,
): Record<string, unknown> => {
  const out = { ...attrs };
  const composed = compositionValuesOf(unit, typeName);
  for (const field of fieldsOfComposer(unit, typeName)) {
    const ident = fieldIdentOf(field);
    const key = field.id.localName;
    const fixed = field.fixedValue ?? composed[key];
    const present = Object.hasOwn(out, ident)
      ? out[ident]
      : Object.hasOwn(out, key)
        ? out[key]
        : undefined;
    const hasPresent = Object.hasOwn(out, ident) || Object.hasOwn(out, key);
    if (fixed !== undefined) {
      if (hasPresent && present !== undefined && !jsonEqual(present, fixed)) {
        throw rejected(operation, `cannot forge fixed field ${ident}`, "tx/system");
      }
      delete out[key];
      out[ident] = fixed;
      continue;
    }
    if (!hasPresent || present === undefined) {
      if (field.defaultValue !== undefined) {
        delete out[key];
        out[ident] = field.defaultValue;
      }
    } else if (Object.hasOwn(out, key) && !Object.hasOwn(out, ident)) {
      out[ident] = out[key];
      delete out[key];
    }
  }
  return out;
};

const nsOfIdent = (ident: string): string => {
  const slash = ident.indexOf("/", 1);
  return slash > 0 ? ident.slice(1, slash) : "";
};

const inferTypeName = (keys: readonly string[]): string | undefined => {
  const nss = new Set<string>();
  for (const key of keys) {
    if (key === ":db/id" || key.startsWith(":db/") || key.startsWith(":ramose/")) continue;
    const ns = nsOfIdent(key);
    if (ns.length > 0) nss.add(ns);
  }
  if (nss.size === 1) return [...nss][0];
  return undefined;
};

const isMapOp = (op: TxOp): op is TxMap =>
  typeof op === "object" && op !== null && !Array.isArray(op);

const assertMutableIdent = (ident: string, operation: string): void => {
  if (typeof ident !== "string" || ident.length === 0 || ident[0] !== ":") {
    throw rejected(operation, "invalid field", "tx/invalid");
  }
  if (isProtectedIdent(ident)) {
    throw rejected(operation, `cannot write ${ident}`, "tx/system");
  }
};

const stripProtected = (ops: readonly TxOp[], operation: string): TxOp[] => {
  const out: TxOp[] = [];
  for (const op of ops) {
    if (isMapOp(op)) {
      const map: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(op)) {
        if (key === ":db/id") {
          map[key] = value;
          continue;
        }
        if (key === ":ramose/type" || key === ":ramose/trait") continue;
        if (isProtectedIdent(key)) {
          throw rejected(operation, `cannot write ${key}`, "tx/system");
        }
        map[key] = value;
      }
      out.push(map);
      continue;
    }
    if (!Array.isArray(op) || op.length < 2) {
      out.push(op);
      continue;
    }
    const kind = op[0];
    if (kind === ":db/add" || kind === ":db/update" || kind === ":db/retract") {
      const ident = op[2];
      if (typeof ident === "string") {
        if (ident === ":ramose/type" || ident === ":ramose/trait") continue;
        if (isProtectedIdent(ident)) {
          throw rejected(operation, `cannot write ${ident}`, "tx/system");
        }
      }
    }
    out.push(op);
  }
  return out;
};

const stampCreates = (ops: readonly TxOp[], created: ReadonlyMap<unknown, string>): TxOp[] => {
  const stamped = ops.map((op) => {
    if (!isMapOp(op)) return op;
    const id = op[":db/id"];
    const type = created.get(id) ?? inferTypeName(Object.keys(op));
    if (type === undefined) return op;
    if (typeof id === "number") return op;
    return { ...op, ":ramose/type": `:${type}` };
  });
  return stamped;
};

const writtenIdentValues = (ops: readonly TxOp[]): Array<{ readonly ident: string; readonly value: unknown }> => {
  const out: Array<{ readonly ident: string; readonly value: unknown }> = [];
  for (const op of ops) {
    if (isMapOp(op)) {
      for (const [key, value] of Object.entries(op)) {
        if (key === ":db/id" || key.startsWith(":db/") || key.startsWith(":ramose/")) continue;
        out.push({ ident: key, value });
      }
      continue;
    }
    if (!Array.isArray(op) || op.length < 3) continue;
    if (op[0] !== ":db/add" && op[0] !== ":db/update") continue;
    if (typeof op[2] === "string") out.push({ ident: op[2], value: op[3] });
  }
  return out;
};

const rejectForgedFixed = (
  unit: InstalledCatalogUnitV1,
  ops: readonly TxOp[],
  created: ReadonlyMap<unknown, string>,
  operation: string,
): void => {
  const types = collectCreatedTypes(ops, created);
  for (const write of writtenIdentValues(ops)) {
    const field = fieldByIdent(unit, write.ident);
    if (field === undefined) continue;
    const typeName =
      field.id.owner.kind === "entity"
        ? field.id.owner.name
        : [...types.values()].find((name) =>
            unit.catalog.traitComposition.some(
              (row) => row.composer.name === name && (row.trait.name === field.id.owner.name || row.transitive.some((t) => t.name === field.id.owner.name)),
            ),
          );
    const composed = typeName === undefined ? {} : compositionValuesOf(unit, typeName);
    const fixed = field.fixedValue ?? composed[field.id.localName];
    if (fixed !== undefined && write.value !== undefined && !jsonEqual(write.value, fixed)) {
      throw rejected(operation, `cannot forge fixed field ${write.ident}`, "tx/system");
    }
  }
};

const applyBindingsToMaps = (
  unit: InstalledCatalogUnitV1,
  ops: readonly TxOp[],
  created: ReadonlyMap<unknown, string>,
  operation: string,
): TxOp[] =>
  ops.map((op) => {
    if (!isMapOp(op)) return op;
    const id = op[":db/id"];
    if (typeof id === "number") return op;
    const type = created.get(id) ?? inferTypeName(Object.keys(op));
    if (type === undefined) return op;
    const { ":db/id": dbId, ":ramose/type": typeStamp, ...attrs } = op as Record<string, unknown>;
    const bound = applyCreateBindings(unit, type, attrs, operation);
    return {
      ...(dbId === undefined ? {} : { ":db/id": dbId }),
      ...(typeStamp === undefined ? {} : { ":ramose/type": typeStamp }),
      ...bound,
    };
  });

const fieldByIdent = (
  unit: InstalledCatalogUnitV1,
  ident: string,
): FieldDescriptor | undefined =>
  unit.catalog.fields.find((field) => fieldIdentOf(field) === ident);

const refTargetOf = (field: FieldDescriptor): FieldRefTarget | undefined =>
  field.valueType === "ref" ? field.refTarget : undefined;

const collectCreatedTypes = (
  ops: readonly TxOp[],
  created: ReadonlyMap<unknown, string>,
): Map<unknown, string> => {
  const types = new Map<unknown, string>(created);
  for (const op of ops) {
    if (!isMapOp(op)) continue;
    const id = op[":db/id"];
    const stamped = op[":ramose/type"];
    if (typeof stamped === "string" && stamped.startsWith(":") && !stamped.includes("/")) {
      types.set(id, stamped.slice(1));
    } else {
      const inferred = created.get(id) ?? inferTypeName(Object.keys(op));
      if (inferred !== undefined) types.set(id, inferred);
    }
  }
  return types;
};

const resolveRefValue = (
  value: unknown,
  created: ReadonlyMap<unknown, string>,
): { readonly kind: "eid"; readonly eid: number } | { readonly kind: "tempid"; readonly id: unknown } | undefined => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { kind: "eid", eid: value };
  }
  if (isTxHandle(value)) {
    const id = (value as TxHandle).eid;
    if (typeof id === "number") return { kind: "eid", eid: id };
    return { kind: "tempid", id };
  }
  if (typeof value === "string") return { kind: "tempid", id: value };
  return undefined;
};

const typeOfRef = async (
  db: Db,
  created: ReadonlyMap<unknown, string>,
  value: unknown,
): Promise<string | undefined> => {
  const resolved = resolveRefValue(value, created);
  if (resolved === undefined) return undefined;
  if (resolved.kind === "tempid") return created.get(resolved.id);
  return (await classifyType(db, resolved.eid)) ?? created.get(resolved.eid);
};

const refCompatible = (
  index: PreparedAuthorizationCatalog,
  target: FieldRefTarget,
  typeName: string,
): boolean => {
  const entity = index.entities.get(typeName);
  if (entity === undefined) return false;
  if (target._tag === "untargeted") return true;
  if (target._tag === "self") return true;
  if (target._tag === "entity") return target.entity.name === typeName;
  return entityComposes(index, entity, target.trait.name);
};

const validateRefWrites = async (
  unit: InstalledCatalogUnitV1,
  index: PreparedAuthorizationCatalog,
  db: Db,
  ops: readonly TxOp[],
  created: ReadonlyMap<unknown, string>,
  operation: string,
): Promise<void> => {
  const types = collectCreatedTypes(ops, created);
  const check = async (ident: string, value: unknown): Promise<void> => {
    const field = fieldByIdent(unit, ident);
    if (field === undefined) return;
    const target = refTargetOf(field);
    if (target === undefined) return;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null) continue;
      const lookup =
        Array.isArray(item) && item.length === 2 && typeof item[0] === "string"
          ? await db.entid([item[0], item[1]])
          : undefined;
      const typeName =
        lookup !== undefined
          ? ((await classifyType(db, lookup)) ?? types.get(lookup))
          : await typeOfRef(db, types, item);
      if (typeName === undefined) {
        throw rejected(operation, `invalid ref target for ${ident}`, "tx/type-mismatch");
      }
      if (!refCompatible(index, target, typeName)) {
        throw rejected(operation, `invalid ref target for ${ident}`, "tx/wrong-entity");
      }
    }
  };

  for (const op of ops) {
    if (isMapOp(op)) {
      for (const [key, value] of Object.entries(op)) {
        if (key === ":db/id" || key.startsWith(":db/") || key.startsWith(":ramose/")) continue;
        await check(key, value);
      }
      continue;
    }
    if (!Array.isArray(op) || op.length < 4) continue;
    if (op[0] !== ":db/add" && op[0] !== ":db/update") continue;
    if (typeof op[2] !== "string") continue;
    await check(op[2], op[3]);
  }
};

const composerNs = (entity: unknown): string | undefined => {
  if (typeof entity === "object" && entity !== null && "ns" in entity) {
    const ns = (entity as { ns: unknown }).ns;
    if (typeof ns === "string" && ns.length > 0) return ns;
  }
  return undefined;
};

const runSync = <A>(effect: Effect.Effect<A>): A => Effect.runSync(effect);

const voidHandle = (handle: TxHandle, operation: string): OpHandle => ({
  _tag: "TxHandle",
  eid: handle.eid as OpHandle["eid"],
  set: (field, value) => {
    assertMutableIdent(lowerAttr(field), operation);
    runSync(handle.set(field as never, value as never));
  },
  remove: (field, value) => {
    assertMutableIdent(lowerAttr(field), operation);
    runSync(handle.remove(field as never, value as never));
  },
  delete: () => {
    runSync(handle.delete);
  },
});

const opPrincipalOf = (principal: AuthorizationPrincipal): OpPrincipal => ({
  eid: principal.me?.eid ?? null,
  class: principal.classes[0] ?? "",
  sub: principal.subject,
  claims: principal.claims,
});

const makeOp = (
  input: {
    readonly schema: AnySchema;
    readonly filteredDb: Db;
    readonly principal: AuthorizationPrincipal;
    readonly database: string;
    readonly operation: string;
    readonly selfEid?: number;
    readonly created: Map<unknown, string>;
    readonly effectEnv?: unknown;
  },
): { readonly op: Op; readonly tx: ReturnType<typeof txBuilder> } => {
  const tx = txBuilder(input.schema);
  const created = input.created;
  const operation = input.operation;
  const self =
    input.selfEid === undefined ? undefined : voidHandle(runSync(tx.entity(input.selfEid)), operation);

  const remember = (handle: TxHandle, entity: unknown): OpHandle => {
    const ns = composerNs(entity);
    if (ns !== undefined) created.set(handle.eid, ns);
    return voidHandle(handle, operation);
  };

  const op = {
    self,
    principal: opPrincipalOf(input.principal),
    db: input.database,
    entity: ((id?: unknown) =>
      voidHandle(
        id === undefined ? runSync(tx.entity()) : runSync(tx.entity(id as never)),
        operation,
      )) as Op["entity"],
    tempid: tx.tempid,
    set: (e: unknown, field: unknown, value: unknown) => {
      assertMutableIdent(lowerAttr(field), operation);
      runSync(tx.set(e as never, field as never, value as never));
    },
    remove: (e: unknown, field: unknown, value?: unknown) => {
      assertMutableIdent(lowerAttr(field), operation);
      runSync(tx.remove(e as never, field as never, value as never));
    },
    delete: (e: unknown) => {
      runSync(tx.delete(e as never));
    },
    put: ((entity: AnyEntity, a: unknown, b?: unknown) => {
      const attrs = ((b !== undefined ? b : a) ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(attrs)) {
        const ident = key.startsWith(":") ? key : `:${entity.ns}/${key}`;
        assertMutableIdent(ident, operation);
      }
      const handle =
        b !== undefined
          ? runSync(tx.put(entity as never, a as never, attrs as never))
          : runSync(tx.put(entity as never, attrs as never));
      return remember(handle, entity);
    }) as Op["put"],
    update: ((entity: AnyEntity, a: unknown, b?: unknown) => {
      const attrs = ((b !== undefined ? b : a) ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(attrs)) {
        const ident = key.startsWith(":") ? key : `:${entity.ns}/${key}`;
        assertMutableIdent(ident, operation);
      }
      const handle =
        b !== undefined
          ? runSync(tx.update(entity as never, a as never, attrs as never))
          : runSync(tx.update(entity as never, attrs as never));
      return voidHandle(handle, operation);
    }) as Op["update"],
    query: async (queryInput: unknown) => {
      const body = queryInput as { readonly query?: unknown; readonly inputs?: readonly unknown[] };
      const q = body.query ?? queryInput;
      const inputs = Array.isArray(body.inputs) ? [...body.inputs] : [];
      return query(input.filteredDb, q as string | object, inputs);
    },
    pull: async (subject: unknown, pattern: unknown) => {
      const eid =
        typeof subject === "number"
          ? subject
          : await input.filteredDb.entid(subject as never);
      if (eid === undefined) return null;
      return pull(input.filteredDb, eid, pattern as string | unknown[]);
    },
    effect: async (_name: string, run: (ctx: { readonly env: unknown; readonly principal: OpPrincipal }) => unknown) =>
      run({ env: input.effectEnv, principal: opPrincipalOf(input.principal) }),
  } as Op;

  return { op, tx };
};

const isHandleLike = (value: unknown): value is { readonly _tag: "TxHandle"; readonly eid: unknown } =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "TxHandle";

const resolveDraft = (value: unknown, tempids: Record<string, number>): unknown => {
  if (isHandleLike(value)) {
    const id = value.eid;
    if (typeof id === "number") return id;
    if (typeof id === "string") return tempids[id] ?? id;
    return id;
  }
  if (Array.isArray(value)) return value.map((item) => resolveDraft(item, tempids));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = resolveDraft(item, tempids);
    }
    return out;
  }
  return value;
};

const hideUnreadable = async (value: unknown, dbAfter: Db, filtered: Db): Promise<unknown> => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    if ((await dbAfter.exists(value)) && !(await filtered.exists(value))) return null;
    return value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => hideUnreadable(item, dbAfter, filtered)));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = await hideUnreadable(item, dbAfter, filtered);
    }
    return out;
  }
  return value;
};

const mapCommitError = (operation: string, cause: unknown): OperationRejected | Unauthorized => {
  if (cause instanceof Unauthorized) return cause;
  if (cause instanceof OperationRejected) return cause;
  if (cause instanceof TxRejected) {
    return rejected(operation, cause.message, cause.code);
  }
  if (cause instanceof TxError) {
    return rejected(operation, cause.message, cause.code);
  }
  if (cause instanceof Error) {
    return rejected(operation, cause.message);
  }
  return rejected(operation, String(cause));
};

const compilePredicate = (
  unit: InstalledCatalogUnitV1,
  principal: AuthorizationPrincipal,
  currentDb: Db,
) => {
  try {
    return Result.succeed(compileReadFilter({ unit, principal, currentDb }));
  } catch {
    return Result.fail(deny());
  }
};

const runOperation = async (
  input: AuthorizedWriteInput,
  admitted: AdmittedAuthorizedRequest,
  invocation: OperationInvocation,
): Promise<unknown> => {
  const unit = admitted.unit;
  const operation = wireNameOf(invocation.owner, invocation.localName);
  const descriptor = findDescriptor(unit, invocation.owner, invocation.localName, invocation.target);
  if (descriptor === undefined) throw deny();
  const granted = evaluatePrincipalDecision(
    unit,
    admitted.principal,
    findDecision(unit, invocation.owner, invocation.localName, invocation.target),
  );
  if (!granted) throw deny();

  const index = Result.getOrThrow(preparedOf(unit));
  let selfEid: number | undefined;
  if (descriptor.id.target === "required") {
    if (invocation.entity === undefined) throw deny();
    const eid = await resolveEid(admitted.filteredDb, invocation.entity);
    if (eid === undefined) throw deny();
    if (!(await admitted.filteredDb.exists(eid))) throw deny();
    const typeName = await classifyType(admitted.filteredDb, eid);
    if (typeName === undefined) throw deny();
    if (!targetCompatible(index, invocation.owner, typeName)) throw deny();
    selfEid = eid;
  } else if (invocation.entity !== undefined) {
    throw new InvalidRequest({ message: "static operation does not take a target" });
  }

  const body = findBody(input.operations, invocation.owner, invocation.localName);
  if (body === undefined) {
    throw rejected(operation, "operation is not registered", "unavailable");
  }

  const decoded = await Effect.runPromise(decodeInput(body.input, invocation.input));
  const created = new Map<unknown, string>();
  const { op, tx } = makeOp({
    schema: (input.operations?.schema ?? { entities: {} }) as AnySchema,
    filteredDb: admitted.filteredDb,
    principal: admitted.principal,
    database: unit.catalog.database,
    operation,
    created,
    ...(selfEid === undefined ? {} : { selfEid }),
    ...(input.effectEnv === undefined ? {} : { effectEnv: input.effectEnv }),
  });

  let draft: OutputDraft<unknown>;
  try {
    draft = await body.body(op, decoded);
  } catch (cause) {
    throw mapCommitError(operation, cause);
  }

  const stripped = stripProtected(txOps(tx), operation);
  rejectForgedFixed(unit, stripped, created, operation);
  const bound = applyBindingsToMaps(unit, stripped, created, operation);
  const stamped = stampCreates(bound, created);
  await validateRefWrites(unit, index, admitted.currentDb, stamped, created, operation);

  const report = await Effect.runPromise(
    input.commit(stamped as TxData).pipe(Effect.mapError((cause) => mapCommitError(operation, cause))),
  );

  const predicate = Result.getOrThrow(
    compilePredicate(unit, admitted.principal, report.dbAfter),
  );
  const filteredAfter = report.dbAfter.filter(predicate);
  const resolved = resolveDraft(draft, report.tempids);
  const encoded = await Effect.runPromise(encodeOutput(body.output, resolved));
  return hideUnreadable(encoded, report.dbAfter, filteredAfter);
};

export const executeAuthorizedWrite = Effect.fn("Authorization.executeAuthorizedWrite")(
  function* <R, EDb = unknown>(
    input: AuthorizedWriteInput<R, EDb>,
    invocation: OperationInvocation,
  ): Effect.fn.Return<unknown, Unauthorized | InvalidRequest | OperationRejected | EDb, R> {
    const limit = Duration.fromInputUnsafe(input.interruptAfter ?? MAX_READ_LEASE_MS);
    const program = Effect.gen(function* () {
      const caller = yield* input.authenticate.pipe(Effect.mapError(() => deny()));
      const nowMs = yield* Clock.currentTimeMillis;
      const remainingMs = caller.exp * 1_000 - nowMs;
      if (!Number.isSafeInteger(caller.exp) || remainingMs <= 0) return yield* deny();
      const duration = Duration.min(limit, Duration.millis(remainingMs));
      const rest = Effect.gen(function* () {
        const { view: _view, ...request } = input;
        const admitted = yield* admitAuthorizedRequest(request, caller);
        return yield* Effect.tryPromise({
          try: () =>
            runOperation(input as AuthorizedWriteInput, admitted, invocation),
          catch: (cause) => {
            if (cause instanceof Unauthorized) return cause;
            if (cause instanceof InvalidRequest) return cause;
            if (cause instanceof OperationRejected) return cause;
            return mapCommitError(wireNameOf(invocation.owner, invocation.localName), cause);
          },
        });
      });
      return yield* rest.pipe(
        Effect.timeoutOrElse({
          duration,
          orElse: () => Effect.fail(deny()),
        }),
      );
    });
    return yield* program.pipe(
      Effect.timeoutOrElse({
        duration: limit,
        orElse: () => Effect.fail(deny()),
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.fail(deny()) : Effect.failCause(cause),
      ),
    );
  },
);
