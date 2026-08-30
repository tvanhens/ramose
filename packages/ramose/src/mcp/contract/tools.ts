/**
 * The three mandatory kernel tools (#485).
 *
 * `describe`, `query`, and `mutate` cover the complete deployed application
 * surface. That is the point of the kernel: adding a capability to an
 * application must require no MCP-specific server code and must not change
 * this tool list. Generated native aliases (#542) are derived views over
 * `mutate` and never a fourth authority.
 *
 * ## The result shape every tool shares
 *
 * Each tool's output schema is a discriminated union on `ok`.
 *
 * - `ok: true` is the success envelope for that tool.
 * - `ok: false` carries the shared {@link ErrorEnvelopeV1}, and is delivered
 *   as a **completed** MCP tool result with `isError: true` — not a protocol
 *   error. A recoverable failure is information the calling agent needs, so it
 *   arrives as schema-valid `structuredContent` it can actually read.
 *
 * The authoritative result is always `structuredContent`. The required text
 * `content` is derived from it mechanically by `text.ts` and can never mean
 * something different.
 *
 * ## Consistency
 *
 * - `ifCatalog` is optional everywhere. Omitting it means "interpret against
 *   the current authorized catalog"; supplying a stale one is
 *   `catalog_changed`, never a silent reinterpretation.
 * - `operation.version` is required on `mutate`. Absent or stale is refused
 *   before any effect.
 * - `invocationId` is required on `mutate`. It, and nothing else, decides
 *   idempotency and recovery.
 */

import * as Schema from "effect/Schema";
import {
  MAX_DESCRIBE_ITEMS,
  MAX_DESCRIBE_KINDS,
  MAX_QUERY_ROW_COLUMNS,
  MAX_QUERY_ROWS,
  MAX_SEARCH_LENGTH,
} from "./bounds.ts";
import {
  CapabilityCardV1,
  CapabilitySummaryV1,
  DescribeRefV1,
  DISCOVERY_KINDS,
  KERNEL_TOOL_NAMES,
  MUTATE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  type CapabilityCardV1 as CapabilityCardType,
  type CapabilitySummaryV1 as CapabilitySummaryType,
  type DescribeRefV1 as DescribeRefType,
  type DiscoveryKindV1,
  type KernelToolNameV1,
  type ToolAnnotationsV1,
} from "./cards.ts";
import { ErrorEnvelopeV1, type ErrorEnvelopeV1 as ErrorEnvelopeType } from "./errors.ts";
import {
  assertNoReservedArgumentNames,
  rootJsonSchemaOf,
  type JsonSchemaV1,
} from "./json-schema.ts";
import {
  CatalogTokenV1,
  CursorV1,
  GraphPathV1,
  InstanceRefV1,
  InvocationIdV1,
  JsonObjectV1,
  JsonValueV1,
  PageInfoV1,
  PageLimitV1,
  type GraphPathV1 as GraphPathType,
  type InstanceRefV1 as InstanceRefType,
  type JsonObjectV1 as JsonObjectType,
  type JsonValueV1 as JsonValueType,
  type PageInfoV1 as PageInfoType,
} from "./primitives.ts";
import {
  DeliveryInfoV1,
  DeliveryRequestV1,
  QueryDocumentEnvelopeV1,
  type DeliveryInfoV1 as DeliveryInfoType,
  type DeliveryRequestV1 as DeliveryRequestType,
  type QueryDocumentEnvelopeV1 as QueryDocumentType,
} from "./query-document.ts";
import { MutationReceiptV1, type MutationReceiptV1 as MutationReceiptType } from "./receipts.ts";
import { OperationRefV1, type OperationRefV1 as OperationRefType } from "./references.ts";

/**
 * `at` and `ifCatalog` are optional on every request and present on every
 * successful result.
 *
 * They are referenced without re-annotating at each site. An already-identified
 * schema that is annotated again becomes a second `$defs` entry under a
 * generated name, and a frozen contract must not publish names nobody chose —
 * so `GraphPathV1` and `CatalogTokenV1` carry one description that covers both
 * roles, and `json-schema.ts` fails the build if that ever stops being true.
 */
