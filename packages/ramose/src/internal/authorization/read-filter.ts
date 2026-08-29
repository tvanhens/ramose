/**
 * Compile a sealed catalog unit into the trusted {@link DatomPredicate}
 * used by {@link import("../core/db.ts").Db.filter}.
 *
 * Candidate canonical type is classified from the predicate's requested
 * immutable `db` (current, asOf, history, or bounded history). Current
 * grants and rule path lookups stay on the closed-over `currentDb`.
 * No Effect or Context per datom.
 */

import * as Result from "effect/Result";
import type { FieldDescriptor } from "./catalog.ts";
import type { InstalledCatalogUnitV2 } from "./catalog-unit.ts";
import type {
  CanonicalAuthorizationExpr,
  CanonicalRefTerm,
  CanonicalValueTerm,
} from "./expr.ts";
import { InvalidTraversal, MissingMe, type IncompleteReason } from "./failures.ts";
import type { EntityId, FieldId } from "./identities.ts";
import type { Decision } from "./ir.ts";
import type { AuthorizationPrincipal } from "./principal.ts";
import {
  EntityAbsent,
  False,
  FieldAbsent,
  Incomplete,
  InvalidTraversalProjection,
  MissingMeProjection,
  Present,
  True,
  type Projected,
  type ProjectedAtom,
  type ProjectedValue,
  type Truth,
} from "./truth.ts";
import {
  entityComposes,
  fieldAccessibleFrom,
  prepareAuthorizationCatalog,
  type RowFocus,
} from "./validation/catalog.ts";
import { fieldKey } from "./validation/common.ts";
import type { Datom } from "../core/datom.ts";
import { Index, ValueTag } from "../core/datom.ts";
import type { Db, DatomPredicate } from "../core/db.ts";
import { toWireDatom, type WireDatom } from "../core/log.ts";
import { RAMOSE_TYPE } from "../core/schema.ts";

/** Private observations used to bind a durable replay to its policy read-set. */
export type ReadAuthorizationObservation =
  | {
    readonly _tag: "type";
    readonly eid: number;
    readonly datoms: readonly WireDatom[];
  }
  | {
    readonly _tag: "field";
    readonly eid: number;
    readonly ident: string;
    readonly attributeId: number | null;
    readonly datoms: readonly WireDatom[];
  }
  | {
    readonly _tag: "exists";
    readonly eid: number;
    readonly value: boolean;
  };

export type CompileReadFilterInput = {
  readonly unit: InstalledCatalogUnitV2;
  readonly principal: AuthorizationPrincipal;
  readonly currentDb: Db;
  /** Internal-only read-set recorder. It never changes the policy decision. */
  readonly observe?: (observation: ReadAuthorizationObservation) => void;
};

const denyAll: DatomPredicate = () => false;

const entityNameFromTypeIdent = (ident: string): string | undefined => {
  if (!ident.startsWith(":") || ident.length < 2) return undefined;
  const name = ident.slice(1);
  if (name.length === 0 || name.includes("/")) return undefined;
  return name;
};

const fieldIdent = (field: FieldDescriptor): string =>
  `:${field.id.owner.name}/${field.id.localName}`;

const isIncompleteProjected = (
  value: Projected,
): value is Extract<Projected, { readonly _tag: IncompleteReason["_tag"] | "MissingMe" }> =>
  value._tag === "NotLoaded" ||
  value._tag === "InvalidTraversal" ||
  value._tag === "BudgetExhausted" ||
  value._tag === "MissingMe";

