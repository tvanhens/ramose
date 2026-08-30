/**
 * Lowering: a resolved document becomes the engine's own authoritative
 * query value.
 *
 * There is no second engine here. The output is an ordinary
 * `QueryObject` over the same pipeline the fluent builder produces —
 * `entities(root)` for membership, one filter fragment carrying the
 * document's bindings and filter, a pull `select` shape for the
 * projection, and the query-level order / limit / offset / cursor the
 * fluent chain also sets. Everything downstream (`lowerQueryObject`, the
 * wire AST, `db.query`) is untouched and unaware a document was involved.
 *
 * A projection that names a derived value cannot ride a pull shape alone,
 * so those queries take the generator spelling and merge the derived cells
 * onto the same pull with `Q.row` — again, an existing kernel primitive.
 */

import { entities, select as selectStage, stage } from "../lib.ts";
import { Q, type AnyVar, type CellRecord, type QueryGen } from "../kernel.ts";
import {
  makeQueryObject,
  type AnyQueryObject,
  type Pipeline,
  type QueryOrder,
} from "../query.ts";
import { decodeCursor } from "../cursor.ts";
import { cardsOf, pathOf, revsOf, type PathCarrier, type Shape } from "../../shapes.ts";
import type { AnyComposer } from "../../Composer.ts";
import type { QueryCatalogV1 } from "./catalog.ts";
import type { LoweringApiV1, OperandV1 } from "./registry.ts";
import type {
  FieldStepV1,
  ResolvedExprV1,
  ResolvedQueryDocumentV1,
  ResolvedSelectionV1,
} from "./validate.ts";

/** Raised only for engine-level refusals; `compile.ts` seals the message. */
export class LoweringFailure extends Error {
  readonly reason: "cursor" | "engine";
  constructor(reason: "cursor" | "engine", message: string) {
    super(message);
    this.reason = reason;
  }
}

// ── shapes ──────────────────────────────────────────────────────────────────

type Nav = PathCarrier & {
  readonly optional: unknown;
  readonly select: (shape: Shape) => { readonly optional: unknown };
};

/** A reference leaf with no nested projection reads as the `{ id }` cell —
 * the same cell the default full-entity row carries. */
const referenceCell = (attr: Nav, target: AnyComposer, many: boolean): unknown => {
  const nested = attr.select({ id: target.id } as unknown as Shape);
  return many ? nested : nested.optional;
};

const leafCell = (step: FieldStepV1, target: AnyComposer | undefined): unknown => {
  const attr = step.field.attr as unknown as Nav;
  if (step.field.type === "ref" && step.field.key !== "id" && target !== undefined) {
    return referenceCell(attr, target, step.field.many);
  }
  if (step.field.many) return attr;
  return step.field.optional ? attr.optional : attr;
};

const shapeOf = (
  selections: readonly ResolvedSelectionV1[],
  catalog: QueryCatalogV1,
): Shape => {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === "nested") {
      const attr = sel.step.field.attr as unknown as Nav;
      const nested = attr.select(shapeOf(sel.select, catalog));
      out[sel.key] = sel.step.field.many ? nested : nested.optional;
      continue;
    }
    if (sel.expr.kind !== "field") continue;
    const step = sel.expr.steps[sel.expr.steps.length - 1]!;
    out[sel.key] = leafCell(step, catalog.target(step.owner, step.field));
  }
  return out as Shape;
};

/**
 * The full-entity row a select-less document projects — the same shape
 * `entityShape` builds for the fluent chain, except that it enumerates the
 * *catalog's* visible fields rather than the composer's raw field map.
 *
 * That difference is the visibility seal: a filtered catalog that hides a
 * field must hide it from the compiled pull, not merely from the derived
 * result shape. Building the default row from the composer would send the
 * hidden cell to the peer.
 *
 * Card-one fields are `.optional` here exactly as `entityShape` makes them
 * — a missing datom must not drop the row.
 */
const defaultShapeOf = (root: AnyComposer, catalog: QueryCatalogV1): Shape => {
  const out: Record<string, unknown> = {};
  const id = catalog.field(root, "id");
  if (id !== undefined) out["id"] = id.attr;
  for (const key of Object.keys(root.fields as Record<string, unknown>)) {
    const field = catalog.field(root, key);
    if (field === undefined) continue;
    const attr = field.attr as unknown as Nav;
    if (field.type === "ref") {
      // An untargeted or invisible target still projects the `{ id }` cell;
      // the nested shape reads `:db/id` and nothing of the target.
      const nested = attr.select({ id: (catalog.target(root, field) ?? root).id } as unknown as Shape);
      out[key] = field.many ? nested : nested.optional;
    } else {
      out[key] = field.many ? attr : attr.optional;
    }
  }
  return out as Shape;
};

