/**
 * Capability cards (#485).
 *
 * Discovery is a *projection* of the same filtered catalog and metadata seal
 * that execution uses. A card is therefore never authority: holding one does
 * not mean the operation it describes can still be invoked, and every field on
 * it is revalidated at call time. What a card buys is that an agent with no
 * application-specific prompt can go from "something about closing issues"
 * to a call it can actually make, without guessing.
 *
 * Cards come in two sizes, and the difference is deliberate:
 *
 * - a **summary** is what a listing returns — enough to decide whether to look
 *   closer, small enough that a page of them is cheap;
 * - a **card** is what an exact drill-down returns — the full MCP-shaped
 *   schemas, annotations, the required operation version, and a canonical
 *   `mutate` template that lowers to the generic path with no alias-specific
 *   executor anywhere behind it.
 */

import * as Schema from "effect/Schema";
import {
  MAX_CARD_DESCRIPTION_LENGTH,
  MAX_CARD_FIELDS,
  MAX_CARD_OPERATIONS,
  MAX_CARD_TITLE_LENGTH,
  MAX_CARD_TRAITS,
} from "./bounds.ts";
import { JsonSchemaV1 } from "./json-schema.ts";
import {
  CatalogTokenV1,
  GraphPathV1,
  ResourceLinkV1,
  type CatalogTokenV1 as CatalogTokenType,
  type ResourceLinkV1 as ResourceLinkType,
} from "./primitives.ts";
import {
  DefinitionRefV1,
  EntityRefV1,
  FieldRefV1,
  FunctionRefV1,
  GraphRefV1,
  OperationRefV1,
  OPERATION_TARGET_MODES,
  OwnerRefV1,
  PublicNameV1,
  TraitRefV1,
  type DefinitionRefV1 as DefinitionRefType,
  type EntityRefV1 as EntityRefType,
  type FieldRefV1 as FieldRefType,
  type FunctionRefV1 as FunctionRefType,
  type GraphRefV1 as GraphRefType,
  type OperationRefV1 as OperationRefType,
  type OperationTargetModeV1,
  type OwnerRefV1 as OwnerRefType,
  type TraitRefV1 as TraitRefType,
} from "./references.ts";

const CardTitle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CARD_TITLE_LENGTH),
).annotate({
  description:
    "Short human-facing name, when the application author supplied one.",
});
const CardDescription = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CARD_DESCRIPTION_LENGTH),
).annotate({
  description:
    "Documentation the application author wrote, projected verbatim. Prose only: never part of any compatibility decision.",
});

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * MCP tool behavior hints.
 *
 * These are *hints*, never authority: a client may use them to decide whether
 * to ask a human first, and a server never uses them to decide anything. The
 * kernel's own values are fixed and conservative — `describe` and `query` are
 * read-only, non-destructive, idempotent, and closed-world; generic `mutate`
 * is none of the first three by default and open-world, because it stands for
 * every operation an application may ever declare.
 */
export const ToolAnnotationsV1 = Schema.Struct({
  title: Schema.optionalKey(CardTitle).annotate({
    description: "Short human-facing name.",
  }),
  readOnlyHint: Schema.Boolean.annotate({
    description: "True when the call cannot change application state.",
  }),
  destructiveHint: Schema.Boolean.annotate({
    description:
      "True when the call may remove or overwrite state. Meaningless when readOnlyHint is true.",
  }),
  idempotentHint: Schema.Boolean.annotate({
    description:
      "True when repeating the call with the same arguments has no additional effect.",
  }),
  openWorldHint: Schema.Boolean.annotate({
    description:
      "True when the call may reach state outside this server's closed world.",
  }),
}).annotate({
  identifier: "ToolAnnotationsV1",
  description:
    "Behavior hints for a tool or operation. Advisory only; the server never treats them as authority.",
});
export type ToolAnnotationsV1 = {
  readonly title?: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
};

/** Annotations for the two read-only kernel tools. */
export const READ_ONLY_ANNOTATIONS: ToolAnnotationsV1 = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/**
 * Annotations for generic `mutate`. Conservative on purpose: the generic tool
 * covers every declared operation, so it must claim the weakest guarantees any
 * of them could have. `idempotentHint` is true because reusing an
 * `invocationId` replays rather than repeats — that is a property of the
 * invocation contract, not of any particular operation.
 */
export const MUTATE_ANNOTATIONS: ToolAnnotationsV1 = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
});

