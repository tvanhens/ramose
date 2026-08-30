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

import type { OperationInputShape } from "../internal/authorization/catalog.ts";
import type { AuthenticatedCaller, AuthorizedRequestContext } from "../internal/authorization/request.ts";
import { operationGrantAllows } from "../internal/authorization/operation-grant.ts";
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
      if (found.size >= limit) {
        truncated = true;
        break outer;
      }
      const row = await context.filteredDb.entity(datom.e);
      const type = row?.[RAMOSE_TYPE_IDENT];
      if (typeof type !== "string" || !composition.isEntityIdent(type)) continue;
      if (!composition.transitiveTraits(type).includes(GRAPH_TRAIT_IDENT)) continue;
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
  for (const entity of catalog.entities) {
    if (typeAttribute === undefined) break;
    if (entities.length >= MAX_DESCRIBE_ITEMS) {
      truncated = true;
      break;
    }
    const row = await context.filteredDb.first(Index.AVET, {
      a: typeAttribute.id,
      vt: ValueTag.Str,
      v: `:${entity.id.name}`,
    });
    if (row !== undefined) entities.push(entity.id.name);
  }
  const operations: DescribeResultV1["operations"][number][] = [];
  for (const descriptor of catalog.operations) {
    if (operations.length >= MAX_DESCRIBE_ITEMS) {
      truncated = true;
      break;
    }
    if (
      !operationGrantAllows(
        context.unit,
        descriptor,
        caller,
        context.principal.subject,
      )
    ) continue;
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

/**
 * Public field names an entity exposes, mapped to their storage idents.
 *
 * Only scalar fields are projectable in this slice. A ref field's value is an
 * entity id, and S1 has no public entity reference to project one into, so
 * offering one would put a storage id on the wire; excluding the field keeps
 * it indistinguishable from any other name this catalog does not expose.
 */
const scalarFieldsOf = (
  context: AuthorizedRequestContext,
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
  document: QueryDocumentV1,
): {
  readonly query: Record<string, unknown>;
  readonly inputs: readonly unknown[];
  readonly fields: readonly ResolvedField[];
} | undefined => {
  const entity = context.unit.catalog.entities.find(
    (candidate) => candidate.id.name === document.from.entity,
  );
  if (entity === undefined) return undefined;
  const available = scalarFieldsOf(context, entity.id.name);
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
  return {
    query: {
      // `[:find [(pull ?e [...]) ...]]` — one collection of pulled rows.
      find: [[["pull", "?e", selected.map((field) => field.ident)], "..."]],
      in: inSpec,
      where,
      limit: document.limit ?? DEFAULT_QUERY_LIMIT,
    },
    inputs,
    fields: selected,
  };
};

export const runQueryDocument = async (
  context: AuthorizedRequestContext,
  document: QueryDocumentV1,
  options: { readonly maxCells?: number } = {},
): Promise<QueryResultV1> => {
  const lowered = lowerQueryDocument(context, document);
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
    truncated: rows.length >= (document.limit ?? DEFAULT_QUERY_LIMIT),
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
 * What stands in for a reference-shaped value an operation returned.
 *
 * An operation that yields an entity reference yields a storage id, and S1 has
 * no public entity reference to project one into. Rather than put the id on
 * the wire or invent an encoding this slice cannot commit to, the slot is
 * replaced by this self-describing marker. A later slice replaces the marker
 * with a real reference; until then a client can see that a value existed and
 * that it is deliberately withheld.
 */
export const REFERENCE_WITHHELD = Object.freeze({ withheld: "reference" });

/**
 * What stands in for a whole outcome whose reference slots cannot be located.
 *
 * The invocation committed — this is not a failure — but its result cannot be
 * shown without risking a storage id on the wire, so none of it is.
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
const declaresReference = (shape: OperationInputShape): boolean => {
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
 * Replace every reference-shaped slot of one operation output with
 * {@link REFERENCE_WITHHELD}, guided by the operation's declared output shape.
 * Returns `undefined` when the value cannot be proven to line up with that
 * shape, so the caller withholds the whole outcome instead of guessing.
 *
 * ## Why alignment has to be proven
 *
 * The value reaching here is the operation's **encoded** output — the exact
 * JSON its codec produced — while the declared shape is the **decoded**
 * projection (`lowerOperationSchema` follows a transformation's `to` side by
 * design, because operation bodies and the authoritative ref filter work on
 * the decoded value). A codec that renames a key on the way out — Effect's
 * `encodeKeys`, say — therefore publishes a reference under a name the shape
 * never mentions, and masking by declared name alone would sail past it.
 *
 * So wherever the contract declares a struct that can reach a reference, every
 * key actually present must be one the contract declared. A renamed or
 * injected key fails that check and the outcome is withheld. Contracts that
 * declare no reference at all are returned untouched: there is nothing there
 * to leak, and refusing them would withhold results for no reason.
 *
 * The shape — not the value — decides what is a reference: a plain number
 * stays a number unless the contract says that position holds one.
 */
export const maskReferenceOutput = (
  shape: OperationInputShape,
  value: unknown,
): { readonly value: unknown } | undefined => {
  if (!declaresReference(shape)) return { value };
  switch (shape._tag) {
    case "ref":
      return {
        value: value === null || value === undefined ? value : REFERENCE_WITHHELD,
      };
    case "array": {
      if (!Array.isArray(value)) return undefined;
      const items: unknown[] = [];
      for (const item of value) {
        const masked = maskReferenceOutput(shape.items, item);
        if (masked === undefined) return undefined;
        items.push(masked.value);
      }
      return { value: items };
    }
    case "struct": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
      }
      const record = value as Record<string, unknown>;
      const declared = new Map(shape.fields.map((field) => [field.key, field.shape]));
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(record)) {
        const field = declared.get(key);
        // An undeclared key is a key the codec renamed or added: its meaning,
        // and whether it holds a reference, cannot be established here.
        if (field === undefined) return undefined;
        const masked = maskReferenceOutput(field, entry);
        if (masked === undefined) return undefined;
        out[key] = masked.value;
      }
      return { value: out };
    }
    case "scalar":
    case "opaque":
      return { value };
  }
};

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
    case "Completed": {
      // The invocation committed either way; only the outcome can be withheld.
      const masked = maskReferenceOutput(outputShape, result.output);
      return Object.freeze({
        invocationId: result.receipt.invocationId,
        status: "completed" as const,
        outcome: masked === undefined ? OUTCOME_WITHHELD : masked.value,
      });
    }
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