const OptionalAt = Schema.optionalKey(GraphPathV1);
const OptionalIfCatalog = Schema.optionalKey(CatalogTokenV1);

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------

/**
 * Progressive discovery.
 *
 * Two modes, chosen by whether `ref` is present. Without `ref` it lists what
 * is visible, optionally narrowed by fuzzy `search` text and by `kinds`. With
 * `ref` it returns exactly one full card. Fuzzy text is only ever discovery
 * *input*: nothing is addressed by it, and a listing entry always carries the
 * exact reference a caller drills down with.
 */
export const DescribeInputV1 = Schema.Struct({
  at: OptionalAt,
  search: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_SEARCH_LENGTH),
    ),
  ).annotate({
    description:
      "Free-text discovery hint. Narrows a listing; never addresses a capability.",
  }),
  kinds: Schema.optionalKey(
    Schema.Array(Schema.Literals(DISCOVERY_KINDS)).check(
      Schema.isMaxLength(MAX_DESCRIBE_KINDS),
    ),
  ).annotate({
    description: "Restrict the listing to these families. Omit for all of them.",
  }),
  ref: Schema.optionalKey(DescribeRefV1),
  limit: Schema.optionalKey(PageLimitV1),
  cursor: Schema.optionalKey(CursorV1),
  ifCatalog: OptionalIfCatalog,
}).annotate({
  description:
    "Discover the graphs, entities, traits, fields, operations, and query functions visible to the caller at one path.",
});
export type DescribeInputV1 = {
  readonly at?: GraphPathType;
  readonly search?: string;
  readonly kinds?: readonly DiscoveryKindV1[];
  readonly ref?: DescribeRefType;
  readonly limit?: number;
  readonly cursor?: string;
  readonly ifCatalog?: string;
};

const DescribeListingV1 = Schema.Struct({
  ok: Schema.Literal(true).annotate({
    description:
      "Discriminator. true means this is a successful result; the tool result is not flagged as an error.",
  }),
  result: Schema.Literal("listing").annotate({
    description: "Discriminator. \"listing\" means a page of summaries.",
  }),
  at: GraphPathV1,
  catalogToken: CatalogTokenV1,
  items: Schema.Array(CapabilitySummaryV1).check(
    Schema.isMaxLength(MAX_DESCRIBE_ITEMS),
  ).annotate({ description: "This page of visible capabilities." }),
  page: PageInfoV1,
}).annotate({
  identifier: "DescribeListingV1",
  description: "A bounded page of discovered capabilities.",
});

const DescribeCardResultV1 = Schema.Struct({
  ok: Schema.Literal(true).annotate({
    description:
      "Discriminator. true means this is a successful result; the tool result is not flagged as an error.",
  }),
  result: Schema.Literal("card").annotate({
    description: "Discriminator. \"card\" means exactly one full card.",
  }),
  at: GraphPathV1,
  catalogToken: CatalogTokenV1,
  card: CapabilityCardV1,
}).annotate({
  identifier: "DescribeCardResultV1",
  description: "The full card for one exactly addressed capability.",
});

const ToolErrorResultV1 = Schema.Struct({
  ok: Schema.Literal(false).annotate({
    description:
      "Discriminator. false means this is a recoverable failure, delivered as a completed tool result with isError true.",
  }),
  error: ErrorEnvelopeV1,
}).annotate({
  identifier: "ToolErrorResultV1",
  description:
    "A recoverable failure. Delivered as a completed tool result with isError true.",
});