// ---------------------------------------------------------------------------
// The canonical mutate template
// ---------------------------------------------------------------------------

/** The kernel tool names. Fixed for the life of the contract. */
export const KERNEL_TOOL_NAMES = Object.freeze(
  ["describe", "query", "mutate"] as const,
);
export type KernelToolNameV1 = (typeof KERNEL_TOOL_NAMES)[number];

/** Arguments the caller must supply to complete a {@link MutateTemplateV1}. */
export const MUTATE_TEMPLATE_FILL_FIELDS = Object.freeze(
  ["target", "input", "invocationId"] as const,
);
export type MutateTemplateFillFieldV1 =
  (typeof MUTATE_TEMPLATE_FILL_FIELDS)[number];

/**
 * The exact canonical call for one operation, split into the part the server
 * already knows and the part only the caller can supply.
 *
 * A generated native alias (#542) is a derived view of this and nothing more:
 * an alias call lowers to precisely `{ ...arguments, ...filled }` on the
 * generic `mutate` tool, so there is no second executor, no second
 * authorization path, and no second receipt.
 *
 * `arguments.ifCatalog` is the catalog this card was projected from. Sending
 * it back is what closes the loop between discovery and action: the mutation
 * runs against the same catalog the agent read the card out of, or it is
 * refused with `catalog_changed`. A caller that would rather act against
 * whatever is current may drop it — it is a pin, not a credential.
 */
export const MutateTemplateV1 = Schema.Struct({
  tool: Schema.Literal("mutate").annotate({
    description: "Always the generic mutate tool. Aliases lower to it.",
  }),
  arguments: Schema.Struct({
    at: GraphPathV1,
    operation: OperationRefV1,
    ifCatalog: Schema.optionalKey(CatalogTokenV1),
  }).annotate({
    description:
      "Server-supplied arguments. Send them back exactly as given, including the operation version and, when present, the catalog this card was projected from.",
  }),
  fill: Schema.Array(Schema.Literals(MUTATE_TEMPLATE_FILL_FIELDS)).check(
    Schema.isMaxLength(MUTATE_TEMPLATE_FILL_FIELDS.length),
  ).annotate({
    description:
      "Arguments the caller must add: target when the operation targets a row, input when it declares one, and always invocationId.",
  }),
}).annotate({
  identifier: "MutateTemplateV1",
  description:
    "Canonical mutate call for this operation. Merge fill values into arguments and call mutate.",
});
export type MutateTemplateV1 = {
  readonly tool: "mutate";
  readonly arguments: {
    readonly at: GraphPathV1;
    readonly operation: OperationRefType;
    readonly ifCatalog?: CatalogTokenType;
  };
  readonly fill: readonly MutateTemplateFillFieldV1[];
};

/** Build the canonical template for one operation at one path. */
export const mutateTemplate = (input: {
  readonly at: GraphPathV1;
  readonly operation: OperationRefType;
  readonly target: OperationTargetModeV1;
  readonly hasInput: boolean;
  readonly ifCatalog?: CatalogTokenType | undefined;
}): MutateTemplateV1 =>
  Object.freeze({
    tool: "mutate",
    arguments: Object.freeze({
      at: Object.freeze([...input.at]),
      operation: input.operation,
      ...(input.ifCatalog === undefined ? {} : { ifCatalog: input.ifCatalog }),
    }),
    fill: Object.freeze([
      ...(input.target === "required" ? (["target"] as const) : []),
      ...(input.hasInput ? (["input"] as const) : []),
      "invocationId" as const,
    ]),
  });

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** One field of an entity or trait, as published. */
export const FieldCardV1 = Schema.Struct({
  name: PublicNameV1,
  description: Schema.optionalKey(CardDescription),
  schema: JsonSchemaV1.annotate({
    description: "JSON Schema 2020-12 root for this field's public value.",
  }),
  required: Schema.Boolean.annotate({
    description: "True when every row of the owner carries this field.",
  }),
}).annotate({
  identifier: "FieldCardV1",
  description: "One publicly readable field.",
});
export type FieldCardV1 = {
  readonly name: string;
  readonly description?: string;
  readonly schema: JsonSchemaV1;
  readonly required: boolean;
};

/**
 * The full card for one operation: everything needed to call it correctly on
 * the first attempt.
 */
