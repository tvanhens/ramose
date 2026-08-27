/**
 * Schema: attributes are entities described by datoms (Datomic-inspired):
 *   :db/ident        string   — the attribute's name, e.g. ":user/email"
 *   :db/valueType    string   — ":db.type/string" | long | double | boolean | ref | uuid | instant | bytes
 *   :db/cardinality  string   — ":db.cardinality/one" | ":db.cardinality/many"
 *   :db/unique       string   — ":db.unique/identity" | ":db.unique/value"   (implies AVET)
 *   :db/index        boolean  — AVET membership
 *   :db/isComponent  boolean
 *   :db/doc          string
 *
 * `Schema` is an immutable-ish projection of those datoms that the engine
 * consults for interning, typing, and index membership (AVET for indexed /
 * unique attrs, VAET for refs — never index everything).
 */

import { type Datom, Index, ValueTag, type ValueTag as VT, valueKey } from "./datom.ts";

// ---------------------------------------------------------------------------
// Bootstrap attribute ids (stable forever)
// ---------------------------------------------------------------------------

export const DB_IDENT = 10;
export const DB_VALUE_TYPE = 40;
export const DB_CARDINALITY = 41;
export const DB_UNIQUE = 42;
export const DB_IS_COMPONENT = 43;
export const DB_INDEX = 44;
export const DB_OPTIONAL = 45;
/** Instance membership — stamped on ordinary user entities; policy-judged by the named type, not as schema metadata. */
export const RAMOSE_TYPE = 46;
export const RAMOSE_TRAIT = 47;
export const RAMOSE_KIND = 48;
export const RAMOSE_COMPOSES = 49;
export const DB_TX_INSTANT = 50;
/** Current installed catalog-unit entity (ref). */
export const RAMOSE_CATALOG_HEAD = 51;
/** 64-hex unit hash (unique identity). */
export const RAMOSE_CATALOG_UNIT_HASH = 52;
/** Canonical UTF-8 bytes of the sealed unit. */
export const RAMOSE_CATALOG_UNIT_BYTES = 53;
export const DB_DOC = 62;

/** Reserved singleton that holds `:ramose.catalog/head`. CAS subject; never a tempid. */
export const RAMOSE_CATALOG = 21;

export const RAMOSE_TYPE_IDENT = ":ramose/type";
export const RAMOSE_TRAIT_IDENT = ":ramose/trait";
export const RAMOSE_KIND_IDENT = ":ramose/kind";
export const RAMOSE_COMPOSES_IDENT = ":ramose/composes";
export const RAMOSE_KIND_ENTITY = ":ramose.kind/entity";
export const RAMOSE_KIND_TRAIT = ":ramose.kind/trait";
export const RAMOSE_CATALOG_IDENT = ":ramose.catalog";
export const RAMOSE_CATALOG_HEAD_IDENT = ":ramose.catalog/head";
export const RAMOSE_CATALOG_UNIT_HASH_IDENT = ":ramose.catalog/unitHash";
export const RAMOSE_CATALOG_UNIT_BYTES_IDENT = ":ramose.catalog/unitBytes";

/** Engine-owned catalog-head / unit-document attributes. */
export const isCatalogControlIdent = (ident: string): boolean =>
  ident === RAMOSE_CATALOG_HEAD_IDENT ||
  ident === RAMOSE_CATALOG_UNIT_HASH_IDENT ||
  ident === RAMOSE_CATALOG_UNIT_BYTES_IDENT ||
  ident.startsWith(":ramose.catalog/");

/** First entity id handed out to user entities. */
export const FIRST_USER_EID = 1000;
/** Tx entities live in their own id partition: e = TX_BASE + t. */
export const TX_BASE = 2 ** 42;
export function txEid(t: number): number {
  return TX_BASE + t;
}
export function isTxEid(e: number): boolean {
  return e >= TX_BASE;
}
export function tOfTxEid(e: number): number {
  return e - TX_BASE;
}

