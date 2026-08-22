/**
 * Nested pull filters: kernel fragments, translated to the pull AST.
 *
 * A `.where(…)` on a cardinality-many collection takes the same filter
 * fragments the pipe uses (`is`, `has`, `Q.not`, a `where(attr, pred)`, any
 * userland combinator built from the kernel). The fragment runs against a
 * synthetic *element* var, and the recorded clauses — both sides inert data —
 * compile into the engine's per-element predicate tree ({@link PullElemPred}):
 * facts chain into paths (or `some` hops when an element carries several
 * constraints), `Q.not` maps to `not`, `Q.or` to `or`, and a comparison on
 * the element itself lowers with an empty path (which is how a card-many
 * scalar's values filter: the fragment is handed the value var directly).
 *
 * What cannot translate is rejected, never approximated: a pull-phase filter
 * runs per element after the row set is fixed, so it cannot correlate with
 * the enclosing query's vars, join two chains on a shared var, call an
 * engine rule, read time positions, or gate on `Q.when`.
 */

import type {
  PullElemCmp,
  PullElemOp,
  PullElemPred,
} from "../../internal/core/query/ast.ts";
import { isParam } from "../Params.ts";
import { refTargetNs } from "../Pull.ts";
import {
  collectBody,
  isBlank,
  isVar,
  mkVar,
  type AnyVar,
  type BClause,
  type EidCell,
  type FactCommand,
  type Position,
  type SubBody,
} from "./kernel.ts";

/** One `.where` argument: a fragment over the element (an entity var for a
 * ref collection, the value var itself for a card-many scalar). */
export type ElemFilterFragment = (focus: AnyVar) => Iterable<unknown>;

const err = (msg: string): never => {
  throw new Error(`ramose/query: ${msg}`);
};

/** Kernel comparison op → pull `:where` op, when the element is the first
 * (subject) operand. */
const OPS: Partial<Record<string, PullElemOp>> = {
  "=": "=",
  "not=": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "starts-with?": "starts-with?",
  "ends-with?": "ends-with?",
  "includes?": "includes?",
  in: "in",
};

/** The same op with the element on the *right* — only order comparisons flip. */
const FLIPPED: Partial<Record<string, PullElemOp>> = {
  "=": "=",
  "not=": "!=",
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
};

const unwrapEidLike = (v: unknown): unknown =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { id?: unknown }).id === "number" &&
  Object.keys(v).length === 1
    ? (v as { id: number }).id
    : v;

const regexSource = (re: RegExp | string): string => {
  if (typeof re === "string") return re;
  if (re.flags !== "") {
    err(
      `matches(/${re.source}/${re.flags}) — the peer compiles the pattern with no flags; express it in the pattern instead`,
    );
  }
  return re.source;
};

/** A comparison operand as an elem-pred `value`: eids unwrap, params ride
 * through verbatim (substituted at query lowering, rejected by `db.pull`). */
const lowerValue = (v: unknown): unknown => (isParam(v) ? v : unwrapEidLike(v));

const isCmpPred = (p: PullElemPred): p is PullElemCmp =>
  typeof (p as PullElemCmp).op === "string" && Array.isArray((p as PullElemCmp).path);

const andOf = (preds: readonly PullElemPred[]): PullElemPred =>
  preds.length === 1 ? preds[0]! : { and: [...preds] };

const isRefAttr = (attr: unknown): boolean =>
  typeof attr === "object" &&
  attr !== null &&
  (attr as { valueType?: unknown }).valueType === ":db.type/ref";

/** Every var a clause list mentions, groups included. */
const collectVarIds = (list: readonly BClause[], into: Set<number>): void => {
  for (const c of list) {
    switch (c._tag) {
      case "fact": {
        const e = c.eVar ?? c.e0;
        if (isVar(e)) into.add(e.id);
        const v = c.vVar ?? c.v0;
        if (isVar(v)) into.add(v.id);
        if (c.txVar) into.add(c.txVar.id);
        if (c.opVar) into.add(c.opVar.id);
        break;
      }
      case "cmp":
        for (const a of c.args) if (isVar(a)) into.add(a.id);
        break;
      case "memberOf":
        into.add(c.v.id);
        break;
      case "ruleCall":
        for (const a of c.args) if (isVar(a)) into.add(a.id);
        into.add(c.ret.id);
        break;
      case "orGroup":
        c.branches.forEach((b) => collectVarIds(b, into));
        break;
      case "notGroup":
      case "whenGroup":
        collectVarIds(c.clauses, into);
        break;
    }
  }
};

