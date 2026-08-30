/**
 * The three experimental MCP kernel tools, executed against one already
 * authorized graph target (#484 S1).
 *
 * Everything here reads the *same* filtered `Db` and sealed catalog unit the
 * data plane uses at execution time (#419/#421/#423): discovery is a
 * projection of execution, never a second authority. Consequently:
 *
 * - `describe` lists an entity only when the caller can currently observe a
 *   row of it, an operation only when {@link operationGrantAllows} — the exact
 *   gate the Transactor applies — admits this principal, and a child graph
 *   only when the filtered `Db` shows its `:graph/name` row.
 * - `query` never distinguishes an unknown definition from a hidden one. An
 *   entity, field, or filter it cannot resolve against the catalog yields the
 *   same empty result a policy-hidden one does.
 * - `mutate` lowers onto the existing #487 claim/execute/complete/replay path.
 *   It mints no version, digest, or receipt of its own.
 */

import type {
  FieldDescriptor,
  OperationInputShape,
} from "../internal/authorization/catalog.ts";
import type {
  CanonicalAuthorizationExpr,
  CanonicalValueTerm,
} from "../internal/authorization/expr.ts";
import { fieldKey } from "../internal/authorization/validation/common.ts";
import type { AuthenticatedCaller, AuthorizedRequestContext } from "../internal/authorization/request.ts";
import {
  operationGrantAllows,
  principalValuesEqual,
  projectPrincipalTerm,
} from "../internal/authorization/operation-grant.ts";
import type { AuthoritativeInvocationResult } from "../internal/authorization/invocation-receipts.ts";
import { runOneShotRead } from "../internal/authorization/reads.ts";
import { Index, ValueTag } from "../internal/core/datom.ts";
import { toJson } from "../internal/core/json.ts";
import { RAMOSE_TYPE_IDENT } from "../internal/core/schema.ts";
import {
  DEFAULT_QUERY_LIMIT,
  MAX_DESCRIBE_ITEMS,
  encodeOperationVersionToken,
  toolFailure,
  type ErrorEnvelopeV1,
  type QueryDocumentV1,
} from "./contract.ts";

const GRAPH_TRAIT_IDENT = ":graph";
const GRAPH_NAME_IDENT = ":graph/name";

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------

export type DescribeResultV1 = {
  readonly at: readonly string[];
  readonly entities: readonly string[];
  readonly operations: readonly {
    readonly owner: { readonly kind: "entity" | "trait"; readonly name: string };
    readonly name: string;
    readonly version: string;
  }[];
  readonly graphs: readonly string[];
  readonly truncated: boolean;
};

const visibleGraphNames = async (
  context: AuthorizedRequestContext,
  limit: number,
): Promise<{ names: string[]; truncated: boolean }> => {
  const attribute = context.currentDb.attr(GRAPH_NAME_IDENT);
  const composition = context.filteredDb.composition;
  if (attribute === undefined || composition === undefined) {
    return { names: [], truncated: false };
  }
  const found = new Set<string>();
  let truncated = false;
  outer: for await (
    const chunk of context.filteredDb.datoms(Index.AEVT, { a: attribute.id })
  ) {
    for (const datom of chunk) {
      if (typeof datom.v !== "string") continue;
      // Establish that this row is a visible child graph before consulting
      // the cap: a row that is not one must never set `truncated`.
      const row = await context.filteredDb.entity(datom.e);
      const type = row?.[RAMOSE_TYPE_IDENT];
      if (typeof type !== "string" || !composition.isEntityIdent(type)) continue;
      if (!composition.transitiveTraits(type).includes(GRAPH_TRAIT_IDENT)) continue;
      if (found.has(datom.v)) continue;
      if (found.size >= limit) {
        truncated = true;
        break outer;
      }
      found.add(datom.v);
    }
  }
  return { names: [...found].sort(), truncated };
};