export type Cardinality = "one" | "many";
export type Uniqueness = "identity" | "value";

export interface Attribute {
  readonly id: number;
  readonly ident: string;
  readonly valueType: VT;
  readonly cardinality: Cardinality;
  readonly unique?: Uniqueness | undefined;
  readonly index: boolean;
  readonly isComponent: boolean;
  readonly doc?: string | undefined;
  /** Card-one field the schema marked optional — not required at create. */
  readonly optional?: boolean;
}

export const VALUE_TYPE_IDENTS: Record<string, VT> = {
  ":db.type/long": ValueTag.Long,
  ":db.type/double": ValueTag.Double,
  ":db.type/string": ValueTag.Str,
  ":db.type/boolean": ValueTag.Bool,
  ":db.type/ref": ValueTag.Ref,
  ":db.type/uuid": ValueTag.Uuid,
  ":db.type/instant": ValueTag.Inst,
  ":db.type/bytes": ValueTag.Bytes,
};
export const VALUE_TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(VALUE_TYPE_IDENTS).map(([k, v]) => [v, k]),
);

/** Attribute schema as a plain object (input form for `schemaTx`). */
export interface AttributeSpec {
  ident: string;
  valueType: keyof typeof VALUE_TYPE_IDENTS | VT;
  cardinality?: Cardinality;
  unique?: Uniqueness;
  index?: boolean;
  isComponent?: boolean;
  optional?: boolean;
  doc?: string;
}

const BOOTSTRAP_SPECS: (AttributeSpec & { id: number })[] = [
  { id: DB_IDENT, ident: ":db/ident", valueType: ":db.type/string", cardinality: "one", unique: "identity", doc: "Unique name of an entity" },
  { id: DB_VALUE_TYPE, ident: ":db/valueType", valueType: ":db.type/string", cardinality: "one" },
  { id: DB_CARDINALITY, ident: ":db/cardinality", valueType: ":db.type/string", cardinality: "one" },
  { id: DB_UNIQUE, ident: ":db/unique", valueType: ":db.type/string", cardinality: "one" },
  { id: DB_IS_COMPONENT, ident: ":db/isComponent", valueType: ":db.type/boolean", cardinality: "one" },
  { id: DB_INDEX, ident: ":db/index", valueType: ":db.type/boolean", cardinality: "one" },
  { id: DB_OPTIONAL, ident: ":db/optional", valueType: ":db.type/boolean", cardinality: "one" },
  { id: RAMOSE_TYPE, ident: RAMOSE_TYPE_IDENT, valueType: ":db.type/string", cardinality: "one", index: true, doc: "Concrete entity type membership" },
  { id: RAMOSE_TRAIT, ident: RAMOSE_TRAIT_IDENT, valueType: ":db.type/string", cardinality: "many", index: true, doc: "Trait membership" },
  { id: RAMOSE_KIND, ident: RAMOSE_KIND_IDENT, valueType: ":db.type/string", cardinality: "one", doc: "Ident is an entity type or a trait" },
  { id: RAMOSE_COMPOSES, ident: RAMOSE_COMPOSES_IDENT, valueType: ":db.type/string", cardinality: "many", doc: "Direct trait composition" },
  { id: DB_TX_INSTANT, ident: ":db/txInstant", valueType: ":db.type/instant", cardinality: "one", index: true },
  { id: RAMOSE_CATALOG_HEAD, ident: RAMOSE_CATALOG_HEAD_IDENT, valueType: ":db.type/ref", cardinality: "one", doc: "Installed catalog-unit entity" },
  { id: RAMOSE_CATALOG_UNIT_HASH, ident: RAMOSE_CATALOG_UNIT_HASH_IDENT, valueType: ":db.type/string", cardinality: "one", unique: "identity", doc: "Installed catalog-unit hash" },
  { id: RAMOSE_CATALOG_UNIT_BYTES, ident: RAMOSE_CATALOG_UNIT_BYTES_IDENT, valueType: ":db.type/bytes", cardinality: "one", doc: "Canonical catalog-unit bytes" },
  { id: DB_DOC, ident: ":db/doc", valueType: ":db.type/string", cardinality: "one" },
];