export const DescribeOutputV1 = Schema.Union([
  DescribeListingV1,
  DescribeCardResultV1,
  ToolErrorResultV1,
]).annotate({
  description:
    "Discriminated on ok: a listing, one card, or a recoverable error envelope.",
});
export type DescribeOutputV1 =
  | {
    readonly ok: true;
    readonly result: "listing";
    readonly at: GraphPathType;
    readonly catalogToken: string;
    readonly items: readonly CapabilitySummaryType[];
    readonly page: PageInfoType;
  }
  | {
    readonly ok: true;
    readonly result: "card";
    readonly at: GraphPathType;
    readonly catalogToken: string;
    readonly card: CapabilityCardType;
  }
  | { readonly ok: false; readonly error: ErrorEnvelopeType };

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

/**
 * One row of a query result.
 *
 * `values` is the caller's own selection, as plain JSON — the query decides
 * what is in it. The other two members are what make a result *traversable*
 * rather than merely readable: `ref` is the row's public typed identity, so a
 * caller can name it again in a `mutate` target, and `at` is the row's own
 * graph path when the row is itself a graph, so graph-of-graphs traversal
 * uses only paths the server returned.
 */
export const QueryRowV1 = Schema.Struct({
  values: Schema.Record(Schema.String, JsonValueV1).annotate({
    description:
      "The selected columns for this row, exactly as the query named them.",
  }),
  ref: Schema.optionalKey(InstanceRefV1),
  at: Schema.optionalKey(GraphPathV1),
}).annotate({
  identifier: "QueryRowV1",
  description:
    `One result row. The query language bounds a document to ${MAX_QUERY_ROW_COLUMNS} selected columns, so values never has more than that.`,
});
export type QueryRowV1 = {
  readonly values: JsonObjectType;
  readonly ref?: InstanceRefType;
  readonly at?: GraphPathType;
};

/**
 * Execute one query document.
 *
 * `cursor` continues a previous page. It is a tool argument rather than a
 * member of the query document, and deliberately so: whether a call is the
 * first page or the fourth is not part of what the query *means*, and keeping
 * it out means the same document is re-sent byte-for-byte to walk a listing.
 * That is what makes "the rest of the request unchanged" a checkable rule
 * instead of a convention — and it is the same shape `describe` already uses,
 * so one continuation idiom covers both read tools.
 *
 * A cursor carries the catalog it was minted under; see {@link CursorV1} for
 * how that interacts with `ifCatalog`.
 */
export const QueryInputV1 = Schema.Struct({
  at: OptionalAt,
  query: QueryDocumentEnvelopeV1,
  cursor: Schema.optionalKey(CursorV1),
  ifCatalog: OptionalIfCatalog,
  delivery: Schema.optionalKey(DeliveryRequestV1),
}).annotate({
  description:
    "Execute one versioned, plain-data query document against the graph selected by at. To continue a page, resend the identical request plus the cursor the previous result returned.",
});
export type QueryInputV1 = {
  readonly at?: GraphPathType;
  readonly query: QueryDocumentType;
  readonly cursor?: string;
  readonly ifCatalog?: string;
  readonly delivery?: DeliveryRequestType;
};

const QuerySuccessV1 = Schema.Struct({
  ok: Schema.Literal(true).annotate({
    description:
      "Discriminator. true means this is a successful result; the tool result is not flagged as an error.",
  }),
  at: GraphPathV1,
  catalogToken: CatalogTokenV1,
  rows: Schema.Array(QueryRowV1).check(
    Schema.isMaxLength(MAX_QUERY_ROWS),
  ).annotate({ description: "This page of rows, in the query's own order." }),
  page: PageInfoV1,
  delivery: DeliveryInfoV1,
}).annotate({
  identifier: "QuerySuccessV1",
  description: "A bounded, deterministically ordered page of query results.",
});

export const QueryOutputV1 = Schema.Union([
  QuerySuccessV1,
  ToolErrorResultV1,
]).annotate({
  description:
    "Discriminated on ok: a page of rows, or a recoverable error envelope.",
});
export type QueryOutputV1 =
  | {
    readonly ok: true;
    readonly at: GraphPathType;
    readonly catalogToken: string;
    readonly rows: readonly QueryRowV1[];
    readonly page: PageInfoType;
    readonly delivery: DeliveryInfoType;
  }
  | { readonly ok: false; readonly error: ErrorEnvelopeType };