export const OperationCardV1 = Schema.Struct({
  kind: Schema.Literal("operation").annotate({
    description: "Discriminator. Always \"operation\" for an operation card.",
  }),
  ref: OperationRefV1,
  title: Schema.optionalKey(CardTitle),
  description: Schema.optionalKey(CardDescription),
  target: Schema.Literals(OPERATION_TARGET_MODES).annotate({
    description:
      "required: the call must name a target row. none: the operation takes no target.",
  }),
  inputSchema: JsonSchemaV1.annotate({
    description:
      "JSON Schema 2020-12 root the mutate input must satisfy. Authored by the application.",
  }),
  outputSchema: JsonSchemaV1.annotate({
    description:
      "JSON Schema 2020-12 root the successful output satisfies.",
  }),
  annotations: ToolAnnotationsV1,
  mutateTemplate: MutateTemplateV1,
  resourceLink: Schema.optionalKey(ResourceLinkV1),
}).annotate({
  identifier: "OperationCardV1",
  description:
    "Complete, callable description of one operation version. Discovery only; never authority.",
});
export type OperationCardV1 = {
  readonly kind: "operation";
  readonly ref: OperationRefType;
  readonly title?: string;
  readonly description?: string;
  readonly target: OperationTargetModeV1;
  readonly inputSchema: JsonSchemaV1;
  readonly outputSchema: JsonSchemaV1;
  readonly annotations: ToolAnnotationsV1;
  readonly mutateTemplate: MutateTemplateV1;
  readonly resourceLink?: ResourceLinkType;
};

/** The full card for one entity or trait. */
export const DefinitionCardV1 = Schema.Struct({
  kind: Schema.Literal("definition").annotate({
    description:
      "Discriminator. Always \"definition\" for an entity or trait card.",
  }),
  ref: OwnerRefV1,
  title: Schema.optionalKey(CardTitle),
  description: Schema.optionalKey(CardDescription),
  traits: Schema.Array(PublicNameV1).check(
    Schema.isMaxLength(MAX_CARD_TRAITS),
  ).annotate({ description: "Traits this entity implements." }),
  fields: Schema.Array(FieldCardV1).check(
    Schema.isMaxLength(MAX_CARD_FIELDS),
  ).annotate({
    description:
      "Publicly readable fields of this definition, bounded and complete for this card.",
  }),
  operations: Schema.Array(OperationRefV1).check(
    Schema.isMaxLength(MAX_CARD_OPERATIONS),
  ).annotate({
    description:
      "Operations declared here. Drill down on one to get its full card.",
  }),
  resourceLink: Schema.optionalKey(ResourceLinkV1),
}).annotate({
  identifier: "DefinitionCardV1",
  description: "Complete description of one entity or trait.",
});
export type DefinitionCardV1 = {
  readonly kind: "definition";
  readonly ref: OwnerRefType;
  readonly title?: string;
  readonly description?: string;
  readonly traits: readonly string[];
  readonly fields: readonly FieldCardV1[];
  readonly operations: readonly OperationRefType[];
  readonly resourceLink?: ResourceLinkType;
};

/**
 * The card for one standard-library query function.
 *
 * Functions are a versioned deterministic allowlist over constants,
 * parameters, and already-filtered bound values (#507). A card publishes what
 * a caller may write, never how it is implemented: no engine alias, no
 * runtime symbol, no source.
 */
export const FunctionCardV1 = Schema.Struct({
  kind: Schema.Literal("function").annotate({
    description: "Discriminator. Always \"function\" for a query-function card.",
  }),
  ref: FunctionRefV1,
  title: Schema.optionalKey(CardTitle),
  description: Schema.optionalKey(CardDescription),
  arity: Schema.Struct({
    minimum: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: 64 }),
    ).annotate({ description: "Fewest arguments this function accepts." }),
    maximum: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: 64 }),
    ).annotate({ description: "Most arguments this function accepts." }),
  }).annotate({ description: "Inclusive bounds on the argument count." }),
  deterministic: Schema.Literal(true).annotate({
    description:
      "Always true. There is no non-deterministic function: no clock, no randomness, no ambient I/O.",
  }),
}).annotate({
  identifier: "FunctionCardV1",
  description:
    "One callable standard-library function in the query language's deterministic allowlist.",
});
export type FunctionCardV1 = {
  readonly kind: "function";
  readonly ref: FunctionRefType;
  readonly title?: string;
  readonly description?: string;
  readonly arity: { readonly minimum: number; readonly maximum: number };
  readonly deterministic: true;
};

