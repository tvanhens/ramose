/** Authoritative owned-operation admission, body execution, and validation. */

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  InvalidRequest,
  OperationRejected,
  Unauthorized,
} from "../../db/Errors.ts";
import type {
  AnyOpHandle,
  Op,
  OpPrincipal,
} from "../../db/Operation.ts";
import { decodeInput, encodeOutput } from "../../db/Operation.ts";
import { lowerAttr } from "../../db/attrRef.ts";
import { lowerEntityArg, tempid } from "../../db/entityArg.ts";
import {
  prepareOperationTx,
  txBuilder,
  txOps,
  type TxHandle,
  type TxOp,
} from "../../db/Tx.ts";
import { assertNoFixedValues, compositionValueMetadata } from "../../db/creation.ts";
import type { AnyEntity } from "../../db/Entity.ts";
import type { AnySchema } from "../../db/Schema.ts";
import { lowerPullPattern } from "../../db/Pull.ts";
import { tryLowerQueryObject } from "../../db/query/index.ts";
import type { AnyQueryObject } from "../../db/query/index.ts";
import type { Principal } from "../../worker/auth.ts";
import { Index, ValueTag } from "../core/datom.ts";
import { Db, type EntityRef } from "../core/db.ts";
import { Novelty } from "../core/novelty.ts";
import { processTx, type TxData } from "../core/tx.ts";
import { query } from "../core/query/engine.ts";
import { normalizePullPattern, pull } from "../core/query/pull.ts";
import { RAMOSE_TYPE } from "../core/schema.ts";
import type { TxReport } from "../core/conn.ts";
import type { DeployedOperationDefinition } from "./authoring/operations.ts";
import type { DeployedCatalog } from "./deployed.ts";
import type { CanonicalAuthorizationExpr, CanonicalValueTerm } from "./expr.ts";
import type { OperationId } from "./identities.ts";
import type { OperationInputShape } from "./catalog.ts";
import type { AuthenticatedCaller } from "./request.ts";
import { authorizeCurrentDb } from "./request.ts";
import { compileReadFilter, uniqueCanonicalTypeName } from "./read-filter.ts";
import type { AuthorizationPrincipal } from "./principal.ts";

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
    return left.length === right.length && left.every((item, index) => sameAtom(item, right[index]));
  }
  return false;
};

const principalTerm = (
  term: CanonicalValueTerm,
  principal: AuthorizationPrincipal,
): { readonly present: boolean; readonly value?: unknown } => {
  switch (term._tag) {
    case "lit":
      return { present: true, value: term.value };
    case "subject":
      return { present: true, value: principal.subject };
    case "claim":
      return Object.hasOwn(principal.claims, term.key)
        ? { present: true, value: principal.claims[term.key] }
        : { present: false };
    case "me":
      return principal.me === undefined
        ? { present: false }
        : { present: true, value: principal.me.eid };
    case "ref":
      return { present: false };
  }
};

