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

export type QueryResultV1 = {
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
};

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

type StaticTruth = boolean | undefined;

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
    if (traitDecision === undefined) return true;
    if (decisionStaticallyDenies(traitDecision, rules, caller, subject)) return true;
  }
  const decision = policy.decisions.fields.find(
    (entry) => fieldKey(entry.target) === fieldKey(field.id),
  )?.decision;
  if (decision === undefined) return false;
  return decisionStaticallyDenies(decision, rules, caller, subject);
};

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
    if (context.currentDb.attr(ident) === undefined) continue;
    if (staticallyHidden(context, caller, field)) continue;
    fields.set(field.id.localName, Object.freeze({
      name: field.id.localName,
      ident,
    }));
  }
  return fields;
};

export const requireBoundedImplicitProjection = (visibleFields: number): void => {
  if (visibleFields > MAX_SELECT_FIELDS) {
    throw toolFailure(
      "invalid_query",
      `this entity exposes more than ${MAX_SELECT_FIELDS} readable fields; ` +
        "name the ones you want with an explicit select",
    );
  }
};

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
      if (record[field.ident] !== undefined) {
        projected.push([field.name, toJson(record[field.ident])] as const);
      }
    }
    if (projected.length > 0) rows.push(Object.fromEntries(projected));
  }
  if (rows.length === 0) return Object.freeze({ rows: [], truncated: false });
  return Object.freeze({
    rows: Object.freeze(rows),
    truncated: pulled.length >= lowered.limit,
  });
};

export type MutateResultV1 = {
  readonly invocationId: string;
  readonly status: "completed";
  readonly outcome: unknown;
};

export const OUTCOME_WITHHELD = Object.freeze({ withheld: "outcome" });

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

export const projectOperationOutcome = (
  shape: OperationInputShape,
  output: unknown,
): unknown =>
  publishableWithoutReferences(shape) ? output : OUTCOME_WITHHELD;

export const publicMutateResult = (
  result: AuthoritativeInvocationResult,
  outputShape: OperationInputShape,
): MutateResultV1 | ErrorEnvelopeV1 => {
  switch (result._tag) {
    case "Completed":
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
