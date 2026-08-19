/**
 * Transaction processing — pure: (db, txData, t) → datoms.
 *
 * Used both by the in-memory `Connection` (M1) and the Transactor DO (M2);
 * it never touches storage directly, only reads through `Db`.
 *
 * Tx data forms (attribute names are ident strings, e.g. ":user/name"):
 *   [":db/add", e, a, v]
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
  VALUE_TYPE_IDENTS,
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
  kind: "add" | "retract" | "retractEntity";
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
        if (created !== undefined && created !== form) return resolveEntity(created, allocate);
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
      if (id === undefined) throw new TxError(`lookup ref ${JSON.stringify(form)} does not resolve`, "tx/lookup-ref");
      return id;
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
  const claims = new Map<string, string>(); // "attr|valueKey" → tempid

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
  // (a, valueKey) → e for unique attrs asserted in this tx
  const uniqueSeen = new Map<string, number>();

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

  // --- Value coercion --------------------------------------------------------
  const valueFor = async (attr: Attribute, v: unknown): Promise<TaggedValue> => {
    if (v === undefined || v === null) throw new TxError(`nil value for ${attr.ident}`);
    if (attr.valueType === ValueTag.Ref) {
      if (typeof v === "number") return { vt: ValueTag.Ref, v };
      const id = await resolveEntity(v, true);
      if (id === undefined) throw new TxError(`cannot resolve ref value ${JSON.stringify(v)} for ${attr.ident}`);
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
    const attr = attrOf(op.a);
    const e = await resolveEntity(op.e, op.kind === "add");
    if (e === undefined) continue;
    if (op.kind === "add") {
      const tv = await valueFor(attr, op.v);
      validateSchemaValue(attr, tv);
      await emitAdd(e, attr, tv);
    } else {
      const tv = op.hasV ? await valueFor(attr, op.v) : undefined;
      await emitRetract(e, attr, tv);
    }
  }

  // Tx entity instant (first, so tx datoms sort together nicely).
  out.unshift({ e: txe, a: DB_TX_INSTANT, vt: ValueTag.Inst, v: txInstant, t, op: true });

  const tempidsOut: Record<string, number> = {};
  for (const [k, v] of tempids) tempidsOut[k] = v;
  return { t, txEid: txe, datoms: out, tempids: tempidsOut, nextEid, newEntities, ops: expanded };
}
