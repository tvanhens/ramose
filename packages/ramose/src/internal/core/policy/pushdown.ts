/**
 * Clause-level policy pushdown. A namespace read rule is conjoined onto each
 * entity var that touches that namespace, *before* planning, so visibility
 * rides the same indexes as the caller. Injected clauses are stamped
 * `origin: "rule"` and bind against the unfiltered rule db; caller clauses
 * stay on the filtered view. Conjunction is always in `:where` — never in
 * `:having` — so a count cannot include a row the caller could not see.
 *
 * FilteredDb remains the enforcement backstop for pull, history, raw datom
 * access, attr-level narrowing, and anything this rewrite does not cover.
 */

import { type CompiledPolicy, isRuleArm, nsPrefix } from "./ast.ts";
import { RAMOSE_TRAIT_IDENT, RAMOSE_TYPE_IDENT } from "../schema.ts";
import { type Principal, holdsClass } from "./principal.ts";
import type { Db } from "../db.ts";
import {
  type Clause,
  type PatternClause,
  type Query,
  type RuleCallClause,
  type RuleDef,
  type Term,
} from "../query/ast.ts";
import { parseQuery } from "../query/parse.ts";

/** Hygienic principal binding. Fresh-named if the caller already uses it. */
export const POLICY_ME_VAR = "?__ramose_me";

/**
 * The slice of a policy view pushdown needs. Structural so the query engine
 * can import this module without importing FilteredDb (eval → engine cycle).
 */
export interface PushdownView {
  readonly policy: CompiledPolicy;
  readonly principal: Principal;
  readonly ruleDb: Db;
  readonly memo: {
    enterPushdown(namespaces: readonly string[]): void;
    exitPushdown(namespaces: readonly string[]): void;
    skipsNsBackstop(ns: string | undefined): boolean;
  };
}

export interface PushdownResult {
  readonly query: Query;
  /** Bound to {@link Principal.eid} when a named rule was conjoined. */
  readonly meVar?: string;
  readonly meValue?: unknown;
  /**
   * Namespaces whose read rule was conjoined onto every top-level entity var
   * in that namespace. The executor may skip the ns-level FilteredDb check
   * for these during this query (attr-level narrowing still runs).
   */
  readonly covered: readonly string[];
}

/** Conjoin per-var namespace read rules. v1 / admin / `true` arms are a no-op. */
export function conjoinPolicy(ast: Query, view: PushdownView): PushdownResult {
  const { policy, principal, ruleDb } = view;
  if (policy.version !== 2) return { query: ast, covered: [] };

  const policyRules = parsePolicyRules(policy.rules);
  const allRules = policyRules.concat(ast.rules ?? []);
  const nsByVar = new Map<string, Set<string>>();
  const topEntity = new Set<string>();
  let variableAttr = false;
  collectPatterns(
    ast.where,
    ruleDb,
    nsByVar,
    topEntity,
    () => {
      variableAttr = true;
    },
    true,
    allRules,
    new Set(),
  );

  if (nsByVar.size === 0) return { query: ast, covered: [] };
  const used = allVars(ast);
  const meVar = freshVar(POLICY_ME_VAR, used);
  const injected: Clause[] = [];
  const conjoined = new Map<string, Set<string>>();

  for (const [varName, nss] of nsByVar) {
    if (!topEntity.has(varName)) continue;
    for (const ns of nss) {
      const clause = nsConjunction(
        policy,
        principal,
        ns,
        meVar,
        varName,
        ast.where,
        policyRules,
        ruleDb,
      );
      if (clause === "skip") continue;
      if (clause === "deny") {
        injected.push(neverClause());
        add(conjoined, ns, varName);
        continue;
      }
      injected.push(clause);
      add(conjoined, ns, varName);
    }
  }

  if (injected.length === 0) return { query: ast, covered: [] };

  const policyNames = new Set(policyRules.map((r) => r.name));
  const rules = policyRules.concat((ast.rules ?? []).filter((r) => !policyNames.has(r.name)));
  const covered: string[] = [];
  if (!variableAttr) {
    for (const [ns, vars] of conjoined) {
      let all = true;
      for (const [v, nss] of nsByVar) {
        if (nss.has(ns) && topEntity.has(v) && !vars.has(v)) {
          all = false;
          break;
        }
      }
      if (all) covered.push(ns);
    }
  }

  const needsMe = injected.some((c) => usesMe(c, meVar));
  return {
    query: {
      ...ast,
      where: ast.where.concat(injected),
      rules: rules.length > 0 ? rules : ast.rules,
    },
    ...(needsMe && principal.eid !== undefined ? { meVar, meValue: principal.eid } : {}),
    covered,
  };
}

export function parsePolicyRules(rules: readonly unknown[] | undefined): RuleDef[] {
  if (rules === undefined || rules.length === 0) return [];
  return parseQuery({ find: ["?e"], where: [], rules }).rules ?? [];
}

// ---------------------------------------------------------------------------