/** The card for one reachable child graph. */
export const GraphCardV1 = Schema.Struct({
  kind: Schema.Literal("graph").annotate({
    description: "Discriminator. Always \"graph\" for a child-graph card.",
  }),
  name: PublicNameV1,
  title: Schema.optionalKey(CardTitle),
  description: Schema.optionalKey(CardDescription),
  at: GraphPathV1,
}).annotate({
  identifier: "GraphCardV1",
  description:
    "One child graph. Traversal uses only the at path returned here.",
});
export type GraphCardV1 = {
  readonly kind: "graph";
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly at: GraphPathV1;
};

/** Every full card an exact drill-down can return, discriminated by `kind`. */
export const CapabilityCardV1 = Schema.Union([
  GraphCardV1,
  DefinitionCardV1,
  OperationCardV1,
  FunctionCardV1,
]).annotate({
  identifier: "CapabilityCardV1",
  description:
    "The full description of one discovered capability, discriminated by kind.",
});
export type CapabilityCardV1 =
  | GraphCardV1
  | DefinitionCardV1
  | OperationCardV1
  | FunctionCardV1;

// ---------------------------------------------------------------------------
// Listing summaries
// ---------------------------------------------------------------------------

/** What a listing may return. Mirrors the card kinds plus fields. */
export const DISCOVERY_KINDS = Object.freeze(
  ["graph", "entity", "trait", "field", "operation", "function"] as const,
);
export type DiscoveryKindV1 = (typeof DISCOVERY_KINDS)[number];

/**
 * One listing entry: an exact reference plus just enough prose to choose.
 *
 * `ref` is always machine-addressable — a caller drills down by sending it
 * back verbatim, never by re-typing a name it read out of `title`.
 */
/**
 * One listing arm: a kind bound to the one reference shape it can carry.
 *
 * `kind` and `ref` were independent unions, which let a projection emit
 * `kind: "operation"` beside a `FunctionRefV1` and still validate. A client is
 * told `kind` identifies the family, so it would read `ref.owner` or resend the
 * value as an operation and get an invalid drill-down out of schema-valid
 * content. Binding them per arm makes that unrepresentable rather than merely
 * discouraged.
 */
const summaryArm = <Kind extends DiscoveryKindV1, Ref extends Schema.Top>(
  kind: Kind,
  ref: Ref,
  what: string,
) =>
  Schema.Struct({
    kind: Schema.Literal(kind).annotate({
      description: `Discriminator. "${kind}" means ref is ${what}.`,
    }),
    ref,
    title: Schema.optionalKey(CardTitle),
    description: Schema.optionalKey(CardDescription),
    at: GraphPathV1,
  });

export const CapabilitySummaryV1 = Schema.Union([
  summaryArm("graph", GraphRefV1, "a graph reference"),
  summaryArm("entity", EntityRefV1, "an entity reference"),
  summaryArm("trait", TraitRefV1, "a trait reference"),
  summaryArm("field", FieldRefV1, "a field reference"),
  summaryArm("operation", OperationRefV1, "an operation reference with its version"),
  summaryArm("function", FunctionRefV1, "a query-function reference"),
]).annotate({
  identifier: "CapabilitySummaryV1",
  description:
    "Compact listing entry, discriminated by kind: each kind carries exactly the reference shape that kind can be drilled down with. Send ref back as describe.ref for the complete card.",
});

type SummaryArm<Kind extends DiscoveryKindV1, Ref> = {
  readonly kind: Kind;
  readonly ref: Ref;
  readonly title?: string;
  readonly description?: string;
  readonly at: GraphPathV1;
};

export type CapabilitySummaryV1 =
  | SummaryArm<"graph", GraphRefType>
  | SummaryArm<"entity", EntityRefType>
  | SummaryArm<"trait", TraitRefType>
  | SummaryArm<"field", FieldRefType>
  | SummaryArm<"operation", OperationRefType>
  | SummaryArm<"function", FunctionRefType>;

/** Exact reference a caller may drill down on. */
export const DescribeRefV1 = Schema.Union([
  DefinitionRefV1,
  OperationRefV1,
  FunctionRefV1,
]).annotate({
  identifier: "DescribeRefV1",
  description:
    "Exact reference to describe. Operations require their version; a stale one is operation_changed.",
});
export type DescribeRefV1 =
  | DefinitionRefType
  | OperationRefType
  | FunctionRefType;