const evalGrant = (
  expr: CanonicalAuthorizationExpr,
  principal: AuthorizationPrincipal,
): boolean => {
  switch (expr._tag) {
    case "const":
      return expr.value;
    case "hasClass":
      return principal.classes.includes(expr.class);
    case "and":
      return expr.exprs.every((child) => evalGrant(child, principal));
    case "or":
      return expr.exprs.some((child) => evalGrant(child, principal));
    case "not":
      return !evalGrant(expr.expr, principal);
    case "eq": {
      const left = principalTerm(expr.left, principal);
      const right = principalTerm(expr.right, principal);
      return left.present && right.present && sameAtom(left.value, right.value);
    }
    case "has":
      return principalTerm(expr.term, principal).present;
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

const targetFits = (
  deployed: DeployedCatalog,
  operation: OperationId,
  type: string,
): boolean => operation.owner.kind === "entity"
  ? operation.owner.name === type
  : deployed.composition.transitiveTraits(`:${type}`).includes(`:${operation.owner.name}`);

const sync = <A>(effect: Effect.Effect<A>): A => Effect.runSync(effect);

const promiseHandle = (
  handle: TxHandle,
  assertMutableField: (field: unknown) => void,
): AnyOpHandle => ({
  _tag: "TxHandle",
  eid: handle.eid,
  set: (field, value) => {
    assertMutableField(field);
    sync(handle.set(field as never, value as never));
  },
  remove: (field, value) => {
    assertMutableField(field);
    sync(handle.remove(field as never, value as never));
  },
  delete: () => { sync(handle.delete); },
});

const makeBodyOp = (args: {
  readonly definition: DeployedOperationDefinition;
  readonly dbName: string;
  readonly principal: AuthorizationPrincipal;
  readonly filteredDb: Db;
  readonly deployed: DeployedCatalog;
  readonly target: number | undefined;
  readonly now: Date;
}): { readonly op: Op<any, any>; readonly tx: () => readonly TxOp[] } => {
  const tx = txBuilder({ _tag: "Schema", entities: {} } as AnySchema);
  const bodyWritableEntities = [
    ...(args.definition.owner._tag === "Entity" ? [args.definition.owner] : []),
    ...args.definition.writes,
  ];
  const fixedMetadataEntities = [
    ...bodyWritableEntities,
    ...args.definition.composers,
  ];
  const fixedFieldIdents = new Set(
    fixedMetadataEntities.flatMap((entity) => [...compositionValueMetadata(entity).fixed.keys()]),
  );
  const assertMutableField = (field: unknown): void => {
    const ident = lowerAttr(field);
    if (ident === ":ramose/type" || ident.startsWith(":db/") || ident.startsWith(":ramose/")) {
      throw new InvalidRequest({ message: "operation cannot mutate control-plane data" });
    }
    if (fixedFieldIdents.has(ident)) {
      throw new InvalidRequest({ message: "operation cannot write an engine-owned fixed field" });
    }
  };
  const assertMutableInput = (
    entity: AnyEntity,
    input: unknown,
  ): void => {
    if (!bodyWritableEntities.includes(entity)) {
      throw new InvalidRequest({ message: "operation cannot use an undeclared entity definition" });
    }
    assertNoFixedValues(entity, (input ?? {}) as Readonly<Record<string, unknown>>);
  };
  const self = args.target === undefined
    ? undefined
    : promiseHandle(sync(tx.entity(args.target as never)), assertMutableField);
  const opPrincipal: OpPrincipal = {
    eid: args.principal.me?.eid ?? null,
    class: args.principal.classes[0] ?? "",
    sub: args.principal.subject,
    claims: args.principal.claims,
  };

  const tentative = async (): Promise<Db> => {
    const prepared = await prepareOperationTx(txOps(tx), args.filteredDb, args.now);
    if (prepared.length === 0) return args.filteredDb;
    const res = await processTx(
      args.filteredDb,
      [...prepared],
      args.filteredDb.basisT + 1,
      args.filteredDb.nextEid,
      args.now.getTime(),
      { composition: args.deployed.composition },
    );
    const novelty = new Novelty();
    const schema = args.filteredDb.schema.clone().apply(res.datoms);
    novelty.add(args.filteredDb.novelty.byIndex[Index.EAVT].all(), (a) => schema.isAvet(a), (a) => schema.isVaet(a));
    novelty.add(res.datoms, (a) => schema.isAvet(a), (a) => schema.isVaet(a));
    const current = new Db({
      store: args.filteredDb.store,
      roots: args.filteredDb.roots,
      novelty,
      basisT: args.filteredDb.basisT + 1,
      schema,
      nextEid: res.nextEid,
      composition: args.deployed.composition,
    });
    return current.filter(compileReadFilter({
      unit: args.deployed.unit,
      principal: args.principal,
      currentDb: current,
    }));
  };

  const entity = ((first?: unknown, second?: unknown) =>
    promiseHandle(
      sync(tx.entity((second === undefined ? first : second) as never)),
      assertMutableField,
    )) as Op<any, any>["entity"];
  const bodyOp: Op<any, any> = {
    self: self as never,
    principal: opPrincipal,
    db: args.dbName,
    entity,
    tempid,
    set: ((...values: unknown[]) => {
      const offset = values.length === 4 ? 1 : 0;
      assertMutableField(values[offset + 1]);
      sync(tx.set(values[offset] as never, values[offset + 1] as never, values[offset + 2] as never));
    }) as Op<any, any>["set"],
    remove: ((...values: unknown[]) => {
      const offset = values.length >= 4 ? 1 : 0;
      assertMutableField(values[offset + 1]);
      sync(tx.remove(values[offset] as never, values[offset + 1] as never, values[offset + 2] as never));
    }) as Op<any, any>["remove"],
    delete: ((...values: unknown[]) => {
      sync(tx.delete(values[values.length - 1] as never));
    }) as Op<any, any>["delete"],
    put: ((entityDefinition: AnyEntity, first: unknown, second?: unknown) => {
      assertMutableInput(entityDefinition, second === undefined ? first : second);
      return promiseHandle(sync(
        second === undefined
          ? tx.put(entityDefinition, first as never)
          : tx.put(entityDefinition, first as never, second as never),
      ), assertMutableField);
    }) as Op<any, any>["put"],
    update: ((entityDefinition: AnyEntity, first: unknown, second?: unknown) => {
      assertMutableInput(entityDefinition, second === undefined ? first : second);
      return promiseHandle(sync(
        second === undefined
          ? tx.update(entityDefinition, first as never)
          : tx.update(entityDefinition, first as never, second as never),
      ), assertMutableField);
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
  if (!args.definition.self && args.definition.owner._tag === "Entity") {
    (bodyOp as Op<any, any> & { create: (attrs: unknown) => AnyOpHandle }).create =
      (attrs) => {
        assertMutableInput(args.definition.owner as AnyEntity, attrs);
        return promiseHandle(
          sync(tx.put(args.definition.owner as AnyEntity, attrs as never)),
          assertMutableField,
        );
      };
  }
  return { op: bodyOp, tx: () => txOps(tx) };
};

const fieldIdentSet = (entities: readonly AnyEntity[]): ReadonlySet<string> =>
  new Set(entities.flatMap((entity) => Object.values(entity.fields).map((field) => field.ident)));

const validateProducedDatoms = async (
  deployed: DeployedCatalog,
  definition: DeployedOperationDefinition,
  report: TxReport,
): Promise<void> => {
  const writableEntities = [
    ...(definition.owner._tag === "Entity" ? [definition.owner] : []),
    ...definition.writes,
  ];
  const allowedFields = new Set([
    ...fieldIdentSet(writableEntities),
    ...Object.values(definition.owner.fields).map((field) => field.ident),
  ]);
  const fixedFields = new Map<string, unknown>();
  for (const entity of [...writableEntities, ...definition.composers]) {
    for (const [ident, entry] of compositionValueMetadata(entity).fixed) {
      fixedFields.set(ident, entry.value);
    }
  }
  const principalField = deployed.unit.policy.principal.entity;
  const principalIdent = principalField === undefined
    ? undefined
    : `:${principalField.owner.name}/${principalField.localName}`;
  const createdTypes = new Map<number, string>();
  const touched = new Set<number>();

  for (const datom of report.txData) {
    if (datom.e === report.txEid) continue;
    touched.add(datom.e);
    if (report.dbAfter.schema.ident(datom.a) !== ":ramose/type") continue;
    const typeValue: unknown = datom.v;
    if (!datom.op) {
      if (await report.dbAfter.exists(datom.e)) {
        throw new InvalidRequest({ message: "operation produced an invalid canonical type retraction" });
      }
      continue;
    }
    if (typeof typeValue !== "string" || createdTypes.has(datom.e)) {
      throw new InvalidRequest({ message: "operation produced an invalid canonical type assertion" });
    }
    createdTypes.set(datom.e, typeValue);
  }

  for (const datom of report.txData) {
    if (datom.e === report.txEid) continue;
    const ident = report.dbAfter.schema.ident(datom.a);
    if (ident === undefined) throw new InvalidRequest({ message: "operation produced an unknown attribute" });
    if (ident === ":ramose/type") {
      continue;
    }
    if (ident.startsWith(":db/") || ident.startsWith(":ramose/")) {
      throw new InvalidRequest({ message: "operation cannot mutate control-plane data" });
    }
    if (!allowedFields.has(ident)) {
      throw new InvalidRequest({ message: `operation cannot write ${ident}` });
    }
    const descriptor = deployed.unit.catalog.fields.find((field) =>
      `:${field.id.owner.name}/${field.id.localName}` === ident
    );
    if (descriptor === undefined) {
      throw new InvalidRequest({ message: `operation cannot write unknown catalog field ${ident}` });
    }
    const rowDb = await report.dbAfter.exists(datom.e) ? report.dbAfter : report.dbBefore;
    const rowType = await targetType(rowDb, datom.e);
    const fieldFits = rowType !== undefined && (
      descriptor.id.owner.kind === "entity"
        ? descriptor.id.owner.name === rowType
        : deployed.composition.transitiveTraits(`:${rowType}`).includes(`:${descriptor.id.owner.name}`)
    );
    if (!fieldFits) {
      throw new InvalidRequest({ message: `operation cannot write ${ident} on this entity` });
    }
    const fixed = fixedFields.get(ident);
    if (fixedFields.has(ident)) {
      const expected = fixed instanceof Date && datom.vt === ValueTag.Inst
        ? fixed.getTime()
        : fixed;
      const allowedCreationValue = createdTypes.has(datom.e) &&
        !(await report.dbBefore.exists(datom.e)) && datom.op &&
        (Array.isArray(expected)
          ? expected.some((item) => sameAtom(item, datom.v))
          : sameAtom(expected, datom.v));
      if (!allowedCreationValue) {
        throw new InvalidRequest({ message: `operation cannot mutate fixed field ${ident}` });
      }
    }
    if (principalIdent === ident) {
      throw new InvalidRequest({ message: "operation cannot mutate principal identity" });
    }
    const attr = report.dbAfter.schema.attr(datom.a);
    if (datom.op && attr?.valueType === ValueTag.Ref) {
      if (typeof datom.v !== "number") throw new InvalidRequest({ message: `invalid ref value for ${ident}` });
      const type = await targetType(report.dbAfter, datom.v);
      if (type === undefined) throw new InvalidRequest({ message: `invalid ref target for ${ident}` });
      const target = descriptor?.valueType === "ref" ? descriptor.refTarget : undefined;
      if (target?._tag === "entity" && target.entity.name !== type) {
        throw new InvalidRequest({ message: `wrong ref target for ${ident}` });
      }
      if (target?._tag === "trait" &&
        !deployed.composition.transitiveTraits(`:${type}`).includes(`:${target.trait.name}`)) {
        throw new InvalidRequest({ message: `wrong trait ref target for ${ident}` });
      }
    }
  }

  const creatableTypes = new Set(writableEntities.map((entity) => `:${entity.ns}`));
  for (const type of createdTypes.values()) {
    if (!creatableTypes.has(type)) {
      throw new InvalidRequest({ message: `operation cannot create type ${type}` });
    }
  }
  for (const eid of touched) {
    if (
      (await report.dbAfter.exists(eid)) &&
      !(await report.dbBefore.exists(eid)) &&
      !createdTypes.has(eid)
    ) {
      throw new InvalidRequest({ message: "created entity is missing its canonical type" });
    }
  }
};

const resolveOutputHandles = async (
  value: unknown,
  report: TxReport,
): Promise<unknown> => {
  if (typeof value !== "object" || value === null) return value;
  if ((value as { readonly _tag?: unknown })._tag === "TxHandle") {
    const eid = (value as { readonly eid: unknown }).eid;
    if (typeof eid === "number") return eid;
    if (typeof eid === "string") return report.tempids[eid];
    if (Array.isArray(eid)) return report.dbAfter.entid(eid as EntityRef);
    return undefined;
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveOutputHandles(item, report)));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = await resolveOutputHandles(item, report);
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
    case "opaque":
      return;
    case "array":
      if (!Array.isArray(value)) throw new InvalidRequest({ message: "invalid operation output" });
      for (const item of value) {
        await validateOutputVisibility(shape.items, item, db, deployed, operation);
      }
      return;
    case "struct": {
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
    }
    case "ref": {
      if (typeof value !== "number" || !(await db.exists(value))) throw policyDenied();
      const type = await targetType(db, value);
      if (type === undefined) throw policyDenied();
      const target = shape.refTarget;
      if (target._tag === "entity" && target.entity.name !== type) throw policyDenied();
      if (target._tag === "trait" &&
        !deployed.composition.transitiveTraits(`:${type}`).includes(`:${target.trait.name}`)) {
        throw policyDenied();
      }
      if (target._tag === "self" && !targetFits(deployed, operation, type)) throw policyDenied();
    }
  }
};

export type PreparedOperation = {
  readonly tx: TxData;
  readonly principal: Principal;
  readonly beforeCommit: (report: TxReport) => Promise<unknown>;
};

export const prepareAuthorizedOperation = async (args: {
  readonly deployed: DeployedCatalog;
  readonly definition: DeployedOperationDefinition;
  readonly caller: AuthenticatedCaller;
  readonly principal: Principal;
  readonly dbName: string;
  readonly currentDb: Db;
  readonly target: unknown;
  readonly input: unknown;
  readonly now: number;
}): Promise<PreparedOperation> => {
  const current = await authorizeCurrentDb(args.deployed.unit, args.caller, args.currentDb, args.now);
  if (Result.isFailure(current)) throw policyDenied();
  const auth = current.success;
  if (!isGranted(args.deployed, args.definition.id, auth.principal)) throw policyDenied();

  let target: number | undefined;
  if (args.definition.self) {
    target = await resolveTarget(auth.db, args.target);
    if (target === undefined) throw policyDenied();
    const type = await targetType(auth.db, target);
    if (type === undefined || !targetFits(args.deployed, args.definition.id, type)) throw policyDenied();
  } else if (args.target !== undefined) {
    throw policyDenied();
  }

  const decoded = await Effect.runPromise(decodeInput(args.definition.input as never, args.input));
  const descriptor = args.deployed.unit.catalog.operations.find((candidate) =>
    candidate.id.catalog === args.definition.id.catalog &&
    candidate.id.owner.kind === args.definition.id.owner.kind &&
    candidate.id.owner.name === args.definition.id.owner.name &&
    candidate.id.localName === args.definition.id.localName &&
    candidate.id.target === args.definition.id.target
  );
  if (descriptor === undefined) throw policyDenied();
  await validateOutputVisibility(
    descriptor.input,
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
    deployed: args.deployed,
    target,
    now: new Date(args.now),
  });
  let output: unknown;
  try {
    output = await args.definition.run(built.op as never, decoded as never);
  } catch (cause) {
    if (cause instanceof OperationRejected) throw cause;
    throw new OperationRejected({
      message: cause instanceof Error ? cause.message : String(cause),
      operation: operationLabel(args.definition.id),
      step: "body",
    });
  }
  const tx = await prepareOperationTx(built.tx(), args.currentDb, new Date(args.now));
  return {
    tx: [...tx],
    principal: args.principal,
    beforeCommit: async (report) => {
      await validateProducedDatoms(args.deployed, args.definition, report);
      const resolved = await resolveOutputHandles(output, report);
      const encoded = await Effect.runPromise(encodeOutput(args.definition.output as never, resolved));
      const filteredAfter = report.dbAfter.filter(compileReadFilter({
        unit: args.deployed.unit,
        principal: auth.principal,
        currentDb: report.dbAfter,
      }));
      await validateOutputVisibility(
        descriptor.output,
        resolved,
        filteredAfter,
        args.deployed,
        args.definition.id,
      );
      return encoded;
    },
  };
};