// ── expressions ─────────────────────────────────────────────────────────────

interface Env {
  vars: Map<string, OperandV1>;
  orderVars: Map<string, AnyVar>;
}

const makeApi = (focus: AnyVar): LoweringApiV1 => {
  const api: LoweringApiV1 = {
    focus,
    freshVar: () => Q.var(),
    bind: function* (operand: OperandV1): QueryGen<AnyVar> {
      switch (operand.kind) {
        case "bound":
          return operand.v;
        case "field": {
          const handle = yield* Q.fact(operand.focus, operand.field.attr);
          return handle.v as AnyVar;
        }
        case "constant": {
          const v = Q.var();
          yield* Q.in(v, [operand.value]);
          return v;
        }
        case "predicate":
          throw new LoweringFailure("engine", "a filter has no value to bind");
      }
    },
  };
  return api;
};

/** Walk a resolved field path, binding every intermediate reference hop. */
function* fieldOperand(expr: ResolvedExprV1 & { kind: "field" }, api: LoweringApiV1): QueryGen<OperandV1> {
  let focus = api.focus;
  for (let i = 0; i < expr.steps.length - 1; i++) {
    const handle = yield* Q.fact(focus, expr.steps[i]!.field.attr);
    focus = handle.v as AnyVar;
  }
  return { kind: "field", focus, field: expr.steps[expr.steps.length - 1]!.field };
}

function* operandOf(expr: ResolvedExprV1, api: LoweringApiV1, env: Env): QueryGen<OperandV1> {
  switch (expr.kind) {
    case "constant":
      return { kind: "constant", value: expr.value };
    case "var": {
      const operand = env.vars.get(expr.name);
      if (operand === undefined) {
        throw new LoweringFailure("engine", "a binding was used before it was bound");
      }
      return operand;
    }
    case "field":
      return yield* fieldOperand(expr, api);
    case "call": {
      if (expr.predicate || expr.def.lower.kind !== "scalar") {
        throw new LoweringFailure("engine", "a filter has no value to bind");
      }
      const args: OperandV1[] = [];
      for (const arg of expr.args) args.push(yield* operandOf(arg, api, env));
      return yield* expr.def.lower.emit(api, args);
    }
  }
}

function* emitPredicate(expr: ResolvedExprV1, api: LoweringApiV1, env: Env): QueryGen<void> {
  if (expr.kind === "call" && expr.predicate && expr.def.lower.kind === "predicate") {
    const params = expr.def.signature.params;
    const rest = params.length > 0 && params[params.length - 1]!.rest === true;
    const fixed = rest ? params.length - 1 : params.length;
    const args: OperandV1[] = [];
    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i]!;
      const param = i < fixed ? params[i]! : params[params.length - 1]!;
      if (param.type === "boolean") {
        // Every boolean parameter of a predicate is a *filter position*, so
        // it always arrives as the thunk `OperandV1` promises — a nested
        // call, a boolean field, or a bound boolean alike. `and` / `or` /
        // `not` then decide where those clauses land.
        args.push({ kind: "predicate", emit: () => emitPredicate(arg, api, env) });
      } else {
        args.push(yield* operandOf(arg, api, env));
      }
    }
    yield* expr.def.lower.emit(api, args);
    return;
  }
  // A bare boolean field or binding used as the whole filter.
  const operand = yield* operandOf(expr, api, env);
  if (operand.kind === "field") {
    yield* Q.fact(operand.focus, operand.field.attr, true as never);
    return;
  }
  const v = yield* api.bind(operand);
  yield* Q.in(v, [true]);
}

/** Bindings, then the filter, then the vars an order key or a derived
 * column needs — one deterministic clause order per document. */