/** Names only — no cards, cursors, or tokens. Lists are capped, not paged. */
export const describeGraph = async (
  context: AuthorizedRequestContext,
  caller: AuthenticatedCaller,
  at: readonly string[],
): Promise<DescribeResultV1> => {
  const catalog = context.unit.catalog;
  const typeAttribute = context.currentDb.attr(RAMOSE_TYPE_IDENT);
  const entities: string[] = [];
  let truncated = false;
  // Visibility is decided *before* the cap in every listing below. Checking
  // the cap first would let a hidden item set `truncated`, and that flag
  // would then be the disclosure that the hidden item exists.
  for (const entity of catalog.entities) {
    if (typeAttribute === undefined) break;
    const row = await context.filteredDb.first(Index.AVET, {
      a: typeAttribute.id,
      vt: ValueTag.Str,
      v: `:${entity.id.name}`,
    });
    if (row === undefined) continue;
    if (entities.length >= MAX_DESCRIBE_ITEMS) {
      truncated = true;
      break;
    }
    entities.push(entity.id.name);
  }
  const operations: DescribeResultV1["operations"][number][] = [];
  for (const descriptor of catalog.operations) {
    if (
      !operationGrantAllows(
        context.unit,
        descriptor,
        caller,
        context.principal.subject,
      )
    ) continue;
    if (operations.length >= MAX_DESCRIBE_ITEMS) {
      truncated = true;
      break;
    }
    operations.push(Object.freeze({
      owner: Object.freeze({
        kind: descriptor.id.owner.kind,
        name: descriptor.id.owner.name,
      }),
      name: descriptor.id.localName,
      version: encodeOperationVersionToken(descriptor.version),
    }));
  }
  const graphs = await visibleGraphNames(context, MAX_DESCRIBE_ITEMS);
  return Object.freeze({
    at: Object.freeze([...at]),
    entities: Object.freeze(entities.sort()),
    operations: Object.freeze(operations),
    graphs: Object.freeze(graphs.names),
    truncated: truncated || graphs.truncated,
  });
};

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

export type QueryResultV1 = {
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
};

/** Trait names an entity composes, directly or transitively. */
const composedTraits = (
  catalog: AuthorizedRequestContext["unit"]["catalog"],
  entity: string,
): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const composition of catalog.traitComposition) {
    if (composition.composer.name !== entity) continue;
    names.add(composition.trait.name);
    for (const transitive of composition.transitive) names.add(transitive.name);
  }
  return names;
};

type ResolvedField = { readonly name: string; readonly ident: string };

/** Three-valued: `undefined` means the outcome depends on the row. */
type StaticTruth = boolean | undefined;

/**
 * Evaluate one read rule against the principal alone.
 *
 * The term and comparison semantics are the deployed operation-grant
 * evaluator's, imported rather than restated so the two readings of a rule
 * cannot drift. The only difference is arity: that evaluator is two-valued
 * and folds a row-relative term into `false`, which is right when assembly
 * has already proven the rule principal-only. Read rules carry no such
 * guarantee, so a row-relative term becomes `undefined` — "cannot say" — and
 * the filtered `Db` settles it later.
 *
 * Only a definite `false` is ever acted on, so an imprecise answer can
 * withhold a field but never expose one.
 */
const staticRuleTruth = (
  expr: CanonicalAuthorizationExpr,
  caller: AuthenticatedCaller,
  subject: string,
): StaticTruth => {
  const project = (term: CanonicalValueTerm) =>
    projectPrincipalTerm(term, caller, subject);
  switch (expr._tag) {
    case "const":
      return expr.value;
    case "hasClass":
      return caller.classes.includes(expr.class);
    case "and": {
      let unknown = false;
      for (const part of expr.exprs) {
        const truth = staticRuleTruth(part, caller, subject);
        if (truth === false) return false;
        if (truth === undefined) unknown = true;
      }
      return unknown ? undefined : true;
    }
    case "or": {
      let unknown = false;
      for (const part of expr.exprs) {
        const truth = staticRuleTruth(part, caller, subject);
        if (truth === true) return true;
        if (truth === undefined) unknown = true;
      }
      return unknown ? undefined : false;
    }
    case "not": {
      const truth = staticRuleTruth(expr.expr, caller, subject);
      return truth === undefined ? undefined : !truth;
    }
    case "eq": {
      // Mirrors the grant evaluator: both sides must be present to compare,
      // and an absent claim compares false rather than unknown.
      const left = project(expr.left);
      const right = project(expr.right);
      if (left._tag === "invalid" || right._tag === "invalid") return undefined;
      return left._tag === "present" && right._tag === "present" &&
        principalValuesEqual(left.value, right.value);
    }
    case "has": {
      const term = project(expr.term);
      return term._tag === "invalid" ? undefined : term._tag === "present";
    }
    case "in": {
      const value = project(expr.value);
      const collection = project(expr.collection);
      if (value._tag === "invalid" || collection._tag === "invalid") {
        return undefined;
      }
      return value._tag === "present" && collection._tag === "present" &&
        Array.isArray(collection.value) &&
        collection.value.some((item) => principalValuesEqual(value.value, item));
    }
  }
};

