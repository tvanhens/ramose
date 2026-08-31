import {
  Index,
  ValueTag,
  datom as makeDatom,
  valueEquals,
  type Datom,
  type DatomValue,
} from "../core/datom.ts";
import { Db } from "../core/db.ts";
import { Novelty } from "../core/novelty.ts";
import { RAMOSE_TYPE } from "../core/schema.ts";
import type { ProjectionOp, ProjectionValue } from "../../db/Projection.ts";
import {
  isClientRef,
  type ClientRef,
  type EntityId,
  type InvocationId,
  type MutationRef,
} from "../../db/refs.ts";
import type { OverlayLayers } from "./overlay-layers.ts";
import type { LogicalDatom } from "./protocol.ts";
import { replicaFactDatom } from "./replica-schema.ts";

export type OverlayResolver = {
  readonly entity: (id: EntityId) => number | undefined;
  readonly mapping: (ref: ClientRef) => EntityId | undefined;
};

export type OverlayOperationRefusalReason =
  | "unknown-field"
  | "value-type"
  | "unknown-entity"
  | "undeclared-ref";

export type OverlayRefusal = {
  readonly invocation: InvocationId;
  readonly index: number;
  readonly reason: OverlayOperationRefusalReason;
};

export type OverlayView = {
  readonly db: Db;
  readonly speculative: ReadonlyMap<string, number>;
  readonly refusals: readonly OverlayRefusal[];
};

const asLogical = (
  entity: MutationRef,
  field: string,
  value: ProjectionValue,
): LogicalDatom =>
  ({ entity, field, value, op: "add" }) as unknown as LogicalDatom;

const storedMembershipType = (ns: string): string =>
  ns.startsWith(":") ? ns : `:${ns}`;

const referencesOf = (op: ProjectionOp): readonly MutationRef[] =>
  (op.op === "set" || op.op === "remove") && op.value !== null &&
    op.value.type === "ref"
    ? [op.entity, op.value.value]
    : [op.entity];

export const projectOverlay = async (
  committed: Db,
  layers: OverlayLayers,
  resolver: OverlayResolver,
): Promise<OverlayView> => {
  if (committed.asOfT !== undefined || committed.isHistory) {
    throw new Error(
      "ramose/overlay: the speculative overlay applies only to a live committed value",
    );
  }
  const schema = committed.schema;
  const entities = new Map<string, number>();
  const speculative = new Map<string, number>();
  const refusals: OverlayRefusal[] = [];
  let nextEid = committed.nextEid;
  let declared: ReadonlySet<string> = new Set();

  const resolve = (ref: MutationRef): number | OverlayOperationRefusalReason => {
    if (isClientRef(ref)) {
      const mapped = resolver.mapping(ref);
      if (mapped === undefined && !declared.has(ref)) return "undeclared-ref";
      const direct = entities.get(ref);
      if (direct !== undefined) return direct;
      const key = mapped ?? ref;
      let eid = entities.get(key);
      if (eid === undefined) {
        const held = mapped === undefined ? undefined : resolver.entity(mapped);
        eid = held ?? nextEid++;
        entities.set(key, eid);
        if (held === undefined) speculative.set(key, eid);
      }
      entities.set(ref, eid);
      return eid;
    }
    const direct = entities.get(ref);
    if (direct !== undefined) return direct;
    const eid = resolver.entity(ref as EntityId);
    if (eid === undefined) return "unknown-entity";
    entities.set(ref, eid);
    return eid;
  };

  for (const layer of layers) {
    declared = new Set(layer.declared);
    for (const op of layer.changeset) {
      for (const ref of referencesOf(op)) if (isClientRef(ref)) resolve(ref);
    }
  }

  const lower = (
    op: Extract<ProjectionOp, { readonly op: "set" | "remove" }>,
    value: ProjectionValue,
    e: number,
    t: number,
  ): Datom | OverlayOperationRefusalReason => {
    const fact = replicaFactDatom(
      asLogical(op.entity, op.field, value),
      schema,
      entities,
    );
    if (typeof fact === "string") return fact;
    try {
      return makeDatom(e, fact.a, fact.vt, fact.v as DatomValue, t, true);
    } catch {
      return "value-type";
    }
  };

  const derive = (novelty: Novelty, basisT: number): Db =>
    new Db({
      store: committed.store,
      roots: committed.roots,
      novelty,
      basisT,
      schema,
      nextEid,
      asOfT: committed.asOfT,
      history: committed.isHistory,
      filters: committed.filters,
      composition: committed.composition,
    });

  const isAvet = (a: number): boolean => schema.isAvet(a);
  const isVaet = (a: number): boolean => schema.isVaet(a);
  const novelty = new Novelty();
  novelty.add(committed.novelty.byIndex[Index.EAVT].all(), isAvet, isVaet);
  let below = committed;
  let t = committed.basisT;

  const datomsFor = async (
    op: ProjectionOp,
    at: number,
  ): Promise<Datom[] | OverlayOperationRefusalReason> => {
    const resolved = referencesOf(op).map(resolve);
    const refused = resolved.find((eid) => typeof eid === "string");
    if (refused !== undefined) return refused as OverlayOperationRefusalReason;
    const e = resolved[0] as number;
    const retract = (prior: Datom): Datom => ({ ...prior, t: at, op: false });
    if (op.op === "create") {
      return [
        makeDatom(
          e,
          RAMOSE_TYPE,
          ValueTag.Str,
          storedMembershipType(op.type),
          at,
          true,
        ),
      ];
    }
    if (op.op === "delete") {
      const own = await below.datomsArray(Index.EAVT, { e });
      const inbound = await below.datomsArray(Index.VAET, {
        vt: ValueTag.Ref,
        v: e,
      });
      return [...own, ...inbound].map(retract);
    }
    const attribute = schema.attr(op.field);
    if (attribute === undefined) return "unknown-field";
    const current = await below.datomsArray(Index.EAVT, { e, a: attribute.id });
    if (op.op === "remove") {
      if (op.value === null) return current.map(retract);
      const target = lower(op, op.value, e, at);
      if (typeof target === "string") return target;
      return current
        .filter((prior) => valueEquals(prior.vt, prior.v, target.vt, target.v))
        .map(retract);
    }
    const fact = lower(op, op.value, e, at);
    if (typeof fact === "string") return fact;
    const emitted = attribute.cardinality === "one"
      ? current
        .filter((prior) => !valueEquals(prior.vt, prior.v, fact.vt, fact.v))
        .map(retract)
      : [];
    emitted.push(fact);
    return emitted;
  };

  for (const layer of layers) {
    declared = new Set(layer.declared);
    for (let index = 0; index < layer.changeset.length; index++) {
      const emitted = await datomsFor(layer.changeset[index]!, t + 1);
      if (typeof emitted === "string") {
        refusals.push(
          Object.freeze({
            invocation: layer.invocation,
            index,
            reason: emitted,
          }),
        );
        continue;
      }
      if (emitted.length === 0) continue;
      t += 1;
      novelty.add(emitted, isAvet, isVaet);
      below = derive(novelty, t);
    }
  }

  return Object.freeze({
    db: t === committed.basisT ? committed : derive(novelty, t),
    speculative,
    refusals: Object.freeze(refusals),
  });
};
