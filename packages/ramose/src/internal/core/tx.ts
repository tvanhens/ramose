/**
 * Transaction processing — pure: (db, txData, t) → datoms.
 *
 * Used both by the in-memory `Connection` (M1) and the Transactor DO (M2);
 * it never touches storage directly, only reads through `Db`.
 *
 * Tx data forms (attribute names are ident strings, e.g. ":user/name"):
 *   [":db/add", e, a, v]
 *   [":db/update", e, a, v]              (never creates; missing subject rejects)
 *   [":db/update", e]                    (existence ping; no write)
 *   [":db/retract", e, a, v?]            (v omitted → retract all values)
 *   [":db/retractEntity", e]             (also retracts refs to e; components recursively)
 *   { ":db/id": e?, ":user/name": "Bob", ":user/friends": [ref, ...], ":user/_friends": [ref] }
 *
 * Entity forms: eid (number) | ident (":..." string) | tempid (other string)
 *   | lookup ref [":attr", value] | nested map (in ref-valued position)
 *   | ":db/tx" (the current transaction entity).
 *
 * Semantics (Datomic-inspired):
 *   - tempids sharing a :db.unique/identity value with an existing entity upsert
 *   - cardinality-one asserts retract the previous value implicitly
 *   - redundant asserts / retracts of absent facts are elided
 *   - :db.unique/value conflicts throw
 */

import {
  type Datom,
  type TaggedValue,
  Index,
  ValueTag,
  valueKey,
} from "./datom.ts";
import { Db } from "./db.ts";
import {
  type Attribute,
  DB_CARDINALITY,
  DB_IDENT,
  DB_TX_INSTANT,
  DB_UNIQUE,
  DB_VALUE_TYPE,
  RAMOSE_KIND,
  RAMOSE_KIND_ENTITY,
  RAMOSE_TRAIT_IDENT,
  RAMOSE_TYPE_IDENT,
  VALUE_TYPE_IDENTS,
  isTxEid,
  txEid,
} from "./schema.ts";

export class TxError extends Error {
  constructor(msg: string, readonly code: string = "tx/invalid") {
    super(msg);
  }
}

export type TxData = unknown[];

export interface TxResult {
  t: number;
  txEid: number;
  datoms: Datom[];
  tempids: Record<string, number>;
  nextEid: number;
}

type EForm = number | string | unknown[];

/** A tx item after map/reverse-ref expansion, before entity/value resolution. */
export interface TxOp {
  kind: "add" | "update" | "retract" | "retractEntity";
  e: EForm;
  a?: string | number;
  v?: unknown;
  hasV?: boolean;
}

/**
 * One concrete datom the tx will produce, with the provenance a policy check
 * needs: which resolved entity/attribute it lands on and why it exists.
 */
export interface ExpandedOp {
  readonly kind: "add" | "retract";
  readonly e: number;
  readonly a: number;
  readonly attr: Attribute;
  readonly datom: Datom;
  /** retract emitted by cardinality-one replacement */
  readonly implicit: boolean;
  /** retract emitted by a :db/retractEntity closure */
  readonly fromRetractEntity: boolean;
}

export interface TxExpansion extends TxResult {
  /** entity ids this tx allocates (never seen before), plus the tx entity */
  newEntities: Set<number>;
  /** the concrete per-datom ops, in emission order (tx-instant excluded) */
  ops: ExpandedOp[];
}

export interface ExpandOptions {
  /** max datoms a :db/retractEntity closure may produce before throwing */
  closureCap?: number;
}

/** Prefix of tempids generated for map forms without an explicit `:db/id`. */
export const GENERATED_TEMPID_PREFIX = "__ramose.tmp/";

const TX_TEMPID = new Set([":db/tx", "datomic.tx", "db.tx"]);

/**
 * Expand map forms into add ops. Returns the flat op list. Generated tempids
 * are numbered per call, so flattening the same tx data twice yields the same
 * names (the policy pre-check relies on it).
 */
