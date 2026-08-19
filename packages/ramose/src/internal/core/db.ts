/**
 * `Db` — an immutable database value: index roots (segment trees) + novelty
 * + basis-t + schema. Reads merge tree segments with novelty and collapse
 * history into the current view (or an as-of view, or raw history).
 *
 * Snapshot isolation is by `t`: a Db never sees datoms with t > basisT, so a
 * shared, append-only novelty structure is safe to hand to many Db values.
 */

import {
  type Datom,
  type DatomValue,
  type IndexId,
  type Prefix,
  type TaggedValue,
  Index,
  ValueTag,
  inferTag,
  normalizeValue,
} from "./datom.ts";
import { Novelty, collapseCurrent, currentView, filterAsOf, mergeChunks, rawView } from "./novelty.ts";
import { type Attribute, Schema, isTxEid } from "./schema.ts";
import { type NodeRef, type NodeSource, estimateCount, scan, scanMany, sortedUnion } from "./tree.ts";
import { COMPARATORS } from "./datom.ts";

export interface Roots {
  /** the tree contains every datom with t <= this */
  readonly t: number;
  readonly eavt: NodeRef;
  readonly aevt: NodeRef;
  readonly avet: NodeRef;
  readonly vaet: NodeRef;
}

export function rootFor(roots: Roots, index: IndexId): NodeRef {
  switch (index) {
    case Index.EAVT:
      return roots.eavt;
    case Index.AEVT:
      return roots.aevt;
    case Index.AVET:
      return roots.avet;
    default:
      return roots.vaet;
  }
}

/** Anything that names an entity: eid, ident, or lookup ref [attr, value]. */
export type EntityRef = number | string | [string, unknown];

export interface DbOptions {
  store: NodeSource;
  roots: Roots;
  novelty: Novelty;
  basisT: number;
  schema: Schema;
  nextEid: number;
  asOfT?: number;
  history?: boolean;
}

export class Db {
  readonly store: NodeSource;
  readonly roots: Roots;
  readonly novelty: Novelty;
  readonly basisT: number;
  readonly schema: Schema;
  readonly nextEid: number;
  readonly asOfT: number | undefined;
  readonly isHistory: boolean;

  constructor(o: DbOptions) {
    this.store = o.store;
    this.roots = o.roots;
    this.novelty = o.novelty;
    this.basisT = o.basisT;
    this.schema = o.schema;
    this.nextEid = o.nextEid;
    this.asOfT = o.asOfT;
    this.isHistory = !!o.history;
  }

  /** Effective upper bound on visible t. */
  get effectiveT(): number {
    return this.asOfT !== undefined && this.asOfT < this.basisT ? this.asOfT : this.basisT;
  }

  asOf(t: number): Db {
    return new Db({ ...this.opts(), asOfT: t });
  }
  history(): Db {
    return new Db({ ...this.opts(), history: true });
  }
  private opts(): DbOptions {
    return {
      store: this.store,
      roots: this.roots,
      novelty: this.novelty,
      basisT: this.basisT,
      schema: this.schema,
      nextEid: this.nextEid,
      asOfT: this.asOfT,
      history: this.isHistory,
    };
  }

  // -------------------------------------------------------------------------
  // Raw access
  // -------------------------------------------------------------------------

  /**
   * Ordered datoms matching `prefix` in `index`, as arrays. Current view by
   * default (asserted facts only, latest per (e,a,v)); full history when
   * `isHistory`. Always bounded by `effectiveT`.
   */
  datoms(index: IndexId, prefix: Prefix): AsyncGenerator<Datom[], void, undefined> {
    const tree = scan(this.store, index, rootFor(this.roots, index), prefix);
    const nov = this.novelty.byIndex[index].range(prefix);
    const merged = mergeChunks(COMPARATORS[index], tree, nov);
    if (this.isHistory) {
      return this.effectiveT >= this.novelty.maxT && this.effectiveT >= this.roots.t && this.asOfT === undefined
        ? rawView(merged)
        : filterAsOf(merged, this.effectiveT);
    }
    return currentView(merged, this.effectiveT);
  }

  /**
   * Batched seek: `results[i]` = datoms matching `prefixes[i]` (which must
   * all bind the same components). Same visibility rules as `datoms`, but one
   * tree cursor serves the whole batch and the novelty merge / current-view
   * collapse run synchronously per prefix.
   */
  async seekMany(index: IndexId, prefixes: readonly Prefix[]): Promise<Datom[][]> {
    const nov = this.novelty.byIndex[index];
    const cmp = COMPARATORS[index];
    const asOf = this.effectiveT;
    const rawHistory = this.isHistory && asOf >= this.novelty.maxT && asOf >= this.roots.t && this.asOfT === undefined;
    const hasNovelty = nov.size > 0;
    const results = await scanMany(this.store, index, rootFor(this.roots, index), prefixes);
    for (let i = 0; i < results.length; i++) {
      let ds: Datom[] = results[i];
      if (hasNovelty) {
        const n = nov.range(prefixes[i]);
        if (n !== undefined) {
          const nds = n.start === 0 && n.end === n.datoms.length ? n.datoms : n.datoms.slice(n.start, n.end);
          ds = ds.length === 0 ? (nds as Datom[]) : sortedUnion(cmp, ds, nds);
        }
      }
      if (this.isHistory) {
        if (!rawHistory) ds = ds.filter((d) => d.t <= asOf);
      } else if (ds.length > 0) {
        ds = collapseCurrent(ds, asOf);
      }
      results[i] = ds;
    }
    return results;
  }

