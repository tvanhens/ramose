/**
 * The deterministic speculative overlay (#476 slice 1).
 *
 * The local view is a function, not an accumulator:
 *
 * ```
 * view = projectOverlay(committed, [layer₀ … layerₙ₋₁], resolver)
 * ```
 *
 * The committed replica value is immutable and untouched. The layers' datoms go
 * into novelty above `committed.basisT`, in `(layer, operation)` order, and the
 * resulting `Db` raises its basis to cover them. Query membership, sorting,
 * reference joins, and graph-local pulls reflect the overlay for free, because
 * the query engine and pull read only through `Db.datoms` / `seekMany` /
 * `first` / `datomsArray` — nothing in the read path knows a layer exists, and
 * no second index is built.
 *
 * ## Determinism
 *
 * Same committed value, same ordered layers, same resolver ⇒ byte-identical
 * datoms. Positions and speculative ids both come from first appearance in
 * `(layer, operation)` order, and every value is lowered through
 * `replicaFactDatom` — the same projection the replica installer and the
 * integrity validator share, so a value the committed schema does not admit is
 * refused identically in all three. Nothing consults a clock or a random
 * source, and removing a layer is a rebuild from the survivors rather than an
 * inverse operation applied to a mutated index.
 *
 * ## Speculative ids are derived, never durable
 *
 * A ref the committed replica cannot resolve gets a local id from
 * `committed.nextEid` upward. Those ids exist only inside the value this call
 * returns: the overlay is rebuilt whenever the committed value or the layer
 * list changes, so a speculative id is never persisted, never sent, and never
 * compared across builds.
 */

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

/**
 * The two lookups the overlay cannot perform itself.
 *
 * A sealed `EntityId` and the replication stream's entity identity are
 * different one-way derivations of the same private eid, so no client can
 * relate one to the other without being told. Both halves are therefore
 * injected as pure functions over a fixed snapshot: `entity` is the committed
 * replica's handle-to-local-id binding, and `mapping` is the durable
 * `{ clientRef → entityId }` table #475 writes from authoritative receipts.
 *
 * Both must be *stable* for the duration of one call — the overlay resolves
 * the same ref to the same id every time it appears, and determinism rests on
 * exactly that.
 */
export type OverlayResolver = {
  readonly entity: (id: EntityId) => number | undefined;
  readonly mapping: (ref: ClientRef) => EntityId | undefined;
};

/**
 * Why one projected *operation* could not become datoms.
 *
 * Distinct from `overlay-layers.ts`'s {@link OverlayEventRefusalReason}, which
 * says why a lifecycle event left the ordered layers unchanged. The two were
 * both named `OverlayRefusalReason` in slice 1.
 */
export type OverlayOperationRefusalReason =
  /** No such attribute in the committed schema. */
  | "unknown-field"
  /** The value's type is not the attribute's declared type. */
  | "value-type"
  /**
   * A handle the committed replica does not hold and no client ref aliases.
   * Refused rather than invented: only a ref this device minted may bring a
   * new entity into the local view.
   */
  | "unknown-entity"
  /**
   * A client ref that is neither committed-mapped, supplied by this
   * invocation's own input or target, nor minted by one of its declared
   * allocation slots. The durable layer carries exactly that set, so a ref no
   * durable record accounts for is refused rather than given a speculative
   * entity the queue could never resolve.
   */
  | "undeclared-ref";

export type OverlayRefusal = {
  readonly invocation: InvocationId;
  /** Position of the refused operation inside its layer's changeset. */
  readonly index: number;
  readonly reason: OverlayOperationRefusalReason;
};

export type OverlayView = {
  /** Committed state plus the ordered layers. */
  readonly db: Db;
  /**
   * Local ids minted for refs the committed replica does not hold, keyed by
   * the handle they resolve *through* — so a client ref and the entity id it
   * maps to share one entry and the entity is presented once, never twice.
   */
  readonly speculative: ReadonlyMap<string, number>;
  /**
   * Operations that produced no datoms. A refusal is recorded and skipped,
   * never thrown: one bad operation must not wedge the queue it belongs to.
   */
  readonly refusals: readonly OverlayRefusal[];
};

/**
 * A projected value is a logical value whose `ref` names a public handle
 * instead of a replication identity. Both are plain strings resolved through
 * the same entity map, so the replica's own fact projection reads one directly.
 */
const asLogical = (
  entity: MutationRef,
  field: string,
  value: ProjectionValue,
): LogicalDatom =>
  ({ entity, field, value, op: "add" }) as unknown as LogicalDatom;

