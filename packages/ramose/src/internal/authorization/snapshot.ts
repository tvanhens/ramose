/**
 * Completeness-aware rule snapshot. The pure evaluator never sees a bag
 * where both "absent" and "not loaded" are `undefined`.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { IncompleteRuleSnapshot } from "./errors.ts";
import type { IrDecision, IrRule } from "./ir.ts";

export type LoadedValue =
  | { readonly _tag: "Value"; readonly value: unknown }
  | { readonly _tag: "Absent" };

export interface ProjectedRecord {
  readonly id: number;
  readonly type: string;
  readonly traits: readonly string[];
  readonly attrs: Readonly<Record<string, LoadedValue>>;
}

/**
 * A projection the evaluator may consume. Every requested path is
 * `Value` or `Absent`. Missing segments fail at `project()`, not here.
 */
export interface CompleteRuleProjection {
  readonly subject: string;
  readonly me?: number;
  readonly classes: readonly string[];
  readonly claims: Readonly<Record<string, LoadedValue>>;
  readonly input: Readonly<Record<string, LoadedValue>>;
  /** False when the operation input bag itself was not loaded. */
  readonly inputLoaded: boolean;
  readonly resource?: ProjectedRecord;
  readonly entities: Readonly<Record<string, readonly ProjectedRecord[]>>;
}

export interface RuleAccessPlan {
  readonly needsMe: boolean;
  readonly needsResource: boolean;
  readonly needsInput: boolean;
  readonly claimKeys: readonly string[];
  readonly existsEntities: readonly string[];
}

export class RuleSnapshot extends Context.Service<
  RuleSnapshot,
  {
    readonly project: (
      plan: RuleAccessPlan,
    ) => Effect.Effect<CompleteRuleProjection, IncompleteRuleSnapshot>;
  }
>()("ramose/authorization/RuleSnapshot") {}

export const planOfRules = (rules: readonly IrRule[]): RuleAccessPlan => ({
  needsMe: rules.some((rule) => rule.usesMe),
  needsResource: rules.some((rule) => rule.usesResource),
  needsInput: rules.some((rule) => rule.usesInput),
  claimKeys: [...new Set(rules.flatMap((rule) => rule.claims))],
  existsEntities: [...new Set(rules.flatMap((rule) => rule.exists.map((e) => e.entity)))],
});

export const planOfDecision = (
  rulesById: ReadonlyMap<string, IrRule>,
  decision: IrDecision,
): RuleAccessPlan => {
  const rules: IrRule[] = [];
  for (const id of [...decision.allow, ...decision.deny]) {
    const rule = rulesById.get(id);
    if (rule !== undefined) rules.push(rule);
  }
  return planOfRules(rules);
};

/** In-memory test layer: supplied records are a complete projection. */
export const memoryRuleSnapshot = (projection: CompleteRuleProjection): RuleSnapshot["Service"] => ({
  project: (plan) =>
    Effect.gen(function* () {
      if (plan.needsMe && projection.me === undefined) {
        return yield* Effect.fail(
          new IncompleteRuleSnapshot({ reason: "principal row is not loaded" }),
        );
      }
      if (plan.needsResource && projection.resource === undefined) {
        return yield* Effect.fail(
          new IncompleteRuleSnapshot({ reason: "resource row is not loaded" }),
        );
      }
      if (plan.needsInput && !projection.inputLoaded) {
        return yield* Effect.fail(
          new IncompleteRuleSnapshot({ reason: "operation input is not loaded" }),
        );
      }
      for (const entity of plan.existsEntities) {
        if (projection.entities[entity] === undefined) {
          return yield* Effect.fail(
            new IncompleteRuleSnapshot({
              reason: `exists(${entity}) segment is not loaded`,
            }),
          );
        }
      }
      return projection;
    }),
});

export const MemoryRuleSnapshot = {
  layer: (projection: CompleteRuleProjection) =>
    Layer.succeed(RuleSnapshot, memoryRuleSnapshot(projection)),
};
