/**
 * One Effectful fail-closed boundary around the pure evaluator.
 * Typed failures and defects may be logged differently internally;
 * none produce application output.
 */

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { AuthorizationDenied, IncompleteRuleSnapshot, type AuthorizationFailure } from "./errors.ts";
import { evaluatePure, exprNodeCount, traitOwnerOfField } from "./eval.ts";
import type { InstalledAuthorizationIR, IrDecision } from "./ir.ts";
import { AuthorizationLease, AuthorizationBudget, UnboundedLease, UnlimitedBudget } from "./services.ts";
import {
  MemoryRuleSnapshot,
  RuleSnapshot,
  planOfDecision,
  type CompleteRuleProjection,
  type LoadedValue,
  type ProjectedRecord,
} from "./snapshot.ts";

export interface RuleRecord {
  readonly id: number;
  readonly type: string;
  readonly traits?: readonly string[];
  readonly attrs: Readonly<Record<string, unknown>>;
}

export interface EvalCtx {
  readonly subject?: string;
  readonly me?: number;
  readonly classes: readonly string[];
  readonly claims: Readonly<Record<string, unknown>>;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly resource?: RuleRecord;
  readonly entities: Readonly<Record<string, readonly RuleRecord[]>>;
}

const asLoaded = (value: unknown): LoadedValue =>
  value === undefined ? { _tag: "Absent" } : { _tag: "Value", value };

const projectRecord = (row: RuleRecord): ProjectedRecord => ({
  id: row.id,
  type: row.type,
  traits: row.traits ?? [],
  attrs: Object.fromEntries(Object.entries(row.attrs).map(([key, value]) => [key, asLoaded(value)])),
});

export const projectionFromEvalCtx = (ctx: EvalCtx): CompleteRuleProjection => ({
  subject: ctx.subject ?? (typeof ctx.claims.sub === "string" ? ctx.claims.sub : "test"),
  me: ctx.me,
  classes: ctx.classes,
  claims: Object.fromEntries(Object.entries(ctx.claims).map(([key, value]) => [key, asLoaded(value)])),
  input: Object.fromEntries(Object.entries(ctx.input ?? {}).map(([key, value]) => [key, asLoaded(value)])),
  inputLoaded: ctx.input !== undefined,
  resource: ctx.resource === undefined ? undefined : projectRecord(ctx.resource),
  entities: Object.fromEntries(
    Object.entries(ctx.entities).map(([key, rows]) => [key, rows.map(projectRecord)]),
  ),
});

const rulesById = (ir: InstalledAuthorizationIR) => {
  const map = new Map<string, InstalledAuthorizationIR["rules"][number]>();
  for (const rule of ir.rules) map.set(rule.id, rule);
  return map;
};

const budgetOf = (ir: InstalledAuthorizationIR, decision: IrDecision): number => {
  const rules = rulesById(ir);
  let cost = 1;
  for (const id of [...decision.allow, ...decision.deny]) {
    const rule = rules.get(id);
    if (rule !== undefined) cost += exprNodeCount(rule.expr);
  }
  return cost;
};

/**
 * Effect transaction: lease, budget, complete projection, then pure
 * evaluation. Only `True` succeeds. Incomplete becomes a typed failure.
 */
export const authorize = (
  ir: InstalledAuthorizationIR,
  decision: IrDecision | undefined,
): Effect.Effect<true, AuthorizationFailure, RuleSnapshot | AuthorizationBudget | AuthorizationLease> =>
  Effect.gen(function* () {
    const lease = yield* AuthorizationLease;
    yield* lease.assertValid;
    if (decision === undefined) {
      return yield* Effect.fail(new AuthorizationDenied({ reason: "missing decision" }));
    }
    const budget = yield* AuthorizationBudget;
    yield* budget.consume(budgetOf(ir, decision));
    const snapshot = yield* RuleSnapshot;
    const plan = planOfDecision(rulesById(ir), decision);
    const projection = yield* snapshot.project(plan);
    const truth = evaluatePure(ir, projection, decision);
    if (truth._tag === "True") return true as const;
    if (truth._tag === "Incomplete") {
      return yield* Effect.fail(new IncompleteRuleSnapshot({ reason: truth.reason }));
    }
    return yield* Effect.fail(new AuthorizationDenied({ reason: "authorization denied" }));
  });

const failClosed = (
  effect: Effect.Effect<true, AuthorizationFailure, RuleSnapshot | AuthorizationBudget | AuthorizationLease>,
  projection: CompleteRuleProjection,
): boolean => {
  const provided = effect.pipe(
    Effect.provide(MemoryRuleSnapshot.layer(projection)),
    Effect.provide(UnlimitedBudget),
    Effect.provide(UnboundedLease),
  );
  const exit = Effect.runSyncExit(provided);
  return Exit.isSuccess(exit);
};

/** Evaluate one decision. The single sync fail-closed boundary for tests. */
export const decide = (
  ir: InstalledAuthorizationIR,
  decision: IrDecision | undefined,
  ctx: EvalCtx,
): boolean => failClosed(authorize(ir, decision), projectionFromEvalCtx(ctx));

export const authorizeRow = (ir: InstalledAuthorizationIR, entityNs: string, ctx: EvalCtx): boolean =>
  decide(ir, ir.rows[entityNs], ctx);

export const authorizeTraitField = (
  ir: InstalledAuthorizationIR,
  args: { readonly entity: string; readonly trait: string },
  ctx: EvalCtx,
): boolean => {
  if (!authorizeRow(ir, args.entity, ctx)) return false;
  if (ir.traits[args.trait] === undefined) return false;
  return decide(ir, ir.traits[args.trait], ctx);
};

export const authorizeField = (
  ir: InstalledAuthorizationIR,
  args: { readonly entity: string; readonly fieldIdent: string; readonly trait?: string },
  ctx: EvalCtx,
): boolean => {
  const trait = traitOwnerOfField(ir, args.fieldIdent);
  if (trait !== undefined) {
    if (!authorizeTraitField(ir, { entity: args.entity, trait }, ctx)) return false;
  } else if (!authorizeRow(ir, args.entity, ctx)) {
    return false;
  }
  const extra = ir.fields[args.fieldIdent];
  if (extra === undefined) return ir.identities.fields.some((field) => field.ident === args.fieldIdent);
  return decide(ir, extra, ctx);
};

export const authorizeOperation = (ir: InstalledAuthorizationIR, name: string, ctx: EvalCtx): boolean =>
  decide(ir, ir.operations[name], ctx);