/** Datoms describing an attribute entity `e` per `spec`, at tx `t`. */
export function attributeDatoms(e: number, spec: AttributeSpec, t: number): Datom[] {
  const vt = typeof spec.valueType === "number" ? spec.valueType : VALUE_TYPE_IDENTS[spec.valueType];
  if (vt === undefined) throw new Error(`unknown valueType ${String(spec.valueType)}`);
  const out: Datom[] = [
    { e, a: DB_IDENT, vt: ValueTag.Str, v: spec.ident, t, op: true },
    { e, a: DB_VALUE_TYPE, vt: ValueTag.Str, v: VALUE_TYPE_NAMES[vt], t, op: true },
    { e, a: DB_CARDINALITY, vt: ValueTag.Str, v: `:db.cardinality/${spec.cardinality ?? "one"}`, t, op: true },
  ];
  if (spec.unique) out.push({ e, a: DB_UNIQUE, vt: ValueTag.Str, v: `:db.unique/${spec.unique}`, t, op: true });
  if (spec.index) out.push({ e, a: DB_INDEX, vt: ValueTag.Bool, v: true, t, op: true });
  if (spec.isComponent) out.push({ e, a: DB_IS_COMPONENT, vt: ValueTag.Bool, v: true, t, op: true });
  if (spec.optional) out.push({ e, a: DB_OPTIONAL, vt: ValueTag.Bool, v: true, t, op: true });
  if (spec.doc) out.push({ e, a: DB_DOC, vt: ValueTag.Str, v: spec.doc, t, op: true });
  return out;
}

/** Bootstrap attribute + catalog-singleton facts at `t` (no tx-instant). */
export function bootstrapFacts(t: number): Datom[] {
  const out: Datom[] = [];
  for (const s of BOOTSTRAP_SPECS) out.push(...attributeDatoms(s.id, s, t));
  out.push({ e: RAMOSE_CATALOG, a: DB_IDENT, vt: ValueTag.Str, v: RAMOSE_CATALOG_IDENT, t, op: true });
  return out;
}

/** The bootstrap transaction (t = 1): system attributes describing themselves. */
export function bootstrapDatoms(): Datom[] {
  const t = 1;
  const out = bootstrapFacts(t);
  out.push({ e: txEid(t), a: DB_TX_INSTANT, vt: ValueTag.Inst, v: 0, t, op: true });
  return out;
}

/**
 * Persisted bootstrap facts that this db is missing. `Schema.bootstrap()`
 * synthesizes attrs in memory; AVET / `db.exists` still need the durable
 * datoms (fixed eids 21, 51–53, and any other `BOOTSTRAP_SPECS` gap).
 * Empty when the log already has them — second boot is a no-op.
 */
export async function missingBootstrapDatoms(
  db: {
    first(
      index: number,
      prefix: { e?: number; a?: number; vt?: number; v?: unknown },
    ): Promise<Datom | undefined>;
  },
  t: number,
  txInstant = 0,
): Promise<Datom[]> {
  const missing: Datom[] = [];
  for (const d of bootstrapFacts(t)) {
    const found = await db.first(Index.EAVT, { e: d.e, a: d.a });
    if (found !== undefined && found.op && valueKey(found.vt, found.v) === valueKey(d.vt, d.v)) {
      continue;
    }
    missing.push(d);
  }
  if (missing.length === 0) return [];
  missing.unshift({ e: txEid(t), a: DB_TX_INSTANT, vt: ValueTag.Inst, v: txInstant, t, op: true });
  return missing;
}

