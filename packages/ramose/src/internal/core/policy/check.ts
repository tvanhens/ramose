/** The write check: pure, run against the pre-state db the tx will apply to. */

import { ValueTag, valueKey } from "../datom.ts";
import type { Db } from "../db.ts";
import type { Schema } from "../schema.ts";
import { GENERATED_TEMPID_PREFIX, type TxData, TxError, expandTx, flattenTxData } from "../tx.ts";
import { type CompiledPolicy, type PolicyOp, nsPrefix } from "./ast.ts";
import { PolicyMemo, type RefOverlay, allowsOp, isSystemAttrId, presetValue } from "./eval.ts";
import { type Principal, isSuperuser } from "./principal.ts";

/** Max datoms a `:db/retractEntity` closure may touch before it is denied. */
export const RETRACT_ENTITY_CAP = 10_000;

/** Never carries values or eids. */
export interface PolicyDenied {
  readonly ok: false;
  readonly code: "policy";
  readonly attr: string;
  readonly op: string;
}
export type CheckTxResult = { readonly ok: true; readonly ops: unknown[] } | PolicyDenied;

const deny = (attr: string, op: string): PolicyDenied => ({ ok: false, code: "policy", attr, op });

/**
 * Every op is a map form carrying `:db/ident` — i.e. an `ensure`.
 * Empty `tx` is not schema (nothing to ensure).
 */
export function isSchemaTx(tx: unknown): tx is readonly Record<string, unknown>[] {
  if (!Array.isArray(tx) || tx.length === 0) return false;
  for (const op of tx) {
    if (typeof op !== "object" || op === null || Array.isArray(op)) return false;
    if (typeof (op as Record<string, unknown>)[":db/ident"] !== "string") return false;
  }
  return true;
}

/** An entity the tx creates: how to name it in tx data + what it asserts. */
export interface NewEntity {
  readonly ref: number | string;
  readonly attrs: readonly string[];
}

/**
 * The `:db/add` ops the peer injects for preset attributes on create. An
 * attribute is injected only for new entities that already assert something in
 * its namespace, and never over a value the tx supplies.
 */
export function presetOps(
  policy: CompiledPolicy,
  principal: Principal,
  newEntities: readonly NewEntity[],
): CheckTxResult {
  const ops: unknown[] = [];
  for (const ent of newEntities) {
    const namespaces = new Set(ent.attrs.map(nsPrefix));
    for (const [ident, operand] of Object.entries(policy.preset)) {
      if (ent.attrs.includes(ident)) continue; // supplied by the tx (already validated)
      if (!namespaces.has(nsPrefix(ident))) continue;
      const value = presetValue(operand, principal);
      if (value === undefined) return deny(ident, "create");
      ops.push([":db/add", ent.ref, ident, value]);
    }
  }
  return { ok: true, ops };
}

/**
 * Expand `txData` exactly as `processTx` would against `db`, then check every
 * resulting `(op, e, a)`. Returns the ops to transact (with preset injections)
 * or the first denial.
 */
export async function checkTx(
  txData: TxData,
  db: Db,
  policy: CompiledPolicy,
  principal: Principal,
  schema?: Schema,
): Promise<CheckTxResult> {
  const ops = txData as unknown[];
  if (isSuperuser(principal, policy)) return { ok: true, ops };
  const sch = schema ?? db.schema;

  // Attributes outside the deployed schema (and schema ops) never reach a rule.
  // An attribute-less `:db/update` is an existence ping (no write) — not a
  // policy verb. `expandTx` still rejects a missing subject as tx/missing-entity.
  for (const op of flattenTxData(txData)) {
    if (op.kind === "retractEntity") continue;
    if (op.kind === "update" && op.a === undefined) continue;
    const at = op.a === undefined ? undefined : sch.attr(op.a);
    if (!at) return deny(String(op.a), op.kind);
    if (isSystemAttrId(at.id)) return deny(at.ident, op.kind);
  }

  let x;
  try {
    x = await expandTx(db, txData, db.basisT + 1, db.nextEid, 0, { closureCap: RETRACT_ENTITY_CAP });
  } catch (err) {
    if (err instanceof TxError && err.code === "tx/closure-cap") return deny(":db/retractEntity", "retractEntity");
    throw err;
  }

  // Refs this tx asserts — a `create` rule may resolve its parent through them.
  const overlay = new Map<string, number[]>();
  for (const o of x.ops) {
    if (o.kind !== "add" || o.datom.vt !== ValueTag.Ref) continue;
    const k = o.e + "|" + o.a;
    const cur = overlay.get(k);
    if (cur) cur.push(o.datom.v as number);
    else overlay.set(k, [o.datom.v as number]);
  }

  // Separate memos: `create` arms see the overlay, everything else does not.
  const memo = new PolicyMemo();
  const createMemo = new PolicyMemo();

  for (const o of x.ops) {
    const ident = o.attr.ident;
    if (ident === undefined || isSystemAttrId(o.a)) return deny(ident ?? String(o.a), o.kind);
    const isCreate = o.kind === "add" && x.newEntities.has(o.e);
    const pop: PolicyOp = o.fromRetractEntity
      ? "retractEntity"
      : o.kind === "retract"
        ? "retract"
        : isCreate
          ? "create"
          : "add";
    if (pop === "create") {
      const operand = policy.preset[ident];
      if (operand !== undefined) {
        // The peer owns preset values: a differing client value is a denial,
        // an identical one is a no-op (so ingress + transactor both pass).
        const want = presetValue(operand, principal);
        if (want === undefined) return deny(ident, "create");
        let tv;
        try {
          tv = db.coerce(o.attr, want);
        } catch {
          return deny(ident, "create");
        }
        if (valueKey(tv.vt, tv.v) !== valueKey(o.datom.vt, o.datom.v)) return deny(ident, "create");
        continue;
      }
    }
    // create arms see in-tx refs (overlay); every other verb is db-before only.
    // Fragment rules run through the engine against that view — they cannot
    // name the proposed value (that is operations territory).
    const ctx = {
      db,
      principal,
      e: o.e,
      memo: pop === "create" ? createMemo : memo,
      ...(pop === "create" ? { overlay: overlay as RefOverlay } : {}),
    };
    if (!(await allowsOp(policy, pop, ident, ctx))) return deny(ident, pop);
  }

  // Preset injection, after evaluation and exempt from it.
  const created = new Map<number, string[]>();
  for (const o of x.ops) {
    if (o.kind !== "add" || !x.newEntities.has(o.e)) continue;
    const list = created.get(o.e);
    if (list) list.push(o.attr.ident);
    else created.set(o.e, [o.attr.ident]);
  }
  if (created.size === 0) return { ok: true, ops };

  const tempidOf = new Map<number, string>();
  for (const [tid, eid] of Object.entries(x.tempids)) {
    if (!created.has(eid)) continue;
    const prev = tempidOf.get(eid);
    const generated = tid.startsWith(GENERATED_TEMPID_PREFIX);
    if (prev === undefined || (prev.startsWith(GENERATED_TEMPID_PREFIX) && !generated)) tempidOf.set(eid, tid);
  }
  const news: NewEntity[] = [...created].map(([e, attrs]) => ({ ref: tempidOf.get(e) ?? e, attrs }));
  const injected = presetOps(policy, principal, news);
  if (!injected.ok) return injected;
  return { ok: true, ops: injected.ops.length === 0 ? ops : [...ops, ...injected.ops] };
}