/**
 * Whether policy denies this field to this principal *whatever row it is on*.
 *
 * This is a conservative pre-filter, never an authorization decision: the
 * deployed read filter still decides every datom. Its only job is to keep a
 * field the caller can never read off the path a visible field takes, so a
 * hidden name cannot be told apart from an unknown one by which failure mode
 * it produces — a budgeted pull can fail, and the sealed empty answer cannot.
 *
 * It mirrors what the deployed filter does with a field decision: an explicit
 * deny wins, and at least one allow must pass. A field with *no* decision of
 * its own is governed entirely by its row — the filter returns readable there
 * — so it is never statically hidden. Anything row-dependent is likewise left
 * for the filtered `Db` to settle.
 */
const staticallyHidden = (
  context: AuthorizedRequestContext,
  caller: AuthenticatedCaller,
  field: FieldDescriptor,
): boolean => {
  const decision = context.unit.policy.decisions.fields.find(
    (entry) => fieldKey(entry.target) === fieldKey(field.id),
  )?.decision;
  if (decision === undefined) return false;
  const subject = context.principal.subject;
  const rules = new Map(context.unit.policy.rules.map((rule) => [rule.id, rule]));
  for (const id of decision.deny) {
    const rule = rules.get(id);
    if (rule === undefined) return true;
    if (staticRuleTruth(rule.expr, caller, subject) === true) return true;
  }
  for (const id of decision.allow) {
    const rule = rules.get(id);
    if (rule === undefined) continue;
    if (staticRuleTruth(rule.expr, caller, subject) !== false) return false;
  }
  return true;
};

/**
 * Public field names an entity exposes, mapped to their storage idents.
 *
 * Only scalar fields are projectable in this slice. A ref field's value is an
 * entity id, and S1 has no public entity reference to project one into, so
 * offering one would put a storage id on the wire; excluding the field keeps
 * it indistinguishable from any other name this catalog does not expose.
 *
 * Everything excluded here — ref-shaped, not installed, statically hidden —
 * leaves by the same door an unknown name does, so no selection can tell them
 * apart by the answer it gets.
 */
const scalarFieldsOf = (
  context: AuthorizedRequestContext,
  caller: AuthenticatedCaller,
  entity: string,
): ReadonlyMap<string, ResolvedField> => {
  const catalog = context.unit.catalog;
  const traits = composedTraits(catalog, entity);
  const fields = new Map<string, ResolvedField>();
  for (const field of catalog.fields) {
    if (field.valueType === "ref") continue;
    const owner = field.id.owner;
    const owned = owner.kind === "entity"
      ? owner.name === entity
      : traits.has(owner.name);
    if (!owned) continue;
    const ident = `:${owner.name}/${field.id.localName}`;
    // A catalog field whose attribute is not installed is not readable; it
    // collapses into the same "no such visible field" answer as a hidden one.
    if (context.currentDb.attr(ident) === undefined) continue;
    if (staticallyHidden(context, caller, field)) continue;
    fields.set(field.id.localName, Object.freeze({
      name: field.id.localName,
      ident,
    }));
  }
  return fields;
};

/**
 * Lower the minimal document onto an ordinary datalog query.
 *
 * Returns `undefined` when the document names something this catalog does not
 * expose. The caller answers that with an empty result — the same answer a
 * policy-hidden definition produces, which is what keeps hidden and absent
 * indistinguishable (#419).
 */