// ---------------------------------------------------------------------------
// Schema projection
// ---------------------------------------------------------------------------

interface Partial {
  ident?: string | undefined;
  valueType?: string | undefined;
  cardinality?: string | undefined;
  unique?: string | undefined;
  index?: boolean | undefined;
  isComponent?: boolean | undefined;
  optional?: boolean | undefined;
  doc?: string | undefined;
}

export class Schema {
  private readonly byId = new Map<number, Attribute>();
  private readonly byIdent = new Map<string, Attribute>();
  /** every :db/ident (attributes and plain ident entities) → eid */
  private readonly idents = new Map<string, number>();
  private readonly identOf = new Map<number, string>();
  private readonly partials = new Map<number, Partial>();
  /** ident entity eid → `:ramose.kind/entity` | `:ramose.kind/trait` */
  private readonly kinds = new Map<number, string>();
  /** ident entity eid → direct composed trait idents */
  private readonly composeEdges = new Map<number, Set<string>>();

  static bootstrap(): Schema {
    return new Schema().apply(bootstrapDatoms());
  }

  clone(): Schema {
    const s = new Schema();
    for (const [k, v] of this.byId) s.byId.set(k, v);
    for (const [k, v] of this.byIdent) s.byIdent.set(k, v);
    for (const [k, v] of this.idents) s.idents.set(k, v);
    for (const [k, v] of this.identOf) s.identOf.set(k, v);
    for (const [k, v] of this.partials) s.partials.set(k, { ...v });
    for (const [k, v] of this.kinds) s.kinds.set(k, v);
    for (const [k, v] of this.composeEdges) s.composeEdges.set(k, new Set(v));
    return s;
  }

  /** Apply schema-relevant datoms (others are ignored). Mutates and returns this. */
  apply(datoms: readonly Datom[]): this {
    const touched = new Set<number>();
    for (const d of datoms) {
      if (d.a > DB_DOC) continue; // fast reject: user attrs have larger ids... unless < 1000; check below anyway
      let p = this.partials.get(d.e);
      switch (d.a) {
        case DB_IDENT: {
          if (!p) this.partials.set(d.e, (p = {}));
          if (d.op) {
            p.ident = d.v as string;
            this.idents.set(d.v as string, d.e);
            this.identOf.set(d.e, d.v as string);
          } else {
            if (this.idents.get(d.v as string) === d.e) this.idents.delete(d.v as string);
            this.identOf.delete(d.e);
            this.kinds.delete(d.e);
            this.composeEdges.delete(d.e);
            if (p.ident === d.v) p.ident = undefined;
          }
          touched.add(d.e);
          break;
        }
        case DB_VALUE_TYPE:
          if (!p) this.partials.set(d.e, (p = {}));
          p.valueType = d.op ? (d.v as string) : undefined;
          touched.add(d.e);
          break;
        case DB_CARDINALITY:
          if (!p) this.partials.set(d.e, (p = {}));
          p.cardinality = d.op ? (d.v as string) : undefined;
          touched.add(d.e);
          break;
        case DB_UNIQUE:
          if (!p) this.partials.set(d.e, (p = {}));
          p.unique = d.op ? (d.v as string) : undefined;
          touched.add(d.e);
          break;
        case DB_INDEX:
          if (!p) this.partials.set(d.e, (p = {}));
          p.index = d.op ? (d.v as boolean) : undefined;
          touched.add(d.e);
          break;
        case DB_OPTIONAL:
          if (!p) this.partials.set(d.e, (p = {}));
          p.optional = d.op ? (d.v as boolean) : undefined;
          touched.add(d.e);
          break;
        case DB_IS_COMPONENT:
          if (!p) this.partials.set(d.e, (p = {}));
          p.isComponent = d.op ? (d.v as boolean) : undefined;
          touched.add(d.e);
          break;
        case DB_DOC:
          if (!p) this.partials.set(d.e, (p = {}));
          p.doc = d.op ? (d.v as string) : undefined;
          touched.add(d.e);
          break;
        case RAMOSE_KIND:
          if (d.op) this.kinds.set(d.e, d.v as string);
          else if (this.kinds.get(d.e) === d.v) this.kinds.delete(d.e);
          break;
        case RAMOSE_COMPOSES: {
          const set = this.composeEdges.get(d.e) ?? new Set<string>();
          if (d.op) set.add(d.v as string);
          else set.delete(d.v as string);
          if (set.size === 0) this.composeEdges.delete(d.e);
          else this.composeEdges.set(d.e, set);
          break;
        }
        default:
          break;
      }
    }
    for (const e of touched) this.rebuild(e);
    return this;
  }

