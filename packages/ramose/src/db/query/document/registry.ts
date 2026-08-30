/**
 * The function-registry seam.
 *
 * `QueryDocumentV1` owns the *structure* of expressions; it owns no
 * functions. Every `{ call }` node resolves through a
 * {@link FunctionRegistryV1}: an explicit allowlist mapping a public
 * namespaced name to a typed signature (for validation, budgets, and
 * capability cards) and a lowering hook (for compilation). The v1 standard
 * library (#507) is one implementation of this interface; nothing in this
 * module defines, imports, or assumes any particular function.
 *
 * A hook lowers into the engine's own vocabulary — kernel commands from
 * `Q` — so a function is not a second evaluator. Two hook flavours:
 *
 * - `predicate` — constrains the current row and binds nothing. It reaches
 *   `where` only, and a `boolean` parameter of a predicate accepts a
 *   nested predicate, which is how `and` / `or` / `not` compose without a
 *   wire-level boolean operator.
 * - `scalar` — computes one value and answers the operand naming it, so
 *   later bindings, filters, projections, and sort keys can reuse it.
 */

import type { AnyVar, QueryGen } from "../kernel.ts";
import type { PathCarrier } from "../../shapes.ts";
import type { ExpressionContextV1, ValueTypeV1 } from "./types.ts";

/** A resolved field reference: the attribute, plus what the compiler knows. */
export interface FieldRefV1 {
  readonly attr: PathCarrier & {
    readonly valueType?: string | undefined;
    readonly cardinality?: string | undefined;
  };
  /** The public field key the document wrote. */
  readonly key: string;
  readonly type: ValueTypeV1;
  readonly many: boolean;
  readonly optional: boolean;
}

/**
 * One already-compiled argument. A `field` operand is deliberately *not*
 * pre-bound: a hook that can express itself as one pattern clause
 * (`[?e :issue/status "open"]`) lowers to exactly the clause the fluent
 * builder emits, instead of binding a value var and comparing it. Hooks
 * that need a value call `api.bind`.
 */
export type OperandV1 =
  | { readonly kind: "constant"; readonly value: unknown }
  | { readonly kind: "bound"; readonly v: AnyVar }
  | {
      readonly kind: "field";
      /** The entity var the field hangs off — the root focus, or the last
       * intermediate var of a multi-hop path. */
      readonly focus: AnyVar;
      readonly field: FieldRefV1;
    }
  /** A nested predicate, passed for a `boolean` parameter of a predicate. */
  | { readonly kind: "predicate"; readonly emit: () => QueryGen<void> };

/** What a lowering hook may ask the compiler for. */
export interface LoweringApiV1 {
  /** The query's root entity var. */
  readonly focus: AnyVar;
  /**
   * Force an operand to a bound kernel var, emitting whatever clauses bind
   * it. A `predicate` operand cannot be bound — that is a signature error
   * the registry rejects before lowering.
   */
  readonly bind: (operand: OperandV1) => QueryGen<AnyVar>;
  /** A fresh unconstrained var for a function's own result. */
  readonly freshVar: () => AnyVar;
}

export type PredicateLoweringV1 = (
  api: LoweringApiV1,
  args: readonly OperandV1[],
) => QueryGen<void>;

export type ScalarLoweringV1 = (
  api: LoweringApiV1,
  args: readonly OperandV1[],
) => QueryGen<OperandV1>;

export type FunctionLoweringV1 =
  | { readonly kind: "predicate"; readonly emit: PredicateLoweringV1 }
  | { readonly kind: "scalar"; readonly emit: ScalarLoweringV1 };

export interface FunctionParameterV1 {
  readonly name: string;
  readonly type: ValueTypeV1;
  /** A trailing rest parameter accepts one or more further arguments. */
  readonly rest?: boolean;
}

/**
 * Everything validation, budgets, and capability cards need about one
 * public function. `deterministic` is `true` by construction: a document
 * has no clock, no randomness, and no ambient I/O, so a nondeterministic
 * function has no legal home here.
 */
export interface FunctionSignatureV1 {
  readonly params: readonly FunctionParameterV1[];
  readonly result: ValueTypeV1;
  readonly contexts: readonly ExpressionContextV1[];
  readonly deterministic: true;
  /** Weight charged once per occurrence, per candidate row. */
  readonly cost: number;
  readonly doc?: string;
  readonly examples?: readonly string[];
}

export interface FunctionDefinitionV1 {
  /** The public namespaced name a document writes, e.g. `logic.eq`. */
  readonly name: string;
  readonly signature: FunctionSignatureV1;
  readonly lower: FunctionLoweringV1;
}

/**
 * The allowlist a compile resolves `{ call }` names through. `lookup`
 * answers `undefined` for a name that does not exist *and* for a name the
 * caller may not see — the compiler cannot tell the two apart, which is
 * what keeps the metadata seal a property of this seam.
 */
export interface FunctionRegistryV1 {
  /** The standard-library version this registry publishes. */
  readonly version: number;
  readonly lookup: (name: string) => FunctionDefinitionV1 | undefined;
  /** Every visible definition, for capability projection. Stable order. */
  readonly list: () => readonly FunctionDefinitionV1[];
}

const NAME = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

/**
 * Build a registry from definitions, rejecting the shapes the compiler
 * would otherwise have to defend against at lowering time.
 */
export const makeFunctionRegistry = (
  version: number,
  definitions: readonly FunctionDefinitionV1[],
): FunctionRegistryV1 => {
  const byName = new Map<string, FunctionDefinitionV1>();
  for (const def of definitions) {
    if (!NAME.test(def.name)) {
      throw new Error(
        `ramose/query: a public query function is namespaced (\`text.lower\`), got "${def.name}"`,
      );
    }
    if (byName.has(def.name)) {
      throw new Error(`ramose/query: two definitions named "${def.name}" reached one registry`);
    }
    const { signature, lower } = def;
    if (signature.contexts.length === 0) {
      throw new Error(`ramose/query: "${def.name}" declares no expression context`);
    }
    if (!Number.isFinite(signature.cost) || signature.cost < 0) {
      throw new Error(`ramose/query: "${def.name}" needs a non-negative cost weight`);
    }
    signature.params.forEach((p, i) => {
      if (p.rest === true && i !== signature.params.length - 1) {
        throw new Error(`ramose/query: "${def.name}" puts a rest parameter before its last`);
      }
    });
    if (lower.kind === "predicate") {
      if (signature.result !== "boolean") {
        throw new Error(`ramose/query: predicate "${def.name}" must declare a boolean result`);
      }
      if (signature.contexts.some((c) => c !== "where")) {
        throw new Error(
          `ramose/query: predicate "${def.name}" constrains a row and binds no value — its only context is "where"`,
        );
      }
    }
    byName.set(def.name, def);
  }
  const ordered = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    version,
    lookup: (name) => byName.get(name),
    list: () => ordered,
  };
};

/** A registry with no functions — structural documents still compile. */
export const EMPTY_FUNCTION_REGISTRY: FunctionRegistryV1 = makeFunctionRegistry(0, []);