// ---------------------------------------------------------------------------
// mutate
// ---------------------------------------------------------------------------

/**
 * Invoke exactly one version of exactly one declared operation.
 *
 * There is no raw-write path on this wire. `mutate` never exposes storage
 * writes, never accepts operation source or an AST, and never executes
 * anything the application did not declare (#417, #501).
 *
 * `ifCatalog` is accepted here for the same reason it is accepted on the read
 * tools, and it matters more: an agent that inspected a capability with
 * `describe` and then acts on it can pin the catalog it inspected, so a
 * catalog that moved in between is a `catalog_changed` refusal rather than a
 * destructive call made against a world the caller never saw. `operation.version`
 * fences the operation's own contract; `ifCatalog` fences everything the agent
 * read to decide the call was the right one. Omitting it means the current
 * authorized catalog, which is the right default for a client that did not
 * inspect anything first.
 */
export const MutateInputV1 = Schema.Struct({
  at: OptionalAt,
  operation: OperationRefV1,
  target: Schema.optionalKey(InstanceRefV1),
  input: Schema.optionalKey(JsonObjectV1).annotate({
    description:
      "Arguments for the operation, satisfying the input schema on its card. Omit when the operation declares none.",
  }),
  invocationId: InvocationIdV1,
  ifCatalog: OptionalIfCatalog,
}).annotate({
  description:
    "Invoke one exact versioned catalog operation with a caller-minted invocation id. Supply target when the operation's card says its target is required and omit it when the card says none; supply input when the card declares an input schema. Reusing an invocationId with the same arguments replays the original outcome; reusing it with different arguments is invocation_conflict.",
});
export type MutateInputV1 = {
  readonly at?: GraphPathType;
  readonly operation: OperationRefType;
  readonly target?: InstanceRefType;
  readonly input?: JsonObjectType;
  readonly invocationId: string;
  readonly ifCatalog?: string;
};

const MutateSuccessV1 = Schema.Struct({
  ok: Schema.Literal(true).annotate({
    description:
      "Discriminator. true means this is a successful result; the tool result is not flagged as an error.",
  }),
  at: GraphPathV1,
  receipt: MutationReceiptV1,
  output: JsonValueV1,
}).annotate({
  identifier: "MutateSuccessV1",
  description:
    "The invocation completed. output is the operation's declared output, satisfying the output schema on its card. Replaying the same invocationId returns exactly this again.",
});

/**
 * A mutation failure. `receipt` is present whenever a durable receipt exists —
 * which is exactly when the outcome is `rejected`, `failed`, or
 * `indeterminate`. Its `status`, not the error `code`, is the authoritative
 * account of what happened to the write; the code is the coarse recovery
 * class. Refusals that had no effect at all (`invocation_conflict`,
 * `operation_changed`) carry no receipt, because there is nothing to receipt.
 */
const MutateErrorResultV1 = Schema.Struct({
  ok: Schema.Literal(false).annotate({
    description:
      "Discriminator. false means this is a recoverable failure, delivered as a completed tool result with isError true.",
  }),
  error: ErrorEnvelopeV1,
  receipt: Schema.optionalKey(MutationReceiptV1),
}).annotate({
  identifier: "MutateErrorResultV1",
  description:
    "A recoverable mutation failure. receipt is present exactly when a durable receipt exists, and its status — not the error code — is the authoritative account of what happened to the write.",
});

