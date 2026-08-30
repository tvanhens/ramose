import { type Datom, ValueTag, type ValueTag as VT } from "./datom.ts";

export const DB_IDENT = 10;
export const DB_VALUE_TYPE = 40;
export const DB_CARDINALITY = 41;
export const DB_UNIQUE = 42;
export const DB_IS_COMPONENT = 43;
export const DB_INDEX = 44;
export const DB_OPTIONAL = 45;
export const RAMOSE_TYPE = 46;
export const DB_TX_INSTANT = 50;
export const DB_DOC = 62;

export const RAMOSE_TYPE_IDENT = ":ramose/type";

export const FIRST_USER_EID = 1000;
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
  { id: DB_TX_INSTANT, ident: ":db/txInstant", valueType: ":db.type/instant", cardinality: "one", index: true },
  { id: DB_DOC, ident: ":db/doc", valueType: ":db.type/string", cardinality: "one" },
];

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

export function bootstrapDatoms(): Datom[] {
  const t = 1;
  const out: Datom[] = [];
  for (const s of BOOTSTRAP_SPECS) out.push(...attributeDatoms(s.id, s, t));
  out.push({ e: txEid(t), a: DB_TX_INSTANT, vt: ValueTag.Inst, v: 0, t, op: true });
  return out;
}

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
  private readonly idents = new Map<string, number>();
  private readonly identOf = new Map<number, string>();
  private readonly partials = new Map<number, Partial>();

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
    return s;
  }

  apply(datoms: readonly Datom[]): this {
    const touched = new Set<number>();
    for (const d of datoms) {
      if (d.a > DB_DOC) continue;
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
  entid(ident: string): number | undefined {
    return this.idents.get(ident);
  }
  ident(e: number): string | undefined {
    return this.identOf.get(e);
  }
  attributes(): Attribute[] {
    return [...this.byId.values()];
  }

  isAvet(a: number): boolean {
    const at = this.byId.get(a);
    return at !== undefined && at.index;
  }
  isVaet(a: number): boolean {
    const at = this.byId.get(a);
    return at !== undefined && at.valueType === ValueTag.Ref;
  }
}