  async datomsArray(index: IndexId, prefix: Prefix): Promise<Datom[]> {
    const out: Datom[] = [];
    for await (const arr of this.datoms(index, prefix)) for (const d of arr) out.push(d);
    return out;
  }

  /** First datom matching prefix in current view, or undefined. */
  async first(index: IndexId, prefix: Prefix): Promise<Datom | undefined> {
    for await (const arr of this.datoms(index, prefix)) return arr[0];
    return undefined;
  }

  /** Cheap cardinality estimate (history datoms, tree + novelty). */
  async estimate(index: IndexId, prefix: Prefix): Promise<number> {
    const t = await estimateCount(this.store, index, rootFor(this.roots, index), prefix);
    const n = this.novelty.byIndex[index].range(prefix);
    return t + (n ? n.end - n.start : 0);
  }

  // -------------------------------------------------------------------------
  // Schema helpers
  // -------------------------------------------------------------------------

  attr(x: number | string): Attribute | undefined {
    return this.schema.attr(x);
  }
  requireAttr(x: number | string): Attribute {
    return this.schema.requireAttr(x);
  }

  /** Coerce a JS value into a tagged value for attribute `attr`. */
  coerce(attr: Attribute, value: unknown): TaggedValue {
    return coerceValue(attr.valueType, value);
  }

  /** Resolve an entity reference to an eid (undefined if it does not exist). */
  async entid(ref: EntityRef): Promise<number | undefined> {
    if (typeof ref === "number") return ref;
    if (typeof ref === "string") return this.schema.entid(ref);
    if (Array.isArray(ref) && ref.length === 2) {
      const attr = this.attr(ref[0]);
      if (!attr) throw new Error(`lookup ref: unknown attribute ${ref[0]}`);
      if (!attr.unique) throw new Error(`lookup ref: attribute ${ref[0]} is not unique`);
      const tv = this.coerce(attr, ref[1]);
      const d = await this.first(Index.AVET, { a: attr.id, vt: tv.vt, v: tv.v });
      return d?.e;
    }
    throw new Error(`bad entity reference ${String(ref)}`);
  }

  /** Does the entity have any datoms in the current view? */
  async exists(e: number): Promise<boolean> {
    return (await this.first(Index.EAVT, { e })) !== undefined;
  }

  /** Entity map (attribute ident → value | values). Refs stay as eids. */
  async entity(e: number): Promise<Record<string, unknown> | undefined> {
    const ds = await this.datomsArray(Index.EAVT, { e });
    if (ds.length === 0) return undefined;
    const out: Record<string, unknown> = { ":db/id": e };
    for (const d of ds) {
      const a = this.attr(d.a);
      const key = a?.ident ?? String(d.a);
      const val = d.vt === ValueTag.Inst ? new Date(d.v as number) : d.v;
      if (a?.cardinality === "many") {
        (out[key] ??= []) as unknown[];
        (out[key] as unknown[]).push(val);
      } else out[key] = val;
    }
    return out;
  }

  /** ident of an entity, if it has one */
  identOf(e: number): string | undefined {
    return this.schema.ident(e);
  }

  isTx(e: number): boolean {
    return isTxEid(e);
  }
}

/** Coerce a JS value to a tagged value of the given type (throws on mismatch). */
export function coerceValue(vt: ValueTag, value: unknown): TaggedValue {
  if (value !== null && typeof value === "object" && "vt" in (value as any) && "v" in (value as any)) {
    const tv = value as TaggedValue;
    if (tv.vt !== vt) {
      // allow long/double and ref/long cross-coercion of numbers
      if (typeof tv.v === "number" && (vt === ValueTag.Long || vt === ValueTag.Double || vt === ValueTag.Ref || vt === ValueTag.Inst)) {
        return { vt, v: normalizeValue(vt, tv.v) };
      }
      throw new TypeError(`value ${String(tv.v)} has type ${tv.vt}, attribute expects ${vt}`);
    }
    return { vt, v: normalizeValue(vt, tv.v) };
  }
  switch (vt) {
    case ValueTag.Inst:
      if (value instanceof Date) return { vt, v: value.getTime() };
      if (typeof value === "string") {
        const ms = Date.parse(value);
        if (Number.isNaN(ms)) throw new TypeError(`bad instant ${value}`);
        return { vt, v: ms };
      }
      return { vt, v: normalizeValue(vt, value as DatomValue) };
    case ValueTag.Long:
    case ValueTag.Ref:
      if (typeof value === "bigint") return { vt, v: normalizeValue(vt, Number(value)) };
      return { vt, v: normalizeValue(vt, value as DatomValue) };
    case ValueTag.Double:
      return { vt, v: normalizeValue(vt, value as DatomValue) };
    case ValueTag.Uuid:
    case ValueTag.Str:
    case ValueTag.Bool:
    case ValueTag.Bytes:
      return { vt, v: normalizeValue(vt, value as DatomValue) };
    default:
      return inferTag(value);
  }
}

/** Convert a datom's value to a JS value (Date for instants). */
export function datomJsValue(d: Datom): unknown {
  return d.vt === ValueTag.Inst ? new Date(d.v as number) : d.v;
}
