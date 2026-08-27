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
import { MAX_TRAVERSAL_DEPTH } from "../bounds.ts";
import type { FieldDescriptor } from "../catalog.ts";
import type { FieldId } from "../identities.ts";
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
import type { AuthorizationBudgetState } from "./snapshots.ts";
import { fieldDescriptorKey, fieldIdentOf } from "./snapshots.ts";

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

export const projectFieldFromDb = async (
  db: Db,
  fields: ReadonlyMap<string, FieldDescriptor>,
  eid: number,
  field: FieldId,
  budget: AuthorizationBudgetState,
): Promise<Projected> => {
  if (!chargeBudget(budget)) return BudgetExhaustedProjection;
  const descriptor = resolveFieldDescriptor(fields, field);
  if (descriptor === undefined) return InvalidTraversalProjection;
  const attr = db.attr(fieldIdentOf(field));
  if (attr === undefined) return NotLoadedProjection;
  const [entityDatoms, fieldDatoms] = await Promise.all([
    db.datomsArray(Index.EAVT, { e: eid }),
    db.datomsArray(Index.EAVT, { e: eid, a: attr.id }),
  ]);
  return projectFetched(entityDatoms, fieldDatoms, descriptor.cardinality === "many");
};

export const traverseFieldsFromDb = async (
  db: Db,
  fields: ReadonlyMap<string, FieldDescriptor>,
  eid: number,
  steps: readonly FieldId[],
  budget: AuthorizationBudgetState,
): Promise<Projected> => {
  if (steps.length === 0 || steps.length > MAX_TRAVERSAL_DEPTH) return InvalidTraversalProjection;
  let current = eid;
  for (let i = 0; i < steps.length; i++) {
    if (!chargeBudget(budget)) return BudgetExhaustedProjection;
    const field = steps[i]!;
    const descriptor = resolveFieldDescriptor(fields, field);
    if (descriptor === undefined) return InvalidTraversalProjection;
    const last = i === steps.length - 1;
    if (!last && (descriptor.valueType !== "ref" || descriptor.cardinality === "many")) {
      return InvalidTraversalProjection;
    }
    const attr = db.attr(fieldIdentOf(field));
    if (attr === undefined) return NotLoadedProjection;
    const [entityDatoms, fieldDatoms] = await Promise.all([
      db.datomsArray(Index.EAVT, { e: current }),
      db.datomsArray(Index.EAVT, { e: current, a: attr.id }),
    ]);
    const cell = projectFetched(entityDatoms, fieldDatoms, descriptor.cardinality === "many");
    if (cell._tag !== "Present") return cell;
    if (last) return cell;
    if (typeof cell.value !== "number") return InvalidTraversalProjection;
    current = cell.value;
  }
  return InvalidTraversalProjection;
};

export const traverseFromMeFromDb = async (
  db: Db,
  fields: ReadonlyMap<string, FieldDescriptor>,
  principal: AuthorizationPrincipal,
  steps: readonly FieldId[],
  budget: AuthorizationBudgetState,
): Promise<Projected> => {
  if (principal.me === undefined) return MissingMeProjection;
  return traverseFieldsFromDb(db, fields, principal.me.eid, steps, budget);
};
