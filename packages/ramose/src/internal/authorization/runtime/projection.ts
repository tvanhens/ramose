/**
 * Completeness-aware rule projection (TCB-2, LANG-2, HIST-2).
 *
 * The service prepares an accessor over the trusted current rule basis.
 * Matching datoms stay inside the rule snapshot — they are never copied
 * onto an authorized application snapshot.
 *
 * Basis collapse and the {@link Projected} representation are synchronous.
 * Storage IO is Effectful. Missing data, invalid paths, and budget
 * exhaustion are distinct tags, not JavaScript `undefined`.
 *
 * @internal
 */

import { Index, type Datom } from "../../core/datom.ts";
import type { Db } from "../../core/db.ts";
import { datomJsValue } from "../../core/db.ts";
import { RAMOSE_TRAIT_IDENT, RAMOSE_TYPE_IDENT } from "../../core/schema.ts";
import { MAX_TRAVERSAL_DEPTH } from "../bounds.ts";
import type { FieldDescriptor, FieldRefTarget } from "../catalog.ts";
import type { FieldId, OwnerRef } from "../identities.ts";
import {
  BudgetExhaustedProjection,
  EntityAbsent,
  FieldAbsent,
  InvalidTraversalProjection,
  MissingMeProjection,
  NotLoadedProjection,
  Present,
  type Projected,
  type ProjectedValue,
} from "../truth.ts";
import type { AuthorizationPrincipal } from "../principal.ts";
import {
  fieldDescriptorKey,
  parsePhysicalComposerIdent,
  physicalComposerIdent,
  type TraversalCompositions,
} from "./field-index.ts";
import type { AuthorizationBudgetState } from "./snapshots.ts";

export type { TraversalCompositions } from "./field-index.ts";
export { fieldStorageIndex, traversalCompositionsOf } from "./field-index.ts";

export type FieldProjectionIndex = {
  readonly fields: ReadonlyMap<string, FieldDescriptor>;
  readonly storageIdents: ReadonlyMap<string, string>;
  readonly compositions: TraversalCompositions;
};

export const chargeBudget = (budget: AuthorizationBudgetState, cost = 1): boolean => {
  budget.spent += cost;
  return budget.spent <= budget.limit;
};

/** Sync cell from already-fetched datoms. Independently testable. */
export const projectFetched = (
  entityDatoms: readonly Datom[],
  fieldDatoms: readonly Datom[],
  many: boolean,
): Projected => {
  if (entityDatoms.length === 0) return EntityAbsent;
  if (fieldDatoms.length === 0) return FieldAbsent;
  if (many) {
    return Present(fieldDatoms.map((d) => datomJsValue(d) as never) as ProjectedValue);
  }
  return Present(datomJsValue(fieldDatoms[0]!) as never);
};

export const resolveFieldDescriptor = (
  fields: ReadonlyMap<string, FieldDescriptor>,
  field: FieldId,
): FieldDescriptor | undefined => fields.get(fieldDescriptorKey(field));

const traitComposes = (
  compositions: TraversalCompositions,
  traitName: string,
  otherName: string,
): boolean =>
  traitName === otherName || compositions.traitTraits.get(traitName)?.has(otherName) === true;

const entityComposes = (
  compositions: TraversalCompositions,
  entityName: string,
  traitName: string,
): boolean => compositions.entityTraits.get(entityName)?.has(traitName) === true;

const ownerMatchesFocus = (
  owner: OwnerRef,
  focusKind: "entity" | "trait",
  focusName: string,
  compositions: TraversalCompositions,
): boolean => {
  if (focusKind === "entity") {
    if (owner.kind === "entity") return owner.name === focusName;
    return entityComposes(compositions, focusName, owner.name);
  }
  if (owner.kind === "entity") return false;
  return traitComposes(compositions, focusName, owner.name);
};

export const fieldOwnerMatchesPriorTarget = (
  field: FieldDescriptor,
  prior: { readonly refTarget: FieldRefTarget; readonly owner: OwnerRef },
  compositions: TraversalCompositions,
): boolean => {
  const owner = field.id.owner;
  switch (prior.refTarget._tag) {
    case "untargeted":
      return false;
    case "self":
      return ownerMatchesFocus(owner, prior.owner.kind, prior.owner.name, compositions);
    case "entity":
      if (prior.refTarget.entity.catalog !== field.id.catalog) return false;
      return ownerMatchesFocus(owner, "entity", prior.refTarget.entity.name, compositions);
    case "trait":
      if (prior.refTarget.trait.catalog !== field.id.catalog) return false;
      return ownerMatchesFocus(owner, "trait", prior.refTarget.trait.name, compositions);
  }
};

const resolveStorageAttr = (db: Db, index: FieldProjectionIndex, field: FieldId) => {
  const ident = index.storageIdents.get(fieldDescriptorKey(field));
  if (ident === undefined) return undefined;
  return db.attr(ident);
};

const readMembershipStrings = async (
  db: Db,
  eid: number,
  ident: string,
): Promise<readonly string[]> => {
  const attr = db.attr(ident);
  if (attr === undefined) return [];
  const values: string[] = [];
  for await (const chunk of db.datoms(Index.EAVT, { e: eid, a: attr.id })) {
    for (const datom of chunk) {
      const value = datomJsValue(datom);
      if (typeof value === "string") values.push(value);
    }
  }
  return values;
};