const incompleteOf = (value: Projected): Truth => {
  switch (value._tag) {
    case "MissingMe":
      return Incomplete(MissingMe);
    case "InvalidTraversal":
    case "NotLoaded":
    case "BudgetExhausted":
      return Incomplete({ _tag: value._tag });
    default:
      return Incomplete(InvalidTraversal);
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

const atomValue = (datom: Datom): ProjectedAtom =>
  datom.vt === ValueTag.Inst ? new Date(datom.v as number) : (datom.v as ProjectedAtom);

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

const eqTruth = (left: Projected, right: Projected): Truth => {
  if (isIncompleteProjected(left)) return incompleteOf(left);
  if (isIncompleteProjected(right)) return incompleteOf(right);
  if (left._tag !== "Present" || right._tag !== "Present") return False;
  return projectedEqual(left.value, right.value) ? True : False;
};

const hasTruth = (term: Projected): Truth => {
  if (term._tag === "Present") return True;
  if (term._tag === "FieldAbsent" || term._tag === "EntityAbsent") return False;
  return incompleteOf(term);
};

const inTruth = (value: Projected, collection: Projected): Truth => {
  if (isIncompleteProjected(value)) return incompleteOf(value);
  if (isIncompleteProjected(collection)) return incompleteOf(collection);
  if (value._tag !== "Present" || collection._tag !== "Present") return False;
  if (!Array.isArray(collection.value)) return Incomplete(InvalidTraversal);
  for (const item of collection.value) {
    if (atomsEqual(value.value, item)) return True;
  }
  return False;
};

const authorized = (truth: Truth): boolean => truth._tag === "True";

/**
 * One protected canonical type name from type datoms of a single requested
 * view. Assert + later retract of the same value is one type. Zero,
 * malformed, or distinct values fail closed.
 */
export const uniqueCanonicalTypeName = (
  typeDatoms: readonly Datom[],
): string | undefined => {
  let name: string | undefined;
  for (const datom of typeDatoms) {
    if (typeof datom.v !== "string") return undefined;
    const next = entityNameFromTypeIdent(datom.v);
    if (next === undefined) return undefined;
    if (name !== undefined && name !== next) return undefined;
    name = next;
  }
  return name;
};

const viewKey = (db: Db): string =>
  `${db.basisT}:${db.asOfT ?? ""}:${db.isHistory ? 1 : 0}`;

export const compileReadFilter = (input: CompileReadFilterInput): DatomPredicate => {
  try {
    return compilePredicate(input);
  } catch {
    return denyAll;
  }
};

const compilePredicate = (input: CompileReadFilterInput): DatomPredicate => {
  const { unit, principal, currentDb, observe } = input;
  const prepared = prepareAuthorizationCatalog(
    {
      database: unit.catalog.database,
      catalog: unit.catalog.id,
      catalogVersion: unit.catalog.version,
      schemaFingerprint: unit.catalog.fingerprint,
    },
    unit.catalog,
  );
  if (Result.isFailure(prepared)) return denyAll;
  const index = prepared.success;

  const attrFields = new Map<number, FieldDescriptor>();
  for (const field of unit.catalog.fields) {
    const attr = currentDb.schema.attr(fieldIdent(field));
    if (attr !== undefined) attrFields.set(attr.id, field);
  }

  const rules = new Map<string, CanonicalAuthorizationExpr>();
  for (const rule of unit.policy.rules) {
    rules.set(rule.id, rule.expr);
  }

  const entityDecisions = new Map<string, Decision>();
  for (const entry of unit.policy.decisions.entities) {
    entityDecisions.set(entry.target.name, entry.decision);
  }
  const traitDecisions = new Map<string, Decision>();
  for (const entry of unit.policy.decisions.traits) {
    traitDecisions.set(entry.target.name, entry.decision);
  }
  const fieldDecisions = new Map<string, Decision>();
  for (const entry of unit.policy.decisions.fields) {
    fieldDecisions.set(fieldKey(entry.target), entry.decision);
  }

  const typeMemo = new Map<string, Promise<EntityId | undefined>>();
  const rowMemo = new Map<string, Promise<boolean>>();

  const observeExists = async (db: Db, eid: number): Promise<boolean> => {
    const value = await db.exists(eid);
    observe?.({ _tag: "exists", eid, value });
    return value;
  };

  const classifyFrom = (db: Db, eid: number): Promise<EntityId | undefined> => {
    const key = `${viewKey(db)}:${eid}`;
    const cached = typeMemo.get(key);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<EntityId | undefined> => {
      const typeDatoms = await db.datomsArray(Index.EAVT, { e: eid, a: RAMOSE_TYPE });
      observe?.({
        _tag: "type",
        eid,
        datoms: typeDatoms.map(toWireDatom),
      });
      const name = uniqueCanonicalTypeName(typeDatoms);
      if (name === undefined) return undefined;
      return index.entities.get(name);
    })();
    typeMemo.set(key, pending);
    return pending;
  };

  const classifyCurrent = (eid: number): Promise<EntityId | undefined> =>
    classifyFrom(currentDb, eid);

  const focusOf = (entity: EntityId): RowFocus => ({ _tag: "entity", entity });

  const lookupField = async (
    eid: number,
    field: FieldDescriptor,
  ): Promise<Projected> => {
    const ident = fieldIdent(field);
    const attr = currentDb.schema.attr(ident);
    if (attr === undefined) {
      observe?.({
        _tag: "field",
        eid,
        ident,
        attributeId: null,
        datoms: [],
      });
      return InvalidTraversalProjection;
    }
    if (field.cardinality === "many") {
      const datoms = await currentDb.datomsArray(Index.EAVT, { e: eid, a: attr.id });
      observe?.({
        _tag: "field",
        eid,
        ident,
        attributeId: attr.id,
        datoms: datoms.map(toWireDatom),
      });
      if (datoms.length === 0) {
        return (await observeExists(currentDb, eid)) ? FieldAbsent : EntityAbsent;
      }
      return Present(datoms.map(atomValue));
    }
    const datom = await currentDb.first(Index.EAVT, { e: eid, a: attr.id });
    observe?.({
      _tag: "field",
      eid,
      ident,
      attributeId: attr.id,
      datoms: datom === undefined ? [] : [toWireDatom(datom)],
    });
    if (datom === undefined) {
      return (await observeExists(currentDb, eid)) ? FieldAbsent : EntityAbsent;
    }
    return Present(atomValue(datom));
  };

  const catalogField = (id: FieldId): FieldDescriptor | undefined =>
    index.fields.get(fieldKey(id));

  const projectRef = async (
    term: CanonicalRefTerm,
    resourceEid: number,
    resourceEntity: EntityId,
  ): Promise<Projected> => {
    let eid: number;
    let focus: RowFocus;
    if (term.root._tag === "resource") {
      eid = resourceEid;
      focus = focusOf(resourceEntity);
    } else if (term.root._tag === "me") {
      if (principal.me === undefined) return MissingMeProjection;
      eid = principal.me.eid;
      const meEntity = await classifyCurrent(eid);
      if (meEntity === undefined) return EntityAbsent;
      focus = focusOf(meEntity);
    } else {
      return InvalidTraversalProjection;
    }

    if (term.steps.length === 0) {
      return (await observeExists(currentDb, eid)) ? Present(eid) : EntityAbsent;
    }

    for (let i = 0; i < term.steps.length; i++) {
      const step = term.steps[i]!;
      const field = catalogField(step.field);
      if (field === undefined) return InvalidTraversalProjection;
      if (!fieldAccessibleFrom(index, focus, field)) return InvalidTraversalProjection;
      const isLast = i === term.steps.length - 1;
      if (!isLast) {
        if (field.cardinality === "many" || field.valueType !== "ref") {
          return InvalidTraversalProjection;
        }
        const hop = await lookupField(eid, field);
        if (hop._tag !== "Present") return hop;
        if (typeof hop.value !== "number") return InvalidTraversalProjection;
        eid = hop.value;
        const next = await classifyCurrent(eid);
        if (next === undefined) return EntityAbsent;
        focus = focusOf(next);
        continue;
      }
      return lookupField(eid, field);
    }
    return InvalidTraversalProjection;
  };

  const projectTerm = async (
    term: CanonicalValueTerm,
    resourceEid: number,
    resourceEntity: EntityId,
  ): Promise<Projected> => {
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
        return projectRef(term, resourceEid, resourceEntity);
      default:
        return InvalidTraversalProjection;
    }
  };

  const evalExpr = async (
    expr: CanonicalAuthorizationExpr,
    resourceEid: number,
    resourceEntity: EntityId,
  ): Promise<Truth> => {
    switch (expr._tag) {
      case "const":
        return expr.value ? True : False;
      case "hasClass":
        return principal.classes.includes(expr.class) ? True : False;
      case "and": {
        const parts = [];
        for (const child of expr.exprs) {
          const part = await evalExpr(child, resourceEid, resourceEntity);
          if (part._tag === "False") return False;
          parts.push(part);
        }
        return andTruth(parts);
      }
      case "or": {
        const parts = [];
        for (const child of expr.exprs) {
          const part = await evalExpr(child, resourceEid, resourceEntity);
          if (part._tag === "True") return True;
          parts.push(part);
        }
        return orTruth(parts);
      }
      case "not":
        return notTruth(await evalExpr(expr.expr, resourceEid, resourceEntity));
      case "eq":
        return eqTruth(
          await projectTerm(expr.left, resourceEid, resourceEntity),
          await projectTerm(expr.right, resourceEid, resourceEntity),
        );
      case "has":
        return hasTruth(await projectTerm(expr.term, resourceEid, resourceEntity));
      case "in":
        return inTruth(
          await projectTerm(expr.value, resourceEid, resourceEntity),
          await projectTerm(expr.collection, resourceEid, resourceEntity),
        );
      default:
        return Incomplete(InvalidTraversal);
    }
  };

  const evaluateDecision = async (
    decision: Decision,
    resourceEid: number,
    resourceEntity: EntityId,
  ): Promise<boolean> => {
    for (const id of decision.deny) {
      const expr = rules.get(id);
      // Missing or incomplete deny is fail-closed: we cannot prove the
      // deny does not apply, so the datom stays hidden.
      if (expr === undefined) return false;
      if ((await evalExpr(expr, resourceEid, resourceEntity))._tag !== "False") return false;
    }
    for (const id of decision.allow) {
      const expr = rules.get(id);
      if (expr === undefined) continue;
      if (authorized(await evalExpr(expr, resourceEid, resourceEntity))) return true;
    }
    return false;
  };

  const isRowReadable = (db: Db, eid: number): Promise<boolean> => {
    const key = `${viewKey(db)}:${eid}`;
    const cached = rowMemo.get(key);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<boolean> => {
      const entity = await classifyFrom(db, eid);
      if (entity === undefined) return false;
      const decision = entityDecisions.get(entity.name);
      if (decision === undefined) return false;
      return evaluateDecision(decision, eid, entity);
    })();
    rowMemo.set(key, pending);
    return pending;
  };

  const isTraitReadable = async (
    eid: number,
    entity: EntityId,
    traitName: string,
  ): Promise<boolean> => {
    if (!entityComposes(index, entity, traitName)) return false;
    const decision = traitDecisions.get(traitName);
    if (decision === undefined) return false;
    return evaluateDecision(decision, eid, entity);
  };

  const isFieldReadable = async (
    db: Db,
    eid: number,
    entity: EntityId,
    field: FieldDescriptor,
  ): Promise<boolean> => {
    if (!fieldAccessibleFrom(index, focusOf(entity), field)) return false;
    if (!(await isRowReadable(db, eid))) return false;
    if (field.id.owner.kind === "trait") {
      if (!(await isTraitReadable(eid, entity, field.id.owner.name))) return false;
    }
    const fieldDecision = fieldDecisions.get(fieldKey(field.id));
    if (fieldDecision !== undefined) {
      return evaluateDecision(fieldDecision, eid, entity);
    }
    return true;
  };

  const refTargetMatches = (
    field: Extract<FieldDescriptor, { readonly valueType: "ref" }>,
    target: EntityId,
  ): boolean => {
    switch (field.refTarget._tag) {
      case "untargeted":
        return true;
      case "entity":
        return field.refTarget.entity.name === target.name;
      case "trait":
        return entityComposes(index, target, field.refTarget.trait.name);
      case "self":
        return field.id.owner.kind === "entity"
          ? field.id.owner.name === target.name
          : entityComposes(index, target, field.id.owner.name);
    }
  };

  return async (db, datom) => {
    try {
      const entity = await classifyFrom(db, datom.e);
      if (entity === undefined) return false;
      if (datom.a === RAMOSE_TYPE) {
        return isRowReadable(db, datom.e);
      }
      const field = attrFields.get(datom.a);
      if (field === undefined) return false;
      if (!(await isFieldReadable(db, datom.e, entity, field))) return false;
      if (datom.vt === ValueTag.Ref) {
        if (typeof datom.v !== "number") return false;
        if (field.valueType !== "ref") return false;
        const target = await classifyFrom(db, datom.v);
        if (target === undefined || !refTargetMatches(field, target)) return false;
        if (!(await isRowReadable(db, datom.v))) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
};