export const MutateOutputV1 = Schema.Union([
  MutateSuccessV1,
  MutateErrorResultV1,
]).annotate({
  description:
    "Discriminated on ok: the completed invocation, or a recoverable error envelope with any durable receipt.",
});
export type MutateOutputV1 =
  | {
    readonly ok: true;
    readonly at: GraphPathType;
    readonly receipt: MutationReceiptType;
    readonly output: JsonValueType;
  }
  | {
    readonly ok: false;
    readonly error: ErrorEnvelopeType;
    readonly receipt?: MutationReceiptType;
  };

// ---------------------------------------------------------------------------
// The published tool contracts
// ---------------------------------------------------------------------------

/** One published kernel tool: name, prose, schemas, and behavior hints. */
export type ToolContractV1 = {
  readonly name: KernelToolNameV1;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaV1;
  readonly outputSchema: JsonSchemaV1;
  readonly annotations: ToolAnnotationsV1;
};

const toolContract = (input: {
  readonly name: KernelToolNameV1;
  readonly title: string;
  readonly description: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  readonly annotations: ToolAnnotationsV1;
}): ToolContractV1 => {
  const inputSchema = rootJsonSchemaOf(input.input);
  const outputSchema = rootJsonSchemaOf(input.output);
  if (inputSchema.type !== "object") {
    throw new TypeError(
      `ramose/mcp: tool ${input.name} input schema root must be a JSON object`,
    );
  }
  assertNoReservedArgumentNames(inputSchema, `tool ${input.name} input schema`);
  return Object.freeze({
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema,
    outputSchema,
    annotations: input.annotations,
  });
};

export const DESCRIBE_TOOL: ToolContractV1 = toolContract({
  name: "describe",
  title: "Describe",
  description:
    "Progressively discover the graphs, entities, traits, fields, operations, and query functions visible at a root-relative path. Omit ref to list; send an exact ref to get one full card, including the operation version a mutate requires.",
  input: DescribeInputV1,
  output: DescribeOutputV1,
  annotations: Object.freeze({ ...READ_ONLY_ANNOTATIONS, title: "Describe" }),
});

export const QUERY_TOOL: ToolContractV1 = toolContract({
  name: "query",
  title: "Query",
  description:
    "Execute one versioned, plain-data query document against the graph selected by at. Results are bounded, deterministically ordered, and paged with opaque cursors; nothing is ever truncated silently.",
  input: QueryInputV1,
  output: QueryOutputV1,
  annotations: Object.freeze({ ...READ_ONLY_ANNOTATIONS, title: "Query" }),
});

export const MUTATE_TOOL: ToolContractV1 = toolContract({
  name: "mutate",
  title: "Mutate",
  description:
    "Invoke exactly one version of exactly one declared operation, with a caller-minted invocationId. Reusing an invocationId replays the original outcome rather than repeating the effect. There is no raw write path.",
  input: MutateInputV1,
  output: MutateOutputV1,
  annotations: Object.freeze({ ...MUTATE_ANNOTATIONS, title: "Mutate" }),
});

/** The complete, fixed kernel tool list, in discovery order. */
export const KERNEL_TOOLS: readonly ToolContractV1[] = Object.freeze([
  DESCRIBE_TOOL,
  QUERY_TOOL,
  MUTATE_TOOL,
]);

/** Look up one published tool contract by name. */
export const kernelTool = (name: KernelToolNameV1): ToolContractV1 => {
  const found = KERNEL_TOOLS.find((tool) => tool.name === name);
  if (found === undefined) {
    throw new TypeError(`ramose/mcp: no kernel tool named ${name}`);
  }
  return found;
};

/** Runtime validators for `structuredContent`, from the same definitions. */
export const isDescribeOutput = Schema.is(DescribeOutputV1);
export const isQueryOutput = Schema.is(QueryOutputV1);
export const isMutateOutput = Schema.is(MutateOutputV1);
export const isDescribeInput = Schema.is(DescribeInputV1);
export const isQueryInput = Schema.is(QueryInputV1);
export const isMutateInput = Schema.is(MutateInputV1);

export { KERNEL_TOOL_NAMES };
export type { KernelToolNameV1 };