  private rebuild(e: number): void {
    const p = this.partials.get(e);
    const old = this.byId.get(e);
    if (old) {
      this.byId.delete(e);
      this.byIdent.delete(old.ident);
    }
    if (!p || !p.ident || !p.valueType) return;
    const vt = VALUE_TYPE_IDENTS[p.valueType];
    if (vt === undefined) return;
    const unique = p.unique === ":db.unique/identity" ? "identity" : p.unique === ":db.unique/value" ? "value" : undefined;
    const attr: Attribute = {
      id: e,
      ident: p.ident,
      valueType: vt,
      cardinality: p.cardinality === ":db.cardinality/many" ? "many" : "one",
      unique,
      index: !!p.index || unique !== undefined,
      isComponent: !!p.isComponent,
      doc: p.doc,
      optional: !!p.optional,
    };
    this.byId.set(e, attr);
    this.byIdent.set(attr.ident, attr);
  }

  attr(idOrIdent: number | string): Attribute | undefined {
    return typeof idOrIdent === "number" ? this.byId.get(idOrIdent) : this.byIdent.get(idOrIdent);
  }
  requireAttr(idOrIdent: number | string): Attribute {
    const a = this.attr(idOrIdent);
    if (!a) throw new Error(`unknown attribute ${String(idOrIdent)}`);
    return a;
  }
  /** Resolve an ident (attribute or plain ident entity) to its entity id. */
  entid(ident: string): number | undefined {
    return this.idents.get(ident);
  }
  ident(e: number): string | undefined {
    return this.identOf.get(e);
  }
  attributes(): Attribute[] {
    return [...this.byId.values()];
  }

  /** `:ramose.kind/entity` | `:ramose.kind/trait` when installed. */
  kindOf(ident: string): string | undefined {
    const e = this.idents.get(ident);
    return e === undefined ? undefined : this.kinds.get(e);
  }

  isTraitIdent(ident: string): boolean {
    return this.kindOf(ident) === RAMOSE_KIND_TRAIT;
  }

  isEntityIdent(ident: string): boolean {
    return this.kindOf(ident) === RAMOSE_KIND_ENTITY;
  }

  /** Direct `:ramose/composes` targets of `ident`. */
  composesOf(ident: string): readonly string[] {
    const e = this.idents.get(ident);
    if (e === undefined) return [];
    return [...(this.composeEdges.get(e) ?? [])];
  }

  /** Transitive composed trait idents, diamonds collapsed, sorted. */
  transitiveTraits(ident: string): readonly string[] {
    const out = new Set<string>();
    const stack = [...this.composesOf(ident)];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (out.has(next)) continue;
      out.add(next);
      for (const inner of this.composesOf(next)) stack.push(inner);
    }
    return [...out].sort();
  }

  /** Should datoms of attribute `a` be in AVET? (indexed or unique) */
  isAvet(a: number): boolean {
    const at = this.byId.get(a);
    return at !== undefined && at.index;
  }
  /** Should datoms of attribute `a` be in VAET? (refs) */
  isVaet(a: number): boolean {
    const at = this.byId.get(a);
    return at !== undefined && at.valueType === ValueTag.Ref;
  }
}