export const lowerQueryDocument = (
  context: AuthorizedRequestContext,
  caller: AuthenticatedCaller,
  document: QueryDocumentV1,
): {
  readonly query: Record<string, unknown>;
  readonly inputs: readonly unknown[];
  readonly fields: readonly ResolvedField[];
  readonly limit: number;
} | undefined => {
  const entity = context.unit.catalog.entities.find(
    (candidate) => candidate.id.name === document.from.entity,
  );
  if (entity === undefined) return undefined;
  const available = scalarFieldsOf(context, caller, entity.id.name);
  const selected = document.select === undefined
    ? [...available.values()]
    : document.select.flatMap((name) => {
      const field = available.get(name);
      return field === undefined ? [] : [field];
    });
  if (selected.length === 0) return undefined;

  // Every constant travels through `:in`, never inline in a pattern: a caller
  // string beginning with `?` must never be read as a query variable.
  const inputs: unknown[] = [`:${entity.id.name}`];
  const inSpec: string[] = ["$", "?type"];
  const where: unknown[][] = [["?e", RAMOSE_TYPE_IDENT, "?type"]];
  let index = 0;
  for (const [name, value] of Object.entries(document.where ?? {})) {
    const field = available.get(name);
    if (field === undefined) return undefined;
    const variable = `?w${index}`;
    index += 1;
    inSpec.push(variable);
    inputs.push(value);
    where.push(["?e", field.ident, variable]);
  }
  const limit = document.limit ?? DEFAULT_QUERY_LIMIT;
  return {
    query: {
      // `[:find [(pull ?e [...]) ...]]` — one collection of pulled rows.
      find: [[["pull", "?e", selected.map((field) => field.ident)], "..."]],
      in: inSpec,
      where,
      limit,
    },
    inputs,
    fields: selected,
    limit,
  };
};

export const runQueryDocument = async (
  context: AuthorizedRequestContext,
  caller: AuthenticatedCaller,
  document: QueryDocumentV1,
  options: { readonly maxCells?: number } = {},
): Promise<QueryResultV1> => {
  const lowered = lowerQueryDocument(context, caller, document);
  if (lowered === undefined) return Object.freeze({ rows: [], truncated: false });
  const result = await runOneShotRead(
    context.filteredDb,
    { kind: "query", query: lowered.query, inputs: lowered.inputs },
    options.maxCells === undefined ? {} : { maxCells: options.maxCells },
  );
  const pulled = Array.isArray(result) ? result : [];
  const rows: Record<string, unknown>[] = [];
  for (const row of pulled) {
    const out: Record<string, unknown> = {};
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    for (const field of lowered.fields) {
      // An absent key is the sealed answer for both "no value" and "hidden".
      // `toJson` is the engine's existing wire encoding — the same one `/query`
      // applies — so an instant, uuid, or byte value reaches the client in its
      // canonical `$inst` / `$uuid` / `$bytes` form instead of being mangled
      // by `JSON.stringify` into an object of numeric indices.
      if (record[field.ident] !== undefined) {
        out[field.name] = toJson(record[field.ident]);
      }
    }
    // A row that projects no visible value is not reported at all. Emitting an
    // empty object would make a policy-hidden field distinguishable from an
    // unknown one — the hidden field yields one `{}` per readable row, and
    // that count is itself the disclosure. Dropping the row gives hidden,
    // never-set, ref-shaped, and unknown field names the one same answer.
    if (Object.keys(out).length > 0) rows.push(out);
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    // Truncation is a fact about the *query*, not about what survived
    // projection: a query that came back full may have more behind it however
    // many rows the projection then dropped. Deriving it from `rows` instead
    // would report an exhausted result while the engine had stopped at its
    // cap. `truncated: true` alongside an empty `rows` is therefore a real
    // state, and reporting it honestly beats a tidier lie.
    truncated: pulled.length >= lowered.limit,
  });
};

// ---------------------------------------------------------------------------
// mutate
// ---------------------------------------------------------------------------

export type MutateResultV1 = {
  readonly invocationId: string;
  readonly status: "completed";
  readonly outcome: unknown;
};

/**
 * What stands in for an outcome this slice will not publish.
 *
 * The invocation committed — this is not a failure — but its declared result
 * cannot be shown without risking a storage id on the wire, so none of it is.
 */