export function flattenTxData(txData: TxData): TxOp[] {
  const ops: TxOp[] = [];
  let tmpCounter = 0;
  const freshTempid = (): string => `${GENERATED_TEMPID_PREFIX}${++tmpCounter}`;
  const expandMap = (m: Record<string, unknown>): EForm => {
    let e: EForm | undefined = m[":db/id"] as EForm | undefined;
    if (e === undefined || e === null) e = freshTempid();
    for (const [k, val] of Object.entries(m)) {
      if (k === ":db/id") continue;
      if (typeof k !== "string" || k[0] !== ":") throw new TxError(`bad attribute key ${k}`);
      const slash = k.lastIndexOf("/");
      const name = slash >= 0 ? k.slice(slash + 1) : k.slice(1);
      if (name.startsWith("_")) {
        // reverse ref: {:user/_friends [x y]} → x :user/friends e
        const attr = slash >= 0 ? k.slice(0, slash + 1) + name.slice(1) : ":" + name.slice(1);
        const vals = Array.isArray(val) ? val : [val];
        for (const x of vals) {
          const other = isPlainObject(x) ? expandMap(x as Record<string, unknown>) : (x as EForm);
          ops.push({ kind: "add", e: other, a: attr, v: e, hasV: true });
        }
        continue;
      }
      const vals = Array.isArray(val) && !isLookupRef(val) ? val : [val];
      for (const x of vals) {
        const v = isPlainObject(x) ? expandMap(x as Record<string, unknown>) : x;
        ops.push({ kind: "add", e, a: k, v, hasV: true });
      }
    }
    return e;
  };
  for (const item of txData) {
    if (Array.isArray(item)) {
      const [op, e, a, v] = item as unknown[];
      switch (op) {
        case ":db/add":
          if (item.length !== 4) throw new TxError(":db/add needs [op e a v]");
          ops.push({ kind: "add", e: e as EForm, a: a as string | number, v: isPlainObject(v) ? expandMap(v as Record<string, unknown>) : v, hasV: true });
          break;
        case ":db/update":
          if (item.length === 2) {
            ops.push({ kind: "update", e: e as EForm, hasV: false });
            break;
          }
          if (item.length !== 4) throw new TxError(":db/update needs [op e a v]");
          {
            const vals = Array.isArray(v) && !isLookupRef(v) ? v : [v];
            for (const x of vals) {
              ops.push({
                kind: "update",
                e: e as EForm,
                a: a as string | number,
                v: isPlainObject(x) ? expandMap(x as Record<string, unknown>) : x,
                hasV: true,
              });
            }
          }
          break;
        case ":db/retract":
          if (item.length !== 3 && item.length !== 4) throw new TxError(":db/retract needs [op e a v?]");
          ops.push({ kind: "retract", e: e as EForm, a: a as string | number, v, hasV: item.length === 4 });
          break;
        case ":db/retractEntity":
        case ":db.fn/retractEntity":
          ops.push({ kind: "retractEntity", e: e as EForm });
          break;
        default:
          throw new TxError(`unknown tx op ${String(op)}`);
      }
    } else if (isPlainObject(item)) {
      expandMap(item as Record<string, unknown>);
    } else {
      throw new TxError(`bad tx item ${String(item)}`);
    }
  }
  return ops;
}

function isPlainObject(x: unknown): boolean {
  return (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    !(x instanceof Date) &&
    !(x instanceof Uint8Array) &&
    !("vt" in (x as any) && "v" in (x as any) && Object.keys(x as any).length === 2)
  );
}
function isLookupRef(x: unknown): x is [string, unknown] {
  return Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && x[0][0] === ":";
}
function isTempid(x: unknown): x is string {
  return typeof x === "string" && x[0] !== ":";
}

/**
 * Process a transaction against `db`, producing the datoms for tx `t`.
 * `nextEid` is the first free entity id; the returned `nextEid` accounts for
 * allocations. `txInstant` is epoch ms.
 */
export async function processTx(
  db: Db,
  txData: TxData,
  t: number,
  nextEid: number,
  txInstant: number,
): Promise<TxResult> {
  const { ops: _ops, newEntities: _ne, ...res } = await expandTx(db, txData, t, nextEid, txInstant);
  return res;
}

/**
 * `processTx` plus the per-datom provenance the policy layer checks against.
 * Same semantics — `processTx` is a projection of this.
 */