function nsConjunction(
  policy: CompiledPolicy,
  principal: Principal,
  ns: string,
  meVar: string,
  eVar: string,
  where: Clause[],
  policyRules: RuleDef[],
  db: Db,
): Clause | "skip" | "deny" {
  const arms = policy.ns?.[ns]?.read;
  if (!arms || arms.length === 0) {
    // Trait prefixes are not policy keys; FilteredDb remaps them to the
    // entity type. Same skip when the prefix only appears as an attr rule.
    if (db.schema.isTraitIdent(`:${ns}`)) return "skip";
    const attrs = policy.attrs ?? {};
    for (const ident of Object.keys(attrs)) {
      if (nsPrefix(ident) === ns && (attrs[ident]?.read?.length ?? 0) > 0) {
        return "skip";
      }
    }
    return "deny";
  }
  // v1 expression / deny arms: leave this namespace to FilteredDb
  if (arms.some((a) => !isRuleArm(a))) return "skip";

  const names: string[] = [];
  for (const arm of arms) {
    if (!isRuleArm(arm)) continue;
    if (arm.class !== undefined && !arm.class.some((c) => holdsClass(principal, c))) continue;
    if (arm.rule === true) return "skip";
    names.push(arm.rule);
  }
  if (names.length === 0) return "deny";
  if (principal.eid === undefined) return "deny";

  const remaining = names.filter(
    (name) => !ruleCallEntailed(where, name, eVar) && !patternEntailed(where, name, meVar, eVar, policyRules),
  );
  if (remaining.length === 0) return "skip";
  if (remaining.length === 1) return ruleCall(remaining[0], meVar, eVar);
  return { kind: "or", origin: "rule", branches: remaining.map((n) => [ruleCall(n, meVar, eVar)]) };
}

function ruleCall(name: string, meVar: string, eVar: string): RuleCallClause {
  return {
    kind: "rule-call",
    name,
    args: [
      { kind: "var", name: meVar },
      { kind: "var", name: eVar },
    ],
    origin: "rule",
  };
}

function neverClause(): Clause {
  return {
    kind: "pred",
    fn: "=",
    args: [
      { kind: "const", value: 0 },
      { kind: "const", value: 1 },
    ],
    origin: "rule",
  };
}

function ruleCallEntailed(where: Clause[], name: string, eVar: string): boolean {
  const walk = (c: Clause): boolean => {
    if (
      c.kind === "rule-call" &&
      c.name === name &&
      c.args[1]?.kind === "var" &&
      c.args[1].name === eVar
    ) {
      return true;
    }
    if (c.kind === "or") return c.branches.some((b) => b.some(walk));
    if (c.kind === "not") return c.clauses.some(walk);
    return false;
  };
  return where.some(walk);
}

/** A single-pattern rule is entailed when that pattern is already in `:where`. */
function patternEntailed(
  where: Clause[],
  name: string,
  meVar: string,
  eVar: string,
  rules: RuleDef[],
): boolean {
  const bodies = rules.filter((r) => r.name === name);
  if (bodies.length === 0) return false;
  return bodies.every((d) => {
    if (d.clauses.length !== 1 || d.clauses[0].kind !== "pattern") return false;
    return whereHasPattern(where, d.clauses[0], d.args, meVar, eVar);
  });
}

function whereHasPattern(
  where: Clause[],
  pat: PatternClause,
  args: string[],
  meVar: string,
  eVar: string,
): boolean {
  const rename = (n: string): Term => {
    if (n === args[0]) return { kind: "var", name: meVar };
    if (n === args[1]) return { kind: "var", name: eVar };
    return { kind: "var", name: n };
  };
  return where.some((c) => c.kind === "pattern" && samePattern(c, pat, rename));
}

function samePattern(have: PatternClause, want: PatternClause, rename: (n: string) => Term): boolean {
  const eq = (a: Term, b: Term): boolean => {
    const br = b.kind === "var" ? rename(b.name) : b;
    if (a.kind !== br.kind) return false;
    if (a.kind === "var" && br.kind === "var") return a.name === br.name;
    if (a.kind === "const" && br.kind === "const") return a.value === br.value;
    return a.kind === "blank";
  };
  return eq(have.e, want.e) && eq(have.a, want.a) && eq(have.v, want.v);
}

function composerNs(ident: string): string | undefined {
  if (ident[0] !== ":" || ident.includes("/")) return undefined;
  return ident.slice(1);
}

function substTerm(t: Term, map: ReadonlyMap<string, Term>): Term {
  return t.kind === "var" && map.has(t.name) ? map.get(t.name)! : t;
}

function substClause(c: Clause, map: ReadonlyMap<string, Term>): Clause {
  switch (c.kind) {
    case "pattern":
      return {
        ...c,
        e: substTerm(c.e, map),
        a: substTerm(c.a, map),
        v: substTerm(c.v, map),
        ...(c.tx !== undefined ? { tx: substTerm(c.tx, map) } : {}),
        ...(c.op !== undefined ? { op: substTerm(c.op, map) } : {}),
      };
    case "not":
      return { ...c, clauses: c.clauses.map((x) => substClause(x, map)) };
    case "or":
      return { ...c, branches: c.branches.map((b) => b.map((x) => substClause(x, map))) };
    case "rule-call":
    case "pred":
    case "fn":
      return { ...c, args: c.args.map((a) => substTerm(a, map)) };
  }
}

