/** The filtered `Db`: drops datoms at the raw-access points (`datoms` / `seekMany` / `first`); `estimate` stays unfiltered. */

import type { Datom, IndexId, Prefix } from "../datom.ts";
import { Db, type DbOptions } from "../db.ts";
import type { CompiledPolicy } from "./ast.ts";
import {
  PolicyMemo,
  allowsMembershipRead,
  allowsOp,
  isMembershipAttrId,
  isSystemAttrId,
} from "./eval.ts";
import { type Principal, isSuperuser } from "./principal.ts";

export interface PolicyView {
  readonly policy: CompiledPolicy;
  readonly principal: Principal;
  /** always the *current* unfiltered db, whatever the data view's asOf/history */
  readonly ruleDb: Db;
  readonly memo: PolicyMemo;
}

function optionsOf(db: Db): DbOptions {
  return {
    store: db.store,
    roots: db.roots,
    novelty: db.novelty,
    basisT: db.basisT,
    schema: db.schema,
    nextEid: db.nextEid,
    asOfT: db.asOfT,
    history: db.isHistory,
  };
}

export class FilteredDb extends Db {
  readonly view: PolicyView;

  constructor(o: DbOptions, view: PolicyView) {
    super(o);
    this.view = view;
  }

  override asOf(t: number): Db {
    return new FilteredDb({ ...optionsOf(this), asOfT: t }, this.view);
  }
  override history(): Db {
    return new FilteredDb({ ...optionsOf(this), history: true }, this.view);
  }

  override datoms(index: IndexId, prefix: Prefix): AsyncGenerator<Datom[], void, undefined> {
    return this.sieve(super.datoms(index, prefix));
  }

  override async seekMany(index: IndexId, prefixes: readonly Prefix[]): Promise<Datom[][]> {
    const res = await super.seekMany(index, prefixes);
    for (let i = 0; i < res.length; i++) res[i] = await this.keep(res[i]);
    return res;
  }

  override async first(index: IndexId, prefix: Prefix): Promise<Datom | undefined> {
    for await (const arr of this.datoms(index, prefix)) if (arr.length > 0) return arr[0];
    return undefined;
  }

  /**
   * Is `[e a …]` readable? Bootstrap `:db/*` datoms always are.
   * Named-rule membership is a set lookup once `PolicyMemo` has materialized
   * the request-scoped visible set. Query pushdown may skip the namespace
   * check when that rule is already in the plan; `allowsOp` remains the
   * enforcement backstop for pull, history, raw access, and attr narrowing.
   */
  async visible(d: Datom): Promise<boolean> {
    const ctx = {
      db: this.view.ruleDb,
      principal: this.view.principal,
      e: d.e,
      memo: this.view.memo,
    };
    if (isMembershipAttrId(d.a)) {
      return allowsMembershipRead(this.view.policy, d, ctx);
    }
    if (isSystemAttrId(d.a)) return true;
    const attr = this.view.ruleDb.attr(d.a) ?? this.schema.attr(d.a);
    if (!attr) return false;
    return allowsOp(this.view.policy, "read", attr.ident, ctx);
  }

  private async keep(ds: Datom[]): Promise<Datom[]> {
    const out: Datom[] = [];
    for (const d of ds) if (await this.visible(d)) out.push(d);
    return out;
  }

  /** Never yields an empty chunk: callers treat the first chunk as non-empty. */
  private async *sieve(src: AsyncGenerator<Datom[], void, undefined>): AsyncGenerator<Datom[], void, undefined> {
    for await (const arr of src) {
      const kept = await this.keep(arr);
      if (kept.length > 0) yield kept;
    }
  }
}

/**
 * A read-filtered view of `db`. `ruleDb` is the unfiltered db at the *current*
 * basis: an as-of or history data view is still judged by current grants, so a
 * retracted grant cannot re-grant through history.
 */
export function filterDb(
  db: Db,
  ruleDb: Db,
  policy: CompiledPolicy,
  principal: Principal,
  opts?: { readonly maxCells?: number; readonly visibleSetMax?: number },
): Db {
  if (isSuperuser(principal, policy)) return db;
  const rules = ruleDb instanceof FilteredDb ? ruleDb.view.ruleDb : ruleDb;
  const view: PolicyView = {
    policy,
    principal,
    ruleDb: rules,
    memo: new PolicyMemo({ maxCells: opts?.maxCells, visibleSetMax: opts?.visibleSetMax }),
  };
  return new FilteredDb(optionsOf(db), view);
}

/** The policy view behind a filtered db (undefined for an unfiltered one). */
export function policyView(db: Db): PolicyView | undefined {
  return db instanceof FilteredDb ? db.view : undefined;
}