export async function expandTx(
  db: Db,
  txData: TxData,
  t: number,
  nextEid: number,
  txInstant: number,
  options: ExpandOptions = {},
): Promise<TxExpansion> {
  const ops = flattenTxData(txData);
  const txe = txEid(t);
  const tempids = new Map<string, number>();
  const claims = new Map<string, string>(); // "attr|valueKey" → tempid
  // (a, valueKey) → e for unique attrs asserted in this tx
  const uniqueSeen = new Map<string, number>();
  const out: Datom[] = [];
  const expanded: ExpandedOp[] = [];
  const newEntities = new Set<number>([txe]);
  const closureCap = options.closureCap ?? Number.POSITIVE_INFINITY;
  let closureCount = 0;
  let inRetractEntity = false;
  const record = (kind: "add" | "retract", e: number, attr: Attribute, d: Datom, implicit = false): void => {
    expanded.push({ kind, e, a: attr.id, attr, datom: d, implicit, fromRetractEntity: inRetractEntity });
    if (inRetractEntity && ++closureCount > closureCap) {
      throw new TxError(`:db/retractEntity closure exceeds ${closureCap} datoms`, "tx/closure-cap");
    }
  };

  // --- Attribute resolution -------------------------------------------------
  const attrOf = (a: string | number | undefined): Attribute => {
    if (a === undefined) throw new TxError("missing attribute");
    const at = db.attr(a);
    if (!at) throw new TxError(`unknown attribute ${String(a)}`, "tx/unknown-attribute");
    return at;
  };

  // --- Idents created in this tx (so later ops can reference them) ---------
  const newIdents = new Map<string, EForm>();
  for (const op of ops) {
    if (op.kind === "add" && op.a === ":db/ident" && typeof op.v === "string") newIdents.set(op.v, op.e);
  }

  // --- Entity form → eid ----------------------------------------------------
  const resolveEntity = async (form: unknown, allocate: boolean): Promise<number | undefined> => {
    if (typeof form === "number") {
      if (!Number.isSafeInteger(form) || form < 0) throw new TxError(`bad entity id ${form}`);
      return form;
    }
    if (typeof form === "string") {
      if (TX_TEMPID.has(form)) return txe;
      if (form[0] === ":") {
        const id = db.schema.entid(form);
        if (id !== undefined) return id;
        const created = newIdents.get(form);
        // The ident's backing entity is a subject of the `:db/ident` add —
        // allocate even when the caller is resolving a ref value.
        if (created !== undefined && created !== form) return resolveEntity(created, true);
        throw new TxError(`unknown ident ${form}`, "tx/unknown-ident");
      }
      // tempid (possibly aliased to another tempid via a shared unique-identity value)
      const canonical = aliasOf(form);
      const known = tempids.get(canonical);
      if (known !== undefined) {
        if (canonical !== form) tempids.set(form, known);
        return known;
      }
      if (!allocate) return undefined;
      const id = nextEid++;
      newEntities.add(id);
      tempids.set(canonical, id);
      if (canonical !== form) tempids.set(form, id);
      return id;
    }
    if (isLookupRef(form)) {
      const id = await db.entid(form);
      if (id !== undefined) return id;
      const sameTx = resolveLookupInTx(form);
      if (sameTx !== undefined) return sameTx;
      throw new TxError(`lookup ref ${JSON.stringify(form)} does not resolve`, "tx/lookup-ref");
    }
    if (form !== null && typeof form === "object" && "vt" in (form as any) && (form as any).vt === ValueTag.Ref) {
      return (form as TaggedValue).v as number;
    }
    throw new TxError(`bad entity form ${JSON.stringify(form)}`);
  };

  // --- Tempid aliases: two tempids asserting the same unique-identity value are one entity
  const aliases = new Map<string, string>();
  const aliasOf = (tid: string): string => {
    let cur = tid;
    for (;;) {
      const next = aliases.get(cur);
      if (next === undefined || next === cur) return cur;
      cur = next;
    }
  };

  /** Unique identity asserted earlier in this tx — so `:db/update` lookups see same-tx puts. */
  const resolveLookupInTx = (form: readonly [string, unknown]): number | undefined => {
    let attr: Attribute;
    try {
      attr = attrOf(form[0]);
    } catch {
      return undefined;
    }
    if (!attr.unique) return undefined;
    let tv: TaggedValue;
    try {
      tv =
        attr.valueType === ValueTag.Ref && typeof form[1] === "string" && form[1][0] === ":"
          ? { vt: ValueTag.Ref, v: db.schema.entid(form[1])! }
          : db.coerce(attr, form[1]);
    } catch {
      return undefined;
    }
    if (tv.v === undefined) return undefined;
    const uk = attr.id + "|" + valueKey(tv.vt, tv.v);
    const seen = uniqueSeen.get(uk);
    if (seen !== undefined) return seen;
    const claimant = claims.get(uk);
    if (claimant === undefined) return undefined;
    return tempids.get(aliasOf(claimant));
  };

  // --- Upsert pass: tempids that assert a unique-identity value already in the db
  for (const op of ops) {
    if (op.kind !== "add" || !isTempid(op.e) || TX_TEMPID.has(op.e)) continue;
    const attr = attrOf(op.a);
    if (attr.unique !== "identity") continue;
    // Only ref-typed attributes can carry tempid / lookup-ref / nested-map values;
    // for scalar types a non-":" string is a plain value, not a tempid.
    if (attr.valueType === ValueTag.Ref && (isTempid(op.v) || isLookupRef(op.v) || isPlainObject(op.v))) continue;
    let tv: TaggedValue;
    try {
      tv = attr.valueType === ValueTag.Ref && typeof op.v === "string" && op.v[0] === ":"
        ? { vt: ValueTag.Ref, v: db.schema.entid(op.v)! }
        : db.coerce(attr, op.v);
    } catch {
      continue; // will be reported by the main pass
    }
    if (tv.v === undefined) continue;
    const claimKey = attr.id + "|" + valueKey(tv.vt, tv.v);
    const existing = await db.first(Index.AVET, { a: attr.id, vt: tv.vt, v: tv.v });
    const canonical = aliasOf(op.e);
    if (existing) {
      const prev = tempids.get(canonical);
      if (prev !== undefined && prev !== existing.e) {
        throw new TxError(`tempid ${op.e} resolves to two entities (${prev}, ${existing.e})`, "tx/unique-conflict");
      }
      tempids.set(canonical, existing.e);
    }
    const claimant = claims.get(claimKey);
    if (claimant === undefined) claims.set(claimKey, canonical);
    else if (aliasOf(claimant) !== canonical) {
      // unify: both tempids denote the same entity
      const target = aliasOf(claimant);
      const a = tempids.get(canonical), b = tempids.get(target);
      if (a !== undefined && b !== undefined && a !== b) {
        throw new TxError(`tempids ${op.e} and ${claimant} resolve to different entities`, "tx/unique-conflict");
      }
      aliases.set(canonical, target);
      if (a !== undefined && b === undefined) tempids.set(target, a);
    }
  }

  // --- Within-tx state overlay ---------------------------------------------
  // (e,a) → valueKey → datom (present in the current view + this tx so far)
  const cur = new Map<string, Map<string, Datom>>();
  const current = async (e: number, a: number): Promise<Map<string, Datom>> => {
    const k = e + ":" + a;
    let m = cur.get(k);
    if (m) return m;
    m = new Map();
    for (const d of await db.datomsArray(Index.EAVT, { e, a })) m.set(valueKey(d.vt, d.v), d);
    cur.set(k, m);
    return m;
  };

  const emitAdd = async (e: number, attr: Attribute, tv: TaggedValue): Promise<void> => {
    const vals = await current(e, attr.id);
    const vk = valueKey(tv.vt, tv.v);
    if (vals.has(vk)) return; // redundant
    if (attr.unique) {
      const uk = attr.id + "|" + vk;
      const seen = uniqueSeen.get(uk);
      if (seen !== undefined && seen !== e) {
        throw new TxError(`unique conflict: ${attr.ident} ${String(tv.v)} already asserted for ${seen}`, "tx/unique-conflict");
      }
      const other = await db.first(Index.AVET, { a: attr.id, vt: tv.vt, v: tv.v });
      if (other && other.e !== e) {
        // if `other` retracted it earlier in this tx, allow
        const ov = await current(other.e, attr.id);
        if (ov.has(vk)) {
          throw new TxError(`unique conflict: ${attr.ident} ${String(tv.v)} already belongs to entity ${other.e}`, "tx/unique-conflict");
        }
      }
      uniqueSeen.set(uk, e);
    }
    if (attr.cardinality === "one" && vals.size > 0) {
      for (const [ok, od] of vals) {
        const r: Datom = { e, a: attr.id, vt: od.vt, v: od.v, t, op: false };
        out.push(r);
        record("retract", e, attr, r, true);
        vals.delete(ok);
      }
    }
    const d: Datom = { e, a: attr.id, vt: tv.vt, v: tv.v, t, op: true };
    out.push(d);
    record("add", e, attr, d);
    vals.set(vk, d);
  };

  const emitRetract = async (e: number, attr: Attribute, tv: TaggedValue | undefined): Promise<void> => {
    const vals = await current(e, attr.id);
    if (tv === undefined) {
      for (const [k, d] of vals) {
        const r: Datom = { e, a: attr.id, vt: d.vt, v: d.v, t, op: false };
        out.push(r);
        record("retract", e, attr, r);
        vals.delete(k);
      }
      return;
    }
    const vk = valueKey(tv.vt, tv.v);
    const d = vals.get(vk);
    if (!d) return; // absent → elide
    const r: Datom = { e, a: attr.id, vt: d.vt, v: d.v, t, op: false };
    out.push(r);
    record("retract", e, attr, r);
    vals.delete(vk);
  };

  const retracted = new Set<number>();
  const retractEntity = async (e: number): Promise<void> => {
    if (retracted.has(e)) return;
    retracted.add(e);
    const own = await db.datomsArray(Index.EAVT, { e });
    for (const d of own) {
      const attr = db.attr(d.a);
      await emitRetract(e, attr ?? ({ id: d.a } as Attribute), { vt: d.vt, v: d.v });
      if (attr?.isComponent && d.vt === ValueTag.Ref) await retractEntity(d.v as number);
    }
    // incoming refs
    const incoming = await db.datomsArray(Index.VAET, { vt: ValueTag.Ref, v: e });
    for (const d of incoming) {
      const attr = db.attr(d.a);
      if (attr) await emitRetract(d.e, attr, { vt: d.vt, v: d.v });
    }
    // refs asserted earlier in this tx pointing at e (overlay) are dropped too
    for (const [k, m] of cur) {
      const [ee, aa] = k.split(":").map(Number);
      const attr = db.attr(aa);
      if (attr && attr.valueType === ValueTag.Ref) {
        for (const [vk, d] of m) {
          if (d.v === e && d.t === t) {
            const r: Datom = { e: ee, a: aa, vt: d.vt, v: d.v, t, op: false };
            out.push(r);
            record("retract", ee, attr, r);
            m.delete(vk);
          }
        }
      }
    }
  };

  // Tempid subjects of add/update — a ref may resolve these. A tempid that
  // appears only as a ref value is a dangling mint and is rejected.
  const subjectTempids = new Set<string>();
  for (const op of ops) {
    if (op.kind !== "add" && op.kind !== "update") continue;
    if (isTempid(op.e) && !TX_TEMPID.has(op.e)) {
      subjectTempids.add(aliasOf(op.e));
      subjectTempids.add(op.e);
    }
  }

  // --- Value coercion --------------------------------------------------------
  const valueFor = async (
    attr: Attribute,
    v: unknown,
    bindRef = false,
  ): Promise<TaggedValue> => {
    if (v === undefined || v === null) throw new TxError(`nil value for ${attr.ident}`);
    if (attr.valueType === ValueTag.Ref) {
      if (typeof v === "number") {
        if (!Number.isSafeInteger(v) || v < 0) throw new TxError(`bad entity id ${v}`);
        if (bindRef && !(await entityPresent(v))) {
          throw new TxError(`entity ${v} does not exist`, "tx/missing-entity");
        }
        return { vt: ValueTag.Ref, v };
      }
      const allocate = bindRef && isTempid(v) && subjectTempids.has(aliasOf(v));
      const id = await resolveEntity(v, allocate);
      if (id === undefined) {
        throw new TxError(
          `cannot resolve ref value ${JSON.stringify(v)} for ${attr.ident}`,
          "tx/missing-entity",
        );
      }
      if (bindRef && !(await entityPresent(id))) {
        throw new TxError(`entity ${id} does not exist`, "tx/missing-entity");
      }
      return { vt: ValueTag.Ref, v: id };
    }
    try {
      return db.coerce(attr, v);
    } catch (err) {
      throw new TxError(`${attr.ident}: ${(err as Error).message}`, "tx/type-mismatch");
    }
  };

  // --- Schema-attribute value validation ------------------------------------
  const validateSchemaValue = (attr: Attribute, tv: TaggedValue): void => {
    if (attr.id === DB_VALUE_TYPE && !(String(tv.v) in VALUE_TYPE_IDENTS)) {
      throw new TxError(`invalid :db/valueType ${String(tv.v)}`, "tx/schema");
    }
    if (attr.id === DB_CARDINALITY && tv.v !== ":db.cardinality/one" && tv.v !== ":db.cardinality/many") {
      throw new TxError(`invalid :db/cardinality ${String(tv.v)}`, "tx/schema");
    }
    if (attr.id === DB_UNIQUE && tv.v !== ":db.unique/identity" && tv.v !== ":db.unique/value") {
      throw new TxError(`invalid :db/unique ${String(tv.v)}`, "tx/schema");
    }
    if (attr.id === DB_IDENT && (typeof tv.v !== "string" || tv.v[0] !== ":")) {
      throw new TxError(`:db/ident must be a keyword-like string starting with ':'`, "tx/schema");
    }
    if (
      (attr.ident === RAMOSE_TYPE_IDENT ||
        attr.ident === RAMOSE_TRAIT_IDENT ||
        attr.id === RAMOSE_KIND) &&
      (typeof tv.v !== "string" || tv.v[0] !== ":")
    ) {
      throw new TxError(`${attr.ident} must be a keyword-like string starting with ':'`, "tx/schema");
    }
  };

  const nsOfIdent = (ident: string): string => {
    const slash = ident.indexOf("/", 1);
    return slash > 0 ? ident.slice(1, slash) : "";
  };

  /** `:issue/title` → `issue`; composer idents `:issue` / `:taggable` → the name. */
  const nsOfComposer = (ident: string): string => {
    const ns = nsOfIdent(ident);
    if (ns.length > 0) return ns;
    return ident.startsWith(":") ? ident.slice(1) : ident;
  };

  const isSystemIdent = (ident: string): boolean =>
    ident.startsWith(":db/") || ident.startsWith(":ramose/");

  const isMembershipIdent = (ident: string): boolean =>
    ident === RAMOSE_TYPE_IDENT || ident === RAMOSE_TRAIT_IDENT;

  const appNamespacesOf = (idents: readonly string[]): Set<string> => {
    const nss = new Set<string>();
    for (const ident of idents) {
      if (isSystemIdent(ident)) continue;
      const ns = nsOfIdent(ident);
      if (ns.length === 0) continue;
      if (db.schema.isTraitIdent(`:${ns}`)) continue;
      nss.add(ns);
    }
    return nss;
  };

  const presentIdents = async (e: number): Promise<string[]> => {
    const idents: string[] = [];
    const seen = new Set<string>();
    const add = (ident: string | undefined): void => {
      if (ident === undefined || seen.has(ident)) return;
      seen.add(ident);
      idents.push(ident);
    };
    for (const [k, m] of cur) {
      if (!k.startsWith(e + ":") || m.size === 0) continue;
      const a = Number(k.slice(String(e).length + 1));
      add(db.attr(a)?.ident);
    }
    if ((await db.exists(e)) && !retracted.has(e)) {
      const row = await db.entity(e);
      if (row !== undefined) {
        for (const key of Object.keys(row)) {
          if (key !== ":db/id") add(key);
        }
      }
    }
    return idents;
  };

  const entityPresent = async (e: number): Promise<boolean> => {
    if (retracted.has(e)) return false;
    if (newEntities.has(e)) return true;
    for (const [k, m] of cur) {
      if (k.startsWith(e + ":") && m.size > 0) return true;
    }
    return db.exists(e);
  };

  const dbAppNamespaces = async (e: number): Promise<Set<string>> => {
    if (!(await db.exists(e)) || retracted.has(e)) return new Set();
    const row = await db.entity(e);
    if (row === undefined) return new Set();
    return appNamespacesOf(Object.keys(row).filter((k) => k !== ":db/id"));
  };

  const typeAttr = (): Attribute | undefined => db.attr(RAMOSE_TYPE_IDENT);
  const traitAttr = (): Attribute | undefined => db.attr(RAMOSE_TRAIT_IDENT);

  const readType = async (e: number): Promise<string | undefined> => {
    const attr = typeAttr();
    if (attr === undefined) return undefined;
    const vals = await current(e, attr.id);
    if (vals.size === 0) return undefined;
    const first = vals.values().next().value;
    return typeof first?.v === "string" ? first.v : undefined;
  };

  /**
   * `preTx`: only namespaces that existed before this tx. Add/set use that so
   * a same-tx bag can still take a second namespace; put onto a pre-existing
   * other-namespace row is still `tx/wrong-entity`.
   */
  const assertWriteTarget = async (
    e: number,
    attr: Attribute,
    preTx: boolean,
  ): Promise<void> => {
    if (!(await entityPresent(e))) {
      throw new TxError(`entity ${e} does not exist`, "tx/missing-entity");
    }
    const ns = nsOfIdent(attr.ident);
    if (ns.length === 0 || isSystemIdent(attr.ident)) return;
    const existing = preTx
      ? await dbAppNamespaces(e)
      : appNamespacesOf(await presentIdents(e));
    if (existing.size === 0) return;
    if (existing.has(ns)) return;
    const allowed = new Set(existing);
    for (const entityNs of existing) {
      for (const trait of db.schema.transitiveTraits(`:${entityNs}`)) {
        allowed.add(nsOfComposer(trait));
      }
    }
    const typeIdent = await readType(e);
    if (typeIdent !== undefined) {
      allowed.add(nsOfComposer(typeIdent));
      for (const trait of db.schema.transitiveTraits(typeIdent)) {
        allowed.add(nsOfComposer(trait));
      }
    }
    if (!allowed.has(ns)) {
      throw new TxError(`entity ${e} is not a ${ns}`, "tx/wrong-entity");
    }
  };

  // --- Main pass ------------------------------------------------------------
  for (const op of ops) {
    if (op.kind === "retractEntity") {
      const e = await resolveEntity(op.e, false);
      if (e === undefined) continue; // unresolved tempid → nothing to retract
      inRetractEntity = true;
      try {
        await retractEntity(e);
      } finally {
        inRetractEntity = false;
      }
      continue;
    }
    if (op.kind === "update") {
      let e: number | undefined;
      try {
        e = await resolveEntity(op.e, false);
      } catch (err) {
        if (err instanceof TxError && err.code === "tx/lookup-ref") {
          throw new TxError(err.message, "tx/missing-entity");
        }
        throw err;
      }
      if (e === undefined) {
        throw new TxError(
          `entity ${JSON.stringify(op.e)} does not exist`,
          "tx/missing-entity",
        );
      }
      if (typeof op.e === "number" && !(await entityPresent(e))) {
        throw new TxError(`entity ${e} does not exist`, "tx/missing-entity");
      }
      if (op.a === undefined || op.hasV === false) {
        if (!(await entityPresent(e))) {
          throw new TxError(`entity ${e} does not exist`, "tx/missing-entity");
        }
        continue;
      }
      const attr = attrOf(op.a);
      await assertWriteTarget(e, attr, false);
      const tv = await valueFor(attr, op.v, true);
      validateSchemaValue(attr, tv);
      await emitAdd(e, attr, tv);
      continue;
    }
    const attr = attrOf(op.a);
    const e = await resolveEntity(op.e, op.kind === "add");
    if (e === undefined) continue;
    if (op.kind === "add") {
      await assertWriteTarget(e, attr, true);
      const tv = await valueFor(attr, op.v, true);
      validateSchemaValue(attr, tv);
      await emitAdd(e, attr, tv);
    } else {
      const tv = op.hasV ? await valueFor(attr, op.v) : undefined;
      await emitRetract(e, attr, tv);
    }
  }

  const requiredOfNs = (ns: string): Attribute[] =>
    db.schema.attributes().filter(
      (a) =>
        a.ident.startsWith(`:${ns}/`) &&
        a.cardinality === "one" &&
        !a.optional,
    );

  const requiredOfType = (typeIdent: string): Attribute[] => {
    const nss = [
      nsOfComposer(typeIdent),
      ...db.schema.transitiveTraits(typeIdent).map(nsOfComposer),
    ];
    const out: Attribute[] = [];
    const seen = new Set<string>();
    for (const ns of nss) {
      if (ns.length === 0) continue;
      for (const attr of requiredOfNs(ns)) {
        if (seen.has(attr.ident)) continue;
        seen.add(attr.ident);
        out.push(attr);
      }
    }
    return out;
  };

  const missingRequired = async (e: number, nss: Set<string>): Promise<string[]> => {
    const missing: string[] = [];
    for (const ns of nss) {
      for (const attr of requiredOfNs(ns)) {
        const vals = await current(e, attr.id);
        if (vals.size === 0) missing.push(attr.ident);
      }
    }
    return missing;
  };

  const missingRequiredAttrs = async (
    e: number,
    attrs: readonly Attribute[],
  ): Promise<string[]> => {
    const missing: string[] = [];
    for (const attr of attrs) {
      const vals = await current(e, attr.id);
      if (vals.size === 0) missing.push(attr.ident);
    }
    return missing;
  };

  const inferType = async (e: number): Promise<string | undefined> => {
    const asserted = await readType(e);
    if (asserted !== undefined) return asserted;
    const nss = appNamespacesOf(await presentIdents(e));
    const entityNss = [...nss].filter((ns) =>
      db.schema.isEntityIdent(`:${ns}`),
    );
    if (entityNss.length === 1) return `:${entityNss[0]}`;
    return undefined;
  };

  // First datom in a new app namespace is a creation in that namespace —
  // required fields must be present, including on an existing entity (H1/H2).
  const touched = new Set<number>();
  for (const op of expanded) {
    if (op.kind !== "add" || isTxEid(op.e)) continue;
    touched.add(op.e);
  }

  for (const op of expanded) {
    if (!isMembershipIdent(op.attr.ident)) continue;
    if (op.fromRetractEntity) continue;
    throw new TxError(
      op.kind === "retract"
        ? `cannot retract system fact ${op.attr.ident}`
        : `cannot write system fact ${op.attr.ident}`,
      "tx/system",
    );
  }

  for (const e of touched) {
    if (retracted.has(e) || isTxEid(e)) continue;
    const typeBefore = await (async () => {
      if (!(await db.exists(e)) || retracted.has(e)) return undefined;
      const attr = typeAttr();
      if (attr === undefined) return undefined;
      const row = await db.entity(e);
      const v = row?.[RAMOSE_TYPE_IDENT];
      return typeof v === "string" ? v : undefined;
    })();
    const type = await inferType(e);
    const composed =
      type !== undefined && db.schema.isEntityIdent(type)
        ? db.schema.transitiveTraits(type)
        : [];

    if (typeBefore !== undefined) {
      const typeAfter = await readType(e);
      if (typeAfter !== undefined && typeAfter !== typeBefore) {
        throw new TxError(`cannot change system fact ${RAMOSE_TYPE_IDENT}`, "tx/system");
      }
    } else if (type !== undefined && db.schema.isEntityIdent(type)) {
      const ta = typeAttr();
      const tr = traitAttr();
      if (ta !== undefined) {
        await emitAdd(e, ta, { vt: ValueTag.Str, v: type });
      }
      if (tr !== undefined) {
        for (const trait of composed) {
          await emitAdd(e, tr, { vt: ValueTag.Str, v: trait });
        }
      }
    }

    const before = await dbAppNamespaces(e);
    const after = appNamespacesOf(await presentIdents(e));
    const born = new Set<string>();
    for (const ns of after) {
      if (!before.has(ns)) born.add(ns);
    }
    const typeIsNew = type !== undefined && typeBefore === undefined;
    if (typeIsNew && db.schema.isEntityIdent(type)) {
      const missing = await missingRequiredAttrs(e, requiredOfType(type));
      if (missing.length > 0) {
        throw new TxError(
          `entity ${nsOfComposer(type)} is missing required fields: ${missing.join(", ")}`,
          "tx/required",
        );
      }
      continue;
    }
    if (born.size === 0) continue;
    const missing = await missingRequired(e, born);
    if (missing.length > 0) {
      const entity = [...born][0] ?? "entity";
      throw new TxError(
        `entity ${entity} is missing required fields: ${missing.join(", ")}`,
        "tx/required",
      );
    }
  }

  for (const op of expanded) {
    if (op.kind !== "retract" || op.implicit) continue;
    if (op.attr.cardinality !== "one" || op.attr.optional) continue;
    if (op.attr.ident.startsWith(":db/")) continue;
    if (retracted.has(op.e) || isTxEid(op.e)) continue;
    const vals = await current(op.e, op.attr.id);
    if (vals.size > 0) continue;
    const nss = appNamespacesOf(await presentIdents(op.e));
    if (nss.size === 0) continue;
    throw new TxError(
      op.fromRetractEntity
        ? `entity ${op.e} still references the deleted entity via required ${op.attr.ident} — delete or re-point it first`
        : `cannot clear required field ${op.attr.ident}`,
      "tx/required",
    );
  }

  // Tx entity instant (first, so tx datoms sort together nicely).
  out.unshift({ e: txe, a: DB_TX_INSTANT, vt: ValueTag.Inst, v: txInstant, t, op: true });

  const tempidsOut: Record<string, number> = {};
  for (const [k, v] of tempids) tempidsOut[k] = v;
  return { t, txEid: txe, datoms: out, tempids: tempidsOut, nextEid, newEntities, ops: expanded };
}