/** Every reference one operation names: its subject, and a ref-valued value. */
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
  // The overlay adds datoms strictly *above* `basisT`, so an as-of value would
  // hide every one of them and a history value would present retractions as
  // facts. Neither is a live local view, and the production driver only ever
  // passes the session's own committed value; a temporal one is a programming
  // error rather than a state to reconcile.
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
  /** The refs the layer currently being folded is entitled to name. */
  let declared: ReadonlySet<string> = new Set();

  /**
   * The aliasing rule. A client ref resolves *through* its durable mapping, so
   * a mapped ref and a direct reference to the same handle land on one id and
   * the entity is never duplicated. An unmapped ref — and a mapped one whose
   * entity the replica has not received yet — takes a speculative id under
   * that same key, which is what keeps a `committed-unobserved` layer visible
   * without a rollback flash while replication catches up.
   *
   * Returns the refusal reason rather than `undefined` so an undeclared ref is
   * reported as itself instead of as an unknown entity.
   */
  const resolve = (ref: MutationRef): number | OverlayOperationRefusalReason => {
    if (isClientRef(ref)) {
      const mapped = resolver.mapping(ref);
      // Closed by construction, and decided *before* the shared resolution map
      // is consulted. Nameability is a property of the layer, not of the view:
      // consulting `entities` first would let a ref that some *other* layer
      // declared become nameable here simply because that layer had already
      // resolved it — weaker than the rule this enforces.
      if (mapped === undefined && !declared.has(ref)) return "undeclared-ref";
      const direct = entities.get(ref);
      if (direct !== undefined) return direct;
      const key = mapped ?? ref;
      let eid = entities.get(key);
      if (eid === undefined) {
        const held = mapped === undefined ? undefined : resolver.entity(mapped);
        eid = held ?? nextEid++;
        entities.set(key, eid);
        // Only an id nothing committed accounts for is speculative, and it is
        // recorded under the key it was minted for — the mapped handle when
        // there is one — so the two names share one entry, never two entities.
        if (held === undefined) speculative.set(key, eid);
      }
      // The ref itself also resolves, so a changeset that names the ref and a
      // changeset that names its handle land on the same row.
      entities.set(ref, eid);
      return eid;
    }
    // A sealed handle carries no per-layer declaration: it names an authority
    // this device was given, so an alias any layer bound resolves for all.
    const direct = entities.get(ref);
    if (direct !== undefined) return direct;
    const eid = resolver.entity(ref as EntityId);
    if (eid === undefined) return "unknown-entity";
    entities.set(ref, eid);
    return eid;
  };

  /**
   * Bind every alias before anything is folded.
   *
   * Resolution would otherwise be order-asymmetric: naming a mapped handle
   * *before* the client ref that aliases it found nothing registered and was
   * refused, while naming it after resolved. Both orders express the same
   * intent, so the aliases are established in one pass over `(layer,
   * operation)` order first — which also fixes the speculative ids by first
   * appearance, exactly as the determinism contract requires.
   */
  for (const layer of layers) {
    declared = new Set(layer.declared);
    for (const op of layer.changeset) {
      for (const ref of referencesOf(op)) if (isClientRef(ref)) resolve(ref);
    }
  }

  /**
   * Lower one projected value through the replica's own fact projection, then
   * normalize it exactly as a stored datom is. The second step catches a value
   * the logical projection admits structurally but the datom model does not —
   * a non-canonical uuid, say — as an ordinary refusal rather than a throw.
   */
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
      // Carried, not dropped. A filtered committed value must stay filtered
      // under the overlay, and the temporal coordinates are preserved for the
      // same reason — the guard above is what keeps them trivial today.
      asOfT: committed.asOfT,
      history: committed.isHistory,
      filters: committed.filters,
      composition: committed.composition,
    });

  const isAvet = (a: number): boolean => schema.isAvet(a);
  const isVaet = (a: number): boolean => schema.isVaet(a);
  // Seeded from the committed value's own novelty, never replaced by an empty
  // one. A replica that applied a change since it was last flushed carries
  // datoms here that no tree root holds, so installing a fresh Novelty would
  // silently drop them and the overlay would answer from a *stale* committed
  // basis while claiming the current one.
  const novelty = new Novelty();
  novelty.add(committed.novelty.byIndex[Index.EAVT].all(), isAvet, isVaet);
  /**
   * The view the next operation reads: the committed value plus every
   * operation already folded in. The fold is per *operation*, not per layer —
   * a projection that sets one cardinality-one field twice must have its
   * second write replace its first, exactly as a later layer replaces an
   * earlier one. `t` therefore advances with each emitting operation, and
   * layer boundaries are ranges in that order. Nothing depends on `t` naming
   * a layer: removing one is a rebuild, never an inverse.
   */
  let below = committed;
  let t = committed.basisT;

  /** The datoms one operation contributes, or why it contributes none. */
  const datomsFor = async (
    op: ProjectionOp,
    at: number,
  ): Promise<Datom[] | OverlayOperationRefusalReason> => {
    // Resolve every reference the operation names before anything is emitted,
    // so a partly-resolved operation can never reach the view.
    const resolved = referencesOf(op).map(resolve);
    const refused = resolved.find((eid) => typeof eid === "string");
    if (refused !== undefined) return refused as OverlayOperationRefusalReason;
    const e = resolved[0] as number;
    const retract = (prior: Datom): Datom => ({ ...prior, t: at, op: false });
    if (op.op === "create") {
      return [makeDatom(e, RAMOSE_TYPE, ValueTag.Str, op.type, at, true)];
    }
    if (op.op === "delete") {
      const own = await below.datomsArray(Index.EAVT, { e });
      // Inbound references too: a ref datom whose target is gone would leave
      // reference joins and pulls resolving an entity nothing describes.
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
    // Cardinality comes from the committed schema, never from a copy carried
    // in the changeset, so the two cannot drift apart.
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
    // Re-derived once at the end so the returned value's `nextEid` covers every
    // speculative id, including ones minted for an operation that was then
    // refused. Layers that emitted nothing leave the committed value itself.
    db: t === committed.basisT ? committed : derive(novelty, t),
    speculative,
    refusals: Object.freeze(refusals),
  });
};
