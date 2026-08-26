/**
 * Semantic IR validation. Shared by compile output and stored documents.
 * Schema decode is not enough — metadata, ids, and catalog keys are
 * recomputed here and must match.
 */

import { analyze, exceedsTraversal, exprShapeError } from "./analyze.ts";
import { canonicalJson, ruleIdOf } from "./canonical.ts";
import { InvalidIR } from "./errors.ts";
import type {
  InstalledAuthorizationIR,
  IrDecision,
  IrIdentities,
  IrRule,
  PolicyTemplateIR,
} from "./ir.ts";

export type ValidatableIR = PolicyTemplateIR | InstalledAuthorizationIR;

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  canonicalJson([...left].sort()) === canonicalJson([...right].sort());

const recomputeRule = (rule: IrRule): IrRule => {
  const analysis = analyze(rule.expr);
  return {
    id: ruleIdOf(rule.focus, rule.expr),
    focus: rule.focus,
    expr: rule.expr,
    usesResource: analysis.usesResource,
    usesMe: analysis.usesMe,
    usesInput: analysis.usesInput,
    claims: [...analysis.claimKeys].sort(),
    classes: [...analysis.classNames].sort(),
    exists: analysis.exists.map((entity) => ({ entity })).sort((a, b) => a.entity.localeCompare(b.entity)),
  };
};

const identitySets = (identities: IrIdentities) => ({
  entities: new Set(identities.entities.map((e) => e.ns)),
  traits: new Set(identities.traits.map((t) => t.ns)),
  fields: new Set(identities.fields.map((f) => f.ident)),
  operations: new Set(identities.operations.map((o) => o.name)),
});

const checkDecisionKeys = (
  map: { readonly [key: string]: IrDecision },
  known: ReadonlySet<string>,
  where: string,
): void => {
  for (const key of Object.keys(map)) {
    if (!known.has(key)) {
      throw new InvalidIR({ reason: `${where} names unknown identity ${JSON.stringify(key)}` });
    }
  }
};

const checkRuleIds = (ir: ValidatableIR): ReadonlyMap<string, IrRule> => {
  const byId = new Map<string, IrRule>();
  for (const rule of ir.rules) {
    const shape = exprShapeError(rule.expr, `rule ${rule.id}`);
    if (shape !== undefined) throw new InvalidIR({ reason: shape });
    const analysis = analyze(rule.expr);
    if (exceedsTraversal(analysis)) {
      throw new InvalidIR({ reason: `rule ${rule.id}: traversal depth ${analysis.maxDepth} exceeds the limit` });
    }
    const expected = recomputeRule(rule);
    if (rule.id !== expected.id) {
      throw new InvalidIR({ reason: `rule ${rule.id}: id does not match canonical SHA-256 of focus+expr` });
    }
    if (
      rule.usesResource !== expected.usesResource ||
      rule.usesMe !== expected.usesMe ||
      rule.usesInput !== expected.usesInput ||
      !sameStrings(rule.claims, expected.claims) ||
      !sameStrings(rule.classes, expected.classes) ||
      canonicalJson(rule.exists) !== canonicalJson(expected.exists)
    ) {
      throw new InvalidIR({ reason: `rule ${rule.id}: recomputed metadata does not match` });
    }
    const previous = byId.get(rule.id);
    if (previous !== undefined && canonicalJson(previous.expr) !== canonicalJson(rule.expr)) {
      throw new InvalidIR({ reason: `rule id ${rule.id} maps to two different bodies` });
    }
    byId.set(rule.id, rule);
  }
  if (byId.size !== ir.rules.length) {
    throw new InvalidIR({ reason: "duplicate rule id" });
  }
  return byId;
};

const checkDecisions = (ir: ValidatableIR, rules: ReadonlyMap<string, IrRule>): void => {
  const ids = identitySets(ir.identities);
  checkDecisionKeys(ir.rows, ids.entities, "rows");
  checkDecisionKeys(ir.traits, ids.traits, "traits");
  checkDecisionKeys(ir.fields, ids.fields, "fields");
  checkDecisionKeys(ir.operations, ids.operations, "operations");

  const mentioned = [
    ...Object.entries(ir.rows),
    ...Object.entries(ir.traits),
    ...Object.entries(ir.fields),
    ...Object.entries(ir.operations),
  ];
  for (const [key, decision] of mentioned) {
    for (const id of [...decision.allow, ...decision.deny]) {
      if (!rules.has(id)) {
        throw new InvalidIR({ reason: `decision ${key} names unknown rule ${JSON.stringify(id)}` });
      }
    }
  }

  const opsByName = new Map(ir.identities.operations.map((op) => [op.name, op]));
  for (const [name, decision] of Object.entries(ir.operations)) {
    const op = opsByName.get(name);
    if (op === undefined) continue;
    if (op.target === "none") {
      for (const id of [...decision.allow, ...decision.deny]) {
        const rule = rules.get(id);
        if (rule?.usesResource === true) {
          throw new InvalidIR({
            reason: `operation ${name} has target "none" but rule ${id} uses the resource`,
          });
        }
      }
    }
  }
};

const checkPrincipal = (ir: ValidatableIR): void => {
  if (ir.principal.subjectClaim !== "sub") {
    throw new InvalidIR({ reason: "principal.subjectClaim must be sub" });
  }
  const usesMe = ir.rules.some((rule) => rule.usesMe);
  if (usesMe && (ir.principal.ident === undefined || ir.principal.entity === undefined)) {
    throw new InvalidIR({ reason: "rules that use me require principal.ident and principal.entity" });
  }
  if (ir.principal.entity !== undefined) {
    if (!ir.identities.entities.some((e) => e.ns === ir.principal.entity)) {
      throw new InvalidIR({ reason: `principal entity ${ir.principal.entity} is not in identities` });
    }
  }
  if (new Set(ir.classes).size !== ir.classes.length) {
    throw new InvalidIR({ reason: "duplicate class" });
  }
};

/** Throw {@link InvalidIR} if the document is semantically inconsistent. */
export const validateSemantics = (ir: ValidatableIR): void => {
  checkPrincipal(ir);
  const rules = checkRuleIds(ir);
  checkDecisions(ir, rules);
};

export const recomputeRuleMetadata = recomputeRule;
