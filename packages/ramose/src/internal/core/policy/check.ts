/**
 * Raw `/transact` under a configured policy: schema stays
 * `schemaClasses`-gated, data is superuser-only. Per-datom write arms
 * are gone — named operations are the write surface.
 */

import type { TxData } from "../tx.ts";
import type { Db } from "../db.ts";
import type { Schema } from "../schema.ts";
import { type CompiledPolicy } from "./ast.ts";
import { type Principal, canChangeSchema, isSuperuser } from "./principal.ts";

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
 * Every op is a map-form `ensure`: a `:db/ident` plus only `:db/*`
 * scalars. Extra app keys, nested maps, reverse refs, and `:db/id`
 * (which would aim the install at an existing entity) are not schema.
 * Empty `tx` is not schema (nothing to ensure).
 */
const isSchemaRetract = (op: unknown): boolean => {
  if (!Array.isArray(op) || op.length !== 4) return false;
  if (op[0] !== ":db/retract") return false;
  const attr = op[2];
  if (attr !== ":ramose/refTarget" && attr !== ":db/optional") return false;
  if (attr === ":ramose/refTarget" && typeof op[3] !== "string") return false;
  if (attr === ":db/optional" && op[3] !== true) return false;
  const subject = op[1];
  if (typeof subject === "number" && Number.isFinite(subject)) return true;
  return (
    Array.isArray(subject) &&
    subject.length === 2 &&
    subject[0] === ":db/ident" &&
    typeof subject[1] === "string"
  );
};

export function isSchemaTx(tx: unknown): tx is readonly Record<string, unknown>[] {
  if (!Array.isArray(tx) || tx.length === 0) return false;
  for (const op of tx) {
    if (isSchemaRetract(op)) continue;
    if (typeof op !== "object" || op === null || Array.isArray(op)) return false;
    const m = op as Record<string, unknown>;
    if (typeof m[":db/ident"] !== "string") return false;
    if (m[":db/id"] !== undefined) return false;
    for (const [k, v] of Object.entries(m)) {
      const schemaKey =
        k.startsWith(":db/") ||
        k === ":ramose/kind" ||
        k === ":ramose/composes" ||
        k === ":ramose/refTarget";
      if (!schemaKey) return false;
      const t = typeof v;
      if (t !== "string" && t !== "number" && t !== "boolean") return false;
    }
  }
  return true;
}

/**
 * Authoritative raw-transact check. Superuser may write data; schema
 * txs require `schemaClasses`. Everyone else is denied. Operation-
 * originated txs never reach this function.
 */
export async function checkTx(
  txData: TxData,
  _db: Db,
  policy: CompiledPolicy,
  principal: Principal,
  _schema?: Schema,
): Promise<CheckTxResult> {
  const ops = txData as unknown[];
  if (isSuperuser(principal, policy)) return { ok: true, ops };
  if (isSchemaTx(txData) && canChangeSchema(principal, policy)) return { ok: true, ops };
  return deny(":db/tx", "transact");
}