/** Does this clause mention `v` in a position the translator can root on? */
const mentions = (c: BClause, v: AnyVar): boolean => {
  const one = new Set<number>();
  collectVarIds([c], one);
  return one.has(v.id);
};

/**
 * Lower `.where(…)` fragments into the pull AST's per-element predicates.
 * `attr` is the collection hop the filter attaches to: a ref (or backlink)
 * hands the fragments an element *entity* var; a card-many scalar hands
 * them the value var itself, so comparisons lower with an empty path.
 */
export const lowerElemFilter = (
  preds: readonly ElemFilterFragment[],
  attr: { readonly ident: string },
): PullElemPred[] => {
  const elem: AnyVar = isRefAttr(attr)
    ? mkVar<EidCell>("entity", refTargetNs(attr))
    : mkVar("value");

  const clauses: BClause[] = [];
  for (const p of preds) {
    if (typeof p !== "function") {
      err(
        `.where(...) on ${attr.ident} takes filter fragments — is(...), has(...), a (v) => comparison, or any fragment built from the kernel`,
      );
    }
    clauses.push(...collectBody(p(elem) as SubBody));
  }

  // A pull-phase filter runs per element, after the row set is fixed: a var
  // minted before the element var belongs to the enclosing build and cannot
  // correlate here.
  const seen = new Set<number>();
  collectVarIds(clauses, seen);
  for (const id of seen) {
    if (id < elem.id) {
      err(
        `.where(...) on ${attr.ident} closes over a var from the enclosing query — a pull-phase filter runs per element after the rows are fixed, so it cannot correlate with the outer query; constrain the rows in the query itself, or compare against a literal or param`,
      );
    }
  }

  const used = new Set<BClause>();
  /** Vars already reached as an element — a second fact binding one would be
   * a join, which a tree of paths cannot say. */
  const bound = new Set<number>([elem.id]);

  const predsOn = (v: AnyVar, list: readonly BClause[]): PullElemPred[] => {
    const out: PullElemPred[] = [];
    for (const c of list) {
      if (used.has(c) || !mentions(c, v)) continue;
      used.add(c);
      out.push(oneClause(c, v, list));
    }
    return out;
  };

  /** Translate a whole sub-list (an or-branch, a not body) relative to `v`;
   * every clause must be consumed — a leftover neither constrains the
   * element nor chains from it. */
  const predsOfList = (list: readonly BClause[], v: AnyVar): PullElemPred[] => {
    const out = predsOn(v, list);
    const leftover = list.find((c) => !used.has(c));
    if (leftover !== undefined) rejectClause(leftover);
    return out;
  };

  const rejectClause = (c: BClause): never => {
    switch (c._tag) {
      case "memberOf":
        return err(
          `entities(...) does not lower to a pull filter on ${attr.ident} — the collection already scopes its elements; constrain them with clauses on the element`,
        );
      case "ruleCall":
        return err(
          `a named rule does not lower to a pull filter on ${attr.ident} — the pull phase has no rule engine; inline the fragment instead`,
        );
      case "whenGroup":
        return err(
          `Q.when(...) does not lower to a pull filter on ${attr.ident} — a nested filter is lowered when the shape is built, before params bind; filter unconditionally, or fork the shape`,
        );
      default:
        return err(
          `a clause in .where(...) on ${attr.ident} neither constrains the element nor chains from it — a pull-phase filter walks paths from each element; it cannot join two chains on a shared var or correlate with other clauses`,
        );
    }
  };

  /** One hop from `v` through `ident` to `target`: recurse into the
   * target's own constraints and fold them onto the hop. */
  const hopPred = (
    ident: string,
    reverse: boolean,
    target: AnyVar,
    list: readonly BClause[],
  ): PullElemPred => {
    if (bound.has(target.id)) {
      err(
        `.where(...) on ${attr.ident} reaches one var by two facts — a pull-phase filter walks a tree of paths and cannot join them; chain from a single binding instead`,
      );
    }
    bound.add(target.id);
    const inner = predsOn(target, list);
    if (inner.length === 0) {
      return exists(ident, reverse);
    }
    if (inner.length === 1 && isCmpPred(inner[0]!)) {
      const p = inner[0]!;
      const revs = [reverse, ...(p.reverse ?? p.path.map(() => false))];
      return {
        path: [ident, ...p.path],
        ...(revs.some(Boolean) ? { reverse: revs } : {}),
        op: p.op,
        ...("value" in p ? { value: p.value } : {}),
      };
    }
    return {
      some: {
        path: [ident],
        ...(reverse ? { reverse: [true] } : {}),
        pred: andOf(inner),
      },
    };
  };

  const exists = (ident: string, reverse: boolean): PullElemCmp => ({
    path: [ident],
    ...(reverse ? { reverse: [true] } : {}),
    op: "exists",
  });

  const factPred = (c: FactCommand<unknown>, v: AnyVar, list: readonly BClause[]): PullElemPred => {
    if (c.attr === undefined) {
      err(
        `.where(...) on ${attr.ident} uses an attribute-free fact — a pull filter walks named attributes from each element`,
      );
    }
    if (c.txVar !== undefined || c.opVar !== undefined) {
      err(
        `.where(...) on ${attr.ident} reads a time position (f.t / f.tx / f.op) — the pull phase reads the present; ask time questions in the query itself`,
      );
    }
    const ident = c.attr!.ident;
    const e: Position | undefined = c.eVar ?? c.e0;
    const val: Position | undefined = c.vVar ?? c.v0;
    if (isVar(e) && e.id === v.id) {
      // forward hop: [elem ident val]
      if (isVar(val)) return hopPred(ident, false, val, list);
      if (val === undefined || isBlank(val)) return exists(ident, false);
      return { path: [ident], op: "=", value: lowerValue(val) };
    }
    if (isVar(val) && val.id === v.id) {
      // reverse hop: [e ident elem] — who points at the element
      if (!isRefAttr(c.attr)) {
        err(
          `.where(...) on ${attr.ident} walks ${ident} backwards — only a reference can be read from its target`,
        );
      }
      if (isVar(e)) return hopPred(ident, true, e, list);
      if (e === undefined || isBlank(e)) return exists(ident, true);
      return {
        path: [ident, ":db/id"],
        reverse: [true, false],
        op: "=",
        value: lowerValue(e),
      };
    }
    return err(
      `.where(...) on ${attr.ident}: a fact mentions the element only through a position the pull phase cannot walk`,
    );
  };

  const cmpPred = (op: string, args: readonly Position[], v: AnyVar): PullElemPred => {
    const other = args.find((a) => !(isVar(a) && a.id === v.id));
    if (isVar(other)) {
      err(
        `.where(...) on ${attr.ident} compares two bound values — a pull-phase filter compares each reached value against a constant or param`,
      );
    }
    if (op === "re-find?") {
      // kernel spelling is matches(v, re): pattern first on the wire
      const [pattern, subject] = args;
      if (!(isVar(subject) && subject.id === v.id)) {
        err(
          `.where(...) on ${attr.ident}: matches(...) must test the element's value — the pattern cannot be the bound side`,
        );
      }
      return {
        path: [],
        op: "re-find?",
        value: isParam(pattern) ? pattern : regexSource(pattern as RegExp | string),
      };
    }
    const first = args[0];
    const subjectFirst = isVar(first) && first.id === v.id;
    if (op === "in") {
      if (!subjectFirst) {
        err(`.where(...) on ${attr.ident}: Q.in's first argument is the element's value`);
      }
      const values = args[1];
      return {
        path: [],
        op: "in",
        value: isParam(values)
          ? values
          : Array.isArray(values)
            ? values.map(unwrapEidLike)
            : err(`Q.in takes an array of values, got ${String(values)}`),
      };
    }
    const mapped = subjectFirst ? OPS[op] : FLIPPED[op];
    if (mapped === undefined) {
      err(
        subjectFirst
          ? `.where(...) on ${attr.ident}: the comparison "${op}" does not lower to a pull filter`
          : `.where(...) on ${attr.ident}: "${op}" must test the element's value — write the element as the first operand`,
      );
    }
    return { path: [], op: mapped!, value: lowerValue(other) };
  };

  const oneClause = (c: BClause, v: AnyVar, list: readonly BClause[]): PullElemPred => {
    switch (c._tag) {
      case "fact":
        return factPred(c, v, list);
      case "cmp":
        return cmpPred(c.op, c.args, v);
      case "orGroup":
        return { or: c.branches.map((b) => andOf(predsOfList(b, v))) };
      case "notGroup":
        return { not: andOf(predsOfList(c.clauses, v)) };
      case "memberOf":
      case "ruleCall":
      case "whenGroup":
        return rejectClause(c);
    }
  };

  return predsOfList(clauses, elem);
};