export const startingEidOwnsField = async (
  db: Db,
  eid: number,
  field: FieldDescriptor,
  compositions: TraversalCompositions,
  budget: AuthorizationBudgetState,
): Promise<Projected | undefined> => {
  if (!chargeBudget(budget)) return BudgetExhaustedProjection;
  const types = await readMembershipStrings(db, eid, RAMOSE_TYPE_IDENT);
  const typeIdent = types[0];
  if (typeIdent === undefined) return InvalidTraversalProjection;
  const owner = field.id.owner;
  if (owner.kind === "entity") {
    const expected = physicalComposerIdent({
      catalog: field.id.catalog,
      kind: "entity",
      name: owner.name,
    });
    return typeIdent === expected ? undefined : InvalidTraversalProjection;
  }
  const expectedTrait = physicalComposerIdent({
    catalog: field.id.catalog,
    kind: "trait",
    name: owner.name,
  });
  if (!chargeBudget(budget)) return BudgetExhaustedProjection;
  const traits = await readMembershipStrings(db, eid, RAMOSE_TRAIT_IDENT);
  if (traits.includes(expectedTrait)) return undefined;
  const parsed = parsePhysicalComposerIdent(typeIdent);
  if (parsed === undefined || parsed.kind !== "entity" || parsed.catalog !== field.id.catalog) {
    return InvalidTraversalProjection;
  }
  return entityComposes(compositions, parsed.name, owner.name) ? undefined : InvalidTraversalProjection;
};

const projectBoundField = async (
  db: Db,
  eid: number,
  attrId: number,
  many: boolean,
  budget: AuthorizationBudgetState,
): Promise<Projected> => {
  if (!chargeBudget(budget)) return BudgetExhaustedProjection;
  const exists = await db.first(Index.EAVT, { e: eid });
  if (exists === undefined) return EntityAbsent;
  const fieldDatoms: Datom[] = [];
  for await (const chunk of db.datoms(Index.EAVT, { e: eid, a: attrId })) {
    for (const datom of chunk) {
      if (!chargeBudget(budget)) return BudgetExhaustedProjection;
      fieldDatoms.push(datom);
      if (!many) return projectFetched([exists], fieldDatoms, false);
    }
  }
  return projectFetched([exists], fieldDatoms, many);
};

export const projectFieldFromDb = async (
  db: Db,
  index: FieldProjectionIndex,
  eid: number,
  field: FieldId,
  budget: AuthorizationBudgetState,
): Promise<Projected> => {
  const descriptor = resolveFieldDescriptor(index.fields, field);
  if (descriptor === undefined) return InvalidTraversalProjection;
  const ownership = await startingEidOwnsField(db, eid, descriptor, index.compositions, budget);
  if (ownership !== undefined) return ownership;
  const attr = resolveStorageAttr(db, index, field);
  if (attr === undefined) return NotLoadedProjection;
  return projectBoundField(db, eid, attr.id, descriptor.cardinality === "many", budget);
};

export const traverseFieldsFromDb = async (
  db: Db,
  index: FieldProjectionIndex,
  eid: number,
  steps: readonly FieldId[],
  budget: AuthorizationBudgetState,
): Promise<Projected> => {
  if (steps.length === 0 || steps.length > MAX_TRAVERSAL_DEPTH) return InvalidTraversalProjection;
  let current = eid;
  let prior:
    | { readonly refTarget: FieldRefTarget; readonly owner: OwnerRef }
    | undefined;
  for (let i = 0; i < steps.length; i++) {
    const field = steps[i]!;
    const descriptor = resolveFieldDescriptor(index.fields, field);
    if (descriptor === undefined) return InvalidTraversalProjection;
    if (prior === undefined) {
      const ownership = await startingEidOwnsField(db, current, descriptor, index.compositions, budget);
      if (ownership !== undefined) return ownership;
    } else if (!fieldOwnerMatchesPriorTarget(descriptor, prior, index.compositions)) {
      return InvalidTraversalProjection;
    }
    const last = i === steps.length - 1;
    if (!last) {
      if (descriptor.valueType !== "ref" || descriptor.cardinality === "many") {
        return InvalidTraversalProjection;
      }
      if (descriptor.refTarget._tag === "untargeted") return InvalidTraversalProjection;
    }
    const attr = resolveStorageAttr(db, index, field);
    if (attr === undefined) return NotLoadedProjection;
    const cell = await projectBoundField(
      db,
      current,
      attr.id,
      descriptor.cardinality === "many",
      budget,
    );
    if (cell._tag !== "Present") return cell;
    if (last) return cell;
    if (descriptor.valueType !== "ref") return InvalidTraversalProjection;
    if (descriptor.refTarget._tag === "untargeted") return InvalidTraversalProjection;
    if (typeof cell.value !== "number") return InvalidTraversalProjection;
    prior = { refTarget: descriptor.refTarget, owner: descriptor.id.owner };
    current = cell.value;
  }
  return InvalidTraversalProjection;
};

export const traverseFromMeFromDb = async (
  db: Db,
  index: FieldProjectionIndex,
  principal: AuthorizationPrincipal,
  steps: readonly FieldId[],
  budget: AuthorizationBudgetState,
): Promise<Projected> => {
  if (principal.me === undefined) return MissingMeProjection;
  return traverseFieldsFromDb(db, index, principal.me.eid, steps, budget);
};
