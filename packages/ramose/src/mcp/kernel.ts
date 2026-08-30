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

import type { AuthenticatedCaller, AuthorizedRequestContext } from "../internal/authorization/request.ts";
import { operationGrantAllows } from "../internal/authorization/operation-grant.ts";
import type { AuthoritativeInvocationResult } from "../internal/authorization/invocation-receipts.ts";
import { runOneShotRead } from "../internal/authorization/reads.ts";
import { Index, ValueTag } from "../internal/core/datom.ts";
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
 * Only scalar fields are projectable in this slice: a ref value is an entity
 * id, and S1 has no public entity reference to project one into.
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
  const rows = pulled.map((row) => {
    const out: Record<string, unknown> = {};
    if (row === null || typeof row !== "object") return out;
    const record = row as Record<string, unknown>;
    for (const field of lowered.fields) {
      // An absent key is the sealed answer for both "no value" and "hidden".
      if (record[field.ident] !== undefined) out[field.name] = record[field.ident];
    }
    return out;
  });
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
 * Restate one authoritative invocation outcome as the public MCP projection.
 * Every refusal below is produced by the existing #487 primitive; none of them
 * is re-derived here, and none names the deployed operation.
 */
export const publicMutateResult = (
  result: AuthoritativeInvocationResult,
): MutateResultV1 | ErrorEnvelopeV1 => {
  switch (result._tag) {
    case "Completed":
      return Object.freeze({
        invocationId: result.receipt.invocationId,
        status: "completed" as const,
        outcome: result.output,
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