function* emitBody(
  resolved: ResolvedQueryDocumentV1,
  focus: AnyVar,
  env: Env,
  derived: readonly ResolvedSelectionV1[],
  cells: Record<string, AnyVar>,
): QueryGen<void> {
  const api = makeApi(focus);
  env.vars = new Map();
  env.orderVars = new Map();
  for (const binding of resolved.bindings) {
    env.vars.set(binding.name, yield* operandOf(binding.expr, api, env));
  }
  if (resolved.where !== null) yield* emitPredicate(resolved.where, api, env);
  for (const sel of derived) {
    if (sel.kind !== "expr") continue;
    cells[sel.key] = yield* api.bind(yield* operandOf(sel.expr, api, env));
  }
  for (const order of resolved.orderBy) {
    if (order.key.kind !== "var" || env.orderVars.has(order.key.name)) continue;
    const operand = env.vars.get(order.key.name);
    if (operand === undefined) {
      throw new LoweringFailure("engine", "a sort key names no binding");
    }
    env.orderVars.set(order.key.name, yield* api.bind(operand));
  }
}

// ── order keys ──────────────────────────────────────────────────────────────

/** A multi-hop sort key is one carrier spanning every hop — the same value
 * `orderBy(Issue.owner.name)` produces on the fluent chain. */
const orderCarrier = (steps: readonly FieldStepV1[]): PathCarrier => {
  const leaf = steps[steps.length - 1]!.field.attr;
  if (steps.length === 1) return leaf;
  return {
    ident: leaf.ident,
    cardinality: leaf.cardinality,
    valueType: (leaf as { readonly valueType?: string }).valueType,
    __path: steps.flatMap((s) => [...pathOf(s.field.attr)]),
    __cards: steps.flatMap((s) => [...cardsOf(s.field.attr)]),
    __revs: steps.flatMap((s) => [...revsOf(s.field.attr)]),
  } as PathCarrier;
};

// ── the entry point ─────────────────────────────────────────────────────────

/**
 * Compile a resolved document into the authoritative query value.
 *
 * @internal `compile.ts` is the public door.
 */
export const lowerResolvedDocument = (
  resolved: ResolvedQueryDocumentV1,
  catalog: QueryCatalogV1,
): AnyQueryObject => {
  const env: Env = { vars: new Map(), orderVars: new Map() };
  const selections = resolved.select;
  const derived =
    selections === null
      ? []
      : selections.filter((s) => s.kind === "expr" && s.expr.kind !== "field");
  const fieldShape =
    selections === null ? defaultShapeOf(resolved.root, catalog) : shapeOf(selections, catalog);
  if (Object.keys(fieldShape).length === 0) {
    // Validation already refuses a derived-only projection; a root whose
    // every field is hidden lands here too, and must not compile into a
    // focus-less row.
    throw new LoweringFailure("engine", "this projection has no visible column");
  }

  const body = (): unknown => {
    if (derived.length === 0) {
      const withFilter = stage(function* (focus: AnyVar) {
        yield* emitBody(resolved, focus, env, [], {});
      })(entities(resolved.root) as never) as unknown as Pipeline;
      return selectStage(fieldShape)(withFilter as never) as unknown as Pipeline;
    }
    return (function* () {
      const focus = (yield* entities(resolved.root)) as unknown as AnyVar;
      const cells: Record<string, AnyVar> = {};
      yield* emitBody(resolved, focus, env, derived, cells);
      // The base pull keeps the root focus on the row, which is what lets
      // an ordered document carry a keyset cursor and keeps two entities
      // that derive the same value two rows.
      return Q.row(Q.pull(focus as never, fieldShape as never), cells as CellRecord);
    })();
  };

  const orders: QueryOrder[] = resolved.orderBy.map((order) => ({
    key:
      order.key.kind === "field"
        ? orderCarrier(order.key.steps)
        : (() => env.orderVars.get((order.key as { readonly name: string }).name)),
    dir: order.direction,
    empty: order.empty,
  }));

  const take = resolved.cardinality === "one" ? ("one" as const) : undefined;
  const base = makeQueryObject(
    body,
    false,
    take,
    undefined,
    orders,
    resolved.page.first ?? undefined,
    resolved.page.offset ?? undefined,
  ) as AnyQueryObject;
  if (!isCursorPaged(resolved)) return base;
  try {
    const seek =
      resolved.page.after === null ? null : decodeCursor(base, resolved.page.after);
    return base.after(seek);
  } catch {
    throw new LoweringFailure("cursor", "this cursor does not continue this query");
  }
};

/**
 * Whether the compiled query answers a cursor page rather than a bare
 * array. Keyset paging needs a total order, so an unordered document is
 * not paged; `offset` opts out (a cursor already is the offset).
 */
export const isCursorPaged = (resolved: ResolvedQueryDocumentV1): boolean =>
  resolved.cardinality === "many" &&
  resolved.orderBy.length > 0 &&
  resolved.page.offset === null;