function recordPatternNs(
  c: PatternClause,
  db: Db,
  nsByVar: Map<string, Set<string>>,
  onVarAttr: () => void,
): void {
  if (c.e.kind !== "var") return;
  const ident = identOf(c.a, db);
  if (ident === RAMOSE_TYPE_IDENT) {
    if (c.v.kind === "const" && typeof c.v.value === "string") {
      const ns = composerNs(c.v.value);
      if (ns) add(nsByVar, c.e.name, ns);
    } else {
      onVarAttr();
    }
    return;
  }
  if (ident === RAMOSE_TRAIT_IDENT) {
    onVarAttr();
    return;
  }
  const ns = ident === undefined ? undefined : nsPrefix(ident);
  if (ns && !db.schema.isTraitIdent(`:${ns}`)) add(nsByVar, c.e.name, ns);
}

function collectPatterns(
  clauses: Clause[],
  db: Db,
  nsByVar: Map<string, Set<string>>,
  topEntity: Set<string>,
  onVarAttr: () => void,
  top: boolean,
  rules: readonly RuleDef[],
  expanding: Set<string>,
): void {
  for (const c of clauses) {
    switch (c.kind) {
      case "pattern": {
        if (c.e.kind === "var") {
          if (top) topEntity.add(c.e.name);
          if (c.a.kind === "var" || c.a.kind === "blank") onVarAttr();
          else recordPatternNs(c, db, nsByVar, onVarAttr);
        }
        break;
      }
      case "rule-call": {
        if (top) {
          const focus = [...c.args].reverse().find((a) => a.kind === "var");
          if (focus?.kind === "var") topEntity.add(focus.name);
        }
        if (expanding.has(c.name)) break;
        expanding.add(c.name);
        for (const def of rules) {
          if (def.name !== c.name) continue;
          const map = new Map<string, Term>();
          for (let i = 0; i < def.args.length && i < c.args.length; i++) {
            map.set(def.args[i]!, c.args[i]!);
          }
          collectPatterns(
            def.clauses.map((x) => substClause(x, map)),
            db,
            nsByVar,
            topEntity,
            onVarAttr,
            false,
            rules,
            expanding,
          );
        }
        expanding.delete(c.name);
        break;
      }
      case "not":
        collectPatterns(c.clauses, db, nsByVar, topEntity, onVarAttr, false, rules, expanding);
        break;
      case "or":
        for (const b of c.branches) {
          collectPatterns(b, db, nsByVar, topEntity, onVarAttr, false, rules, expanding);
        }
        break;
      default:
        break;
    }
  }
}

function identOf(a: Term, db: Db): string | undefined {
  if (a.kind !== "const") return undefined;
  if (typeof a.value === "string") return a.value;
  if (typeof a.value === "number") return db.attr(a.value)?.ident;
  return undefined;
}

function allVars(ast: Query): Set<string> {
  const into = new Set<string>();
  const addTerm = (t: Term | undefined) => {
    if (t?.kind === "var") into.add(t.name);
  };
  const walk = (c: Clause) => {
    switch (c.kind) {
      case "pattern":
        addTerm(c.e);
        addTerm(c.a);
        addTerm(c.v);
        addTerm(c.tx);
        addTerm(c.op);
        break;
      case "pred":
      case "rule-call":
        c.args.forEach(addTerm);
        break;
      case "fn":
        c.args.forEach(addTerm);
        break;
      case "not":
        c.clauses.forEach(walk);
        break;
      case "or":
        c.branches.forEach((b) => b.forEach(walk));
        break;
    }
  };
  ast.where.forEach(walk);
  for (const spec of ast.in) {
    if (spec.kind === "scalar") into.add(spec.var);
    else if (spec.kind === "coll") into.add(spec.var);
    else if (spec.kind === "tuple" || spec.kind === "rel") {
      for (const v of spec.vars) if (v) into.add(v);
    }
  }
  return into;
}

function freshVar(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

function usesMe(c: Clause, meVar: string): boolean {
  const walk = (x: Clause): boolean => {
    switch (x.kind) {
      case "rule-call":
      case "pred":
        return x.args.some((a) => a.kind === "var" && a.name === meVar);
      case "fn":
        return x.args.some((a) => a.kind === "var" && a.name === meVar);
      case "pattern":
        return [x.e, x.a, x.v, x.tx, x.op].some((t) => t?.kind === "var" && t.name === meVar);
      case "not":
        return x.clauses.some(walk);
      case "or":
        return x.branches.some((b) => b.some(walk));
    }
  };
  return walk(c);
}

function add(m: Map<string, Set<string>>, k: string, v: string): void {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  s.add(v);
}
