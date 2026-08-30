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
import { QueryBudgetError } from "../internal/core/query/engine.ts";
import { Index, ValueTag } from "../internal/core/datom.ts";
import { toJson } from "../internal/core/json.ts";
import { RAMOSE_TYPE_IDENT } from "../internal/core/schema.ts";
import {
  DEFAULT_QUERY_LIMIT,
  MAX_DESCRIBE_ITEMS,
  MAX_SELECT_FIELDS,
  encodeOperationVersionToken,
  McpToolFailure,
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
    // `mutate` has no `target` in this slice, and admission refuses a
    // target-required operation without one, so advertising it would only
    // publish a call no client here can make. Filtered *after* the visibility
    // predicate and *before* the cap, so neither a hidden nor an uninvocable
    // operation can set `truncated`.
    if (descriptor.id.target === "required") continue;
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
 * Whether one decision can be proven to deny this principal on every row.
 *
 * Mirrors `evaluateDecision` in `read-filter.ts`: a deny whose rule is missing
 * is fail-closed, an explicit deny that holds wins, and at least one allow
 * must be able to pass. The one addition is three-valued conservatism — an
 * allow that might pass on some row returns "not provably denied", so the
 * filtered `Db` settles it.
 */
const decisionStaticallyDenies = (
  decision: { readonly allow: readonly string[]; readonly deny: readonly string[] },
  rules: ReadonlyMap<string, { readonly expr: CanonicalAuthorizationExpr }>,
  caller: AuthenticatedCaller,
  subject: string,
): boolean => {
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
 * Whether policy denies this entity to this principal on *every* row.
 *
 * Mirrors `isRowReadable` in `read-filter.ts`, whose entity decision — like a
 * trait's, and unlike a field's — denies when it is missing.
 */
const staticallyHiddenEntity = (
  context: AuthorizedRequestContext,
  caller: AuthenticatedCaller,
  entity: string,
): boolean => {
  const policy = context.unit.policy;
  const decision = policy.decisions.entities.find(
    (entry) => entry.target.name === entity,
  )?.decision;
  if (decision === undefined) return true;
  return decisionStaticallyDenies(
    decision,
    new Map(policy.rules.map((rule) => [rule.id, rule])),
    caller,
    context.principal.subject,
  );
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
 * Together with {@link staticallyHiddenEntity} this now mirrors all three
 * tiers of the deployed hierarchy — entity, then trait, then field — with the
 * defaults `read-filter.ts` actually uses at each, and they are not the same:
 *
 * - an **entity** with no decision is denied (`isRowReadable` returns false);
 * - a **trait**-owned field first needs its owning trait readable, and a
 *   trait with no decision at all is denied (`isTraitReadable` returns false);
 * - a field with no decision *of its own* is governed entirely by its row, so
 *   it is never statically hidden.
 *
 * Anything row-dependent is likewise left for the filtered `Db` to settle.
 */
const staticallyHidden = (
  context: AuthorizedRequestContext,
  caller: AuthenticatedCaller,
  field: FieldDescriptor,
): boolean => {
  const policy = context.unit.policy;
  const subject = context.principal.subject;
  const rules = new Map(policy.rules.map((rule) => [rule.id, rule]));
  if (field.id.owner.kind === "trait") {
    const traitDecision = policy.decisions.traits.find(
      (entry) => entry.target.name === field.id.owner.name,
    )?.decision;
    // Unlike a field, a trait with no decision is denied outright.
    if (traitDecision === undefined) return true;
    if (decisionStaticallyDenies(traitDecision, rules, caller, subject)) return true;
  }
  const decision = policy.decisions.fields.find(
    (entry) => fieldKey(entry.target) === fieldKey(field.id),
  )?.decision;
  if (decision === undefined) return false;
  return decisionStaticallyDenies(decision, rules, caller, subject);
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
 * Refuse a select-less document against an entity wider than the select bound.
 *
 * An explicit `select` is bounded by {@link MAX_SELECT_FIELDS}; the implicit
 * projection was not, so a wide entity could exceed it by omission. Silently
 * projecting the first 64 fields would misrepresent the row — the caller could
 * not tell a truncated projection from a row that simply lacks the rest — so
 * the request is refused and the caller asked for an explicit `select`.
 * Refusing is additive: relaxing it later is a two-way door, publishing a
 * quietly truncated row is not.
 */
export const requireBoundedImplicitProjection = (visibleFields: number): void => {
  if (visibleFields > MAX_SELECT_FIELDS) {
    throw toolFailure(
      "invalid_query",
      `this entity exposes more than ${MAX_SELECT_FIELDS} readable fields; ` +
        "name the ones you want with an explicit select",
    );
  }
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
  // An entity this principal can never read leaves by the same door a name
  // this catalog does not have: it must not reach the engine, where the work
  // it does before returning nothing is itself observable.
  if (
    entity === undefined ||
    staticallyHiddenEntity(context, caller, entity.id.name)
  ) return undefined;
  const available = scalarFieldsOf(context, caller, entity.id.name);
  if (document.select === undefined) requireBoundedImplicitProjection(available.size);
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

/**
 * Classify a read failure that has a declared public code, or `undefined` to
 * leave it to the generic handler.
 *
 * A budget abort is the caller's to fix — a narrower filter or a smaller
 * limit succeeds — so it must arrive as its own retryable code rather than
 * the opaque internal failure everything else collapses into.
 */
export const queryReadFailure = (cause: unknown): McpToolFailure | undefined =>
  cause instanceof QueryBudgetError
    ? toolFailure(
      "query_budget_exceeded",
      "the query exceeded its read budget; narrow it with more specific " +
        "filters or a smaller limit",
    )
    : undefined;

export const runQueryDocument = async (
  context: AuthorizedRequestContext,
  caller: AuthenticatedCaller,
  document: QueryDocumentV1,
  options: { readonly maxCells?: number } = {},
): Promise<QueryResultV1> => {
  const lowered = lowerQueryDocument(context, caller, document);
  if (lowered === undefined) return Object.freeze({ rows: [], truncated: false });
  let result: unknown;
  try {
    result = await runOneShotRead(
      context.filteredDb,
      { kind: "query", query: lowered.query, inputs: lowered.inputs },
      options.maxCells === undefined ? {} : { maxCells: options.maxCells },
    );
  } catch (cause) {
    throw queryReadFailure(cause) ?? cause;
  }
  const pulled = Array.isArray(result) ? result : [];
  const rows: Record<string, unknown>[] = [];
  for (const row of pulled) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const projected: (readonly [string, unknown])[] = [];
    for (const field of lowered.fields) {
      // An absent key is the sealed answer for both "no value" and "hidden".
      // `toJson` is the engine's existing wire encoding — the same one `/query`
      // applies — so an instant, uuid, or byte value reaches the client in its
      // canonical `$inst` / `$uuid` / `$bytes` form instead of being mangled
      // by `JSON.stringify` into an object of numeric indices.
      if (record[field.ident] !== undefined) {
        projected.push([field.name, toJson(record[field.ident])] as const);
      }
    }
    // A row that projects no visible value is not reported at all. Emitting an
    // empty object would make a policy-hidden field distinguishable from an
    // unknown one — the hidden field yields one `{}` per readable row, and
    // that count is itself the disclosure. Dropping the row gives hidden,
    // never-set, ref-shaped, and unknown field names the one same answer.
    // `fromEntries` so a field an author named `__proto__` lands as an own
    // property rather than vanishing into the inherited setter.
    if (projected.length > 0) rows.push(Object.fromEntries(projected));
  }
  // Nothing survived projection. The static layer settles a field policy hides
  // on every row, but it deliberately defers a row-dependent rule, and such a
  // rule can still hide the selection on every row the query returned. Left
  // alone that would answer `truncated: true` where an unknown name answers
  // `truncated: false`, and the flag would be the tell. Collapsing to the
  // absent answer costs a field visible only past the limit — the same
  // indistinguishable-from-unset trade the row drop above already makes.
  if (rows.length === 0) return Object.freeze({ rows: [], truncated: false });
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
 * Whether a declared contract is *provably* free of entity references.
 *
 * The polarity matters. It is not "does this contract mention a reference" —
 * it is "can this contract prove it carries none", and a contract that
 * declares nothing about its interior proves nothing. `opaque` is exactly
 * that case: an output declared as bare `Unknown` lowers to it and then
 * carries whatever the operation returned, storage ids included. So `opaque`
 * is not publishable, and only `scalar`, and structures built entirely from
 * publishable parts, are.
 */
export const publishableWithoutReferences = (
  shape: OperationInputShape,
): boolean => {
  switch (shape._tag) {
    case "scalar":
      return true;
    case "array":
      return publishableWithoutReferences(shape.items);
    case "struct":
      return shape.fields.every((field) =>
        publishableWithoutReferences(field.shape)
      );
    case "ref":
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
 * So the rule is the contract alone, and it publishes only what the contract
 * *proves* safe: an outcome is shown when its declared shape is provably
 * reference-free, and withheld otherwise. The invocation still committed and
 * `status` still says so; only the result is not shown.
 *
 * This is deliberately capability-losing. Publishing outcomes that carry — or
 * merely might carry — references is the job of the slice that introduces a
 * public entity reference; until then there is no honest way to show one.
 */
export const projectOperationOutcome = (
  shape: OperationInputShape,
  output: unknown,
): unknown =>
  publishableWithoutReferences(shape) ? output : OUTCOME_WITHHELD;

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