export const OUTCOME_WITHHELD = Object.freeze({ withheld: "outcome" });

/**
 * Whether a declared contract can reach an entity reference at all.
 *
 * `opaque` is exact here rather than a guess: `lowerOperationSchema` refuses
 * to lower a schema that hides a Ramose ref inside a form it cannot describe,
 * so a shape that lowered to `opaque` provably contains none. (A contract
 * declared as plain `Unknown` still carries whatever the operation returns;
 * nothing there is *declared* to be a reference, so nothing here — or in the
 * receipt path — can identify one. That limit is the declared contract's, not
 * this projection's.)
 */
export const declaresReference = (shape: OperationInputShape): boolean => {
  switch (shape._tag) {
    case "ref":
      return true;
    case "array":
      return declaresReference(shape.items);
    case "struct":
      return shape.fields.some((field) => declaresReference(field.shape));
    case "scalar":
    case "opaque":
      return false;
  }
};

/**
 * Project one completed operation output, or withhold it whole.
 *
 * ## Why the rule is this blunt
 *
 * What reaches here is the operation's **encoded** output, while the declared
 * contract is the **decoded** projection: `lowerOperationSchema` follows a
 * transformation's `to` side by design, because operation bodies and the
 * authoritative ref filter work on the decoded value. Nothing about the
 * correspondence between the two survives an arbitrary codec. A codec may
 * rename the key a reference sits under, inject a key, or move the reference
 * into a slot the contract declares as an ordinary scalar — so neither the
 * key names nor the value positions can be trusted to locate a reference, and
 * masking slot by slot would only ever be right until the next codec trick.
 *
 * So the rule is the contract alone: if the declared output contract can reach
 * a reference anywhere, the whole outcome is withheld. The invocation still
 * committed and `status` still says so; only the result is not shown.
 * Contracts that declare no reference are returned untouched — there is
 * nothing in them to leak, and withholding would cost results for no reason.
 *
 * This is deliberately capability-losing. Publishing outcomes that carry
 * references is the job of the slice that introduces a public entity
 * reference; until then there is no honest way to show one.
 */
export const projectOperationOutcome = (
  shape: OperationInputShape,
  output: unknown,
): unknown => (declaresReference(shape) ? OUTCOME_WITHHELD : output);

/**
 * Restate one authoritative invocation outcome as the public MCP projection.
 * Every refusal below is produced by the existing #487 primitive; none of them
 * is re-derived here, and none names the deployed operation.
 */
export const publicMutateResult = (
  result: AuthoritativeInvocationResult,
  outputShape: OperationInputShape,
): MutateResultV1 | ErrorEnvelopeV1 => {
  switch (result._tag) {
    case "Completed":
      // The invocation committed either way; only the outcome can be withheld.
      return Object.freeze({
        invocationId: result.receipt.invocationId,
        status: "completed" as const,
        outcome: projectOperationOutcome(outputShape, result.output),
      });
    case "Conflict":
      return toolFailure(
        "invocation_conflict",
        "that invocationId already names a different invocation",
      ).envelope;
    case "OperationChanged":
      return toolFailure(
        "operation_changed",
        "the pinned operation version is not the deployed one; rediscover it",
      ).envelope;
    case "UpdateRequired":
      return toolFailure(
        "invocation_update_required",
        "this invocation must be retried under a fresh invocationId",
      ).envelope;
    case "Failed":
      return toolFailure("internal_error", "the operation did not complete").envelope;
    case "Indeterminate":
      return toolFailure(
        "invocation_indeterminate",
        "the outcome is not yet decidable; retry the same invocationId",
      ).envelope;
    case "Rejected":
      switch (result.rejection.kind) {
        case "unauthorized":
          return toolFailure("inaccessible", "no such operation is available here")
            .envelope;
        case "invalid_request":
          return toolFailure("invalid_input", "the operation refused this input")
            .envelope;
        case "request_rejected":
          return toolFailure("operation_rejected", "the operation refused the request")
            .envelope;
        case "operation_rejected":
          return toolFailure("operation_rejected", result.rejection.message).envelope;
      }
  }
};
