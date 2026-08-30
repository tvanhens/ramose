/**
 * Public typed references (#485).
 *
 * A public reference is exactly two things: the semantic name the application
 * author chose, and — where compatibility depends on it — one opaque public
 * version. Nothing else. A reference is *machine-addressable*: a caller that
 * holds one can name the same definition again without guessing, while fuzzy
 * search text is only ever discovery input and never addresses anything.
 *
 * ## The operation version
 *
 * `OperationRefV1.version` is the sole compatibility fence for a mutation. It
 * is the public projection of the merged operation-scoped `OperationVersion`
 * primitive (#487) — the SHA-256 of exactly one operation's canonical
 * descriptor — and nothing else. This module does not compute a version, does
 * not define what goes into one, and does not mint a parallel digest: it only
 * re-encodes the one existing value into an opaque public token and back.
 *
 * The re-encoding is deliberate. The token is unpadded base64url behind an
 * `ov_` prefix, so it is structurally *not* a hex digest and cannot be
 * mistaken for, compared against, or silently substituted with an internal
 * identifier on the wire. It is a bijection: two operations share a token if
 * and only if they share an `OperationVersion`, which is what makes
 * `operation_changed` decidable at the boundary.
 *
 * Possession of a version grants nothing. Authorization is revalidated
 * independently, and deployment binding remains a separate private fence that
 * never participates in this public compatibility decision.
 */

import * as Schema from "effect/Schema";
import { OperationVersion } from "../../internal/authorization/identities.ts";
import {
  MAX_FUNCTION_NAMESPACE_LENGTH,
  MAX_PUBLIC_NAME_LENGTH,
} from "./bounds.ts";
import { OPERATION_VERSION_PREFIX } from "./primitives.ts";

// ---------------------------------------------------------------------------
// Semantic names
// ---------------------------------------------------------------------------

/**
 * A public semantic name. Application authors choose these; they are the same
 * names that appear in the application's own source, which is what lets an
 * agent connect a discovered capability to the domain it is reasoning about.
 */
export const PublicNameV1 = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PUBLIC_NAME_LENGTH),
).annotate({
  identifier: "PublicNameV1",
  description: "Semantic, application-chosen name. Never an internal identifier.",
});

/** Definition families a public reference can name. */
export const OWNER_KINDS = Object.freeze(["entity", "trait"] as const);
export type OwnerKindV1 = (typeof OWNER_KINDS)[number];

/**
 * The owner of a field or operation. Mirrors the engine's `OwnerRef` shape
 * (`{ kind, name }`) so the projection is a rename-free copy.
 */
export const OwnerRefV1 = Schema.Struct({
  kind: Schema.Literals(OWNER_KINDS).annotate({
    description: "Whether the owner is an entity or a trait.",
  }),
  name: PublicNameV1,
}).annotate({
  identifier: "OwnerRefV1",
  description: "The entity or trait that owns a field or an operation.",
});
export type OwnerRefV1 = {
  readonly kind: OwnerKindV1;
  readonly name: string;
};

/** Reference to one entity definition. */
export const EntityRefV1 = Schema.Struct({
  kind: Schema.Literal("entity").annotate({
    description: "Discriminator. Always \"entity\" — this reference names an entity definition.",
  }),
  name: PublicNameV1,
}).annotate({
  identifier: "EntityRefV1",
  description: "Reference to one entity definition by its semantic name.",
});
export type EntityRefV1 = { readonly kind: "entity"; readonly name: string };

/** Reference to one trait definition. */
export const TraitRefV1 = Schema.Struct({
  kind: Schema.Literal("trait").annotate({
    description: "Discriminator. Always \"trait\" — this reference names a trait definition.",
  }),
  name: PublicNameV1,
}).annotate({
  identifier: "TraitRefV1",
  description: "Reference to one trait definition by its semantic name.",
});
export type TraitRefV1 = { readonly kind: "trait"; readonly name: string };

/** Reference to one field of an entity or trait. */
export const FieldRefV1 = Schema.Struct({
  kind: Schema.Literal("field").annotate({
    description: "Discriminator. Always \"field\" — this reference names one field of an owner.",
  }),
  owner: OwnerRefV1,
  name: PublicNameV1,
}).annotate({
  identifier: "FieldRefV1",
  description: "Reference to one field, qualified by the owner that declares it.",
});
export type FieldRefV1 = {
  readonly kind: "field";
  readonly owner: OwnerRefV1;
  readonly name: string;
};

/** Reference to one graph reachable from the caller's authorized root. */
export const GraphRefV1 = Schema.Struct({
  kind: Schema.Literal("graph").annotate({
    description: "Discriminator. Always \"graph\" — this reference names a child graph.",
  }),
  name: PublicNameV1,
}).annotate({
  identifier: "GraphRefV1",
  description:
    "Reference to one child graph. Traverse to it by appending its name to at.",
});
export type GraphRefV1 = { readonly kind: "graph"; readonly name: string };

// ---------------------------------------------------------------------------
// Operation references and the public operation version
// ---------------------------------------------------------------------------

const OPERATION_VERSION_TOKEN_BODY_LENGTH = 43;

/**
 * The opaque public operation-scoped compatibility version.
 *
 * Treat it as a string with no structure. It rotates when — and only when —
 * that one operation's own public contract or author-declared revision
 * changes; unrelated catalog edits, grants, documentation, redeployments, and
 * graph instances never rotate it.
 */
export const OperationVersionTokenV1 = Schema.String.check(
  Schema.isPattern(
    new RegExp(
      `^${OPERATION_VERSION_PREFIX}[A-Za-z0-9_-]{${OPERATION_VERSION_TOKEN_BODY_LENGTH}}$`,
    ),
  ),
).annotate({
  identifier: "OperationVersionTokenV1",
  description:
    "Opaque operation-scoped compatibility version. Send back exactly the value discovery returned; a stale value is operation_changed, never a silent reinterpretation.",
});
export type OperationVersionTokenV1 = string;

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Encode raw bytes as unpadded base64url without depending on `btoa` quirks. */
const encodeBase64Url = (bytes: Uint8Array): string => {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const b0 = bytes[index]!;
    const b1 = remaining > 1 ? bytes[index + 1]! : 0;
    const b2 = remaining > 2 ? bytes[index + 2]! : 0;
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (remaining > 1) out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (remaining > 2) out += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
};

/** Decode unpadded base64url back to bytes, or `undefined` if it is not. */
const decodeBase64Url = (value: string): Uint8Array | undefined => {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) return undefined;
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  // Unpadded base64url may leave at most 4 unused bits, and they must be zero.
  if (bits >= 6 || (accumulator & ((1 << bits) - 1)) !== 0) return undefined;
  return Uint8Array.from(bytes);
};

/**
 * Project the merged {@link OperationVersion} into its opaque public token.
 *
 * This is a re-encoding of one existing value, not a new digest: no material
 * beyond the operation version enters it.
 */
export const encodeOperationVersionToken = (
  version: OperationVersion,
): OperationVersionTokenV1 => {
  if (!HEX_DIGEST_PATTERN.test(version)) {
    throw new TypeError(
      "ramose/mcp: operation version must be a canonical operation-scoped version",
    );
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number.parseInt(version.slice(index * 2, index * 2 + 2), 16);
  }
  return `${OPERATION_VERSION_PREFIX}${encodeBase64Url(bytes)}`;
};

/**
 * Recover the {@link OperationVersion} a caller pinned, or `undefined` when
 * the token is not a well-formed public version.
 *
 * A malformed token is an ordinary `invalid_input`; only a well-formed token
 * that no longer matches the deployed operation is `operation_changed`.
 */
export const decodeOperationVersionToken = (
  token: string,
): OperationVersion | undefined => {
  if (
    typeof token !== "string" ||
    !token.startsWith(OPERATION_VERSION_PREFIX)
  ) return undefined;
  const body = token.slice(OPERATION_VERSION_PREFIX.length);
  if (body.length !== OPERATION_VERSION_TOKEN_BODY_LENGTH) return undefined;
  const bytes = decodeBase64Url(body);
  if (bytes === undefined || bytes.length !== 32) return undefined;
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return OperationVersion.make(hex);
};

/** How a targeted operation is addressed. Mirrors the engine's target mode. */
export const OPERATION_TARGET_MODES = Object.freeze(
  ["required", "none"] as const,
);
export type OperationTargetModeV1 = (typeof OPERATION_TARGET_MODES)[number];

/**
 * Reference to exactly one version of one operation.
 *
 * `version` is required on every `mutate`. An absent or stale version is
 * refused *before* any effect: a mutation is never executed against an
 * operation the caller did not mean.
 */
export const OperationRefV1 = Schema.Struct({
  owner: OwnerRefV1,
  name: PublicNameV1,
  version: OperationVersionTokenV1,
}).annotate({
  identifier: "OperationRefV1",
  description:
    "Exact, machine-addressable reference to one version of one operation. Send back exactly what discovery returned; mutate refuses an absent or stale version before any effect.",
});
export type OperationRefV1 = {
  readonly owner: OwnerRefV1;
  readonly name: string;
  readonly version: OperationVersionTokenV1;
};

/** True when two operation references name the same operation and version. */
export const sameOperationRef = (
  left: OperationRefV1,
  right: OperationRefV1,
): boolean =>
  left.owner.kind === right.owner.kind &&
  left.owner.name === right.owner.name &&
  left.name === right.name &&
  left.version === right.version;

// ---------------------------------------------------------------------------
// Query-language function references
// ---------------------------------------------------------------------------

/**
 * A namespaced query-language function, as published to callers.
 *
 * The namespace and name are the *public* names of a versioned deterministic
 * allowlist entry (#507). They are never an engine alias, an internal
 * function symbol, or anything a caller could use to reach host execution.
 */
export const FunctionRefV1 = Schema.Struct({
  namespace: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_FUNCTION_NAMESPACE_LENGTH),
    Schema.isPattern(/^[a-z][a-z0-9]*$/),
  ).annotate({
    description: "Public function namespace, for example text or logic.",
  }),
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_PUBLIC_NAME_LENGTH),
    Schema.isPattern(/^[a-z][a-zA-Z0-9]*$/),
  ).annotate({ description: "Public function name within its namespace." }),
}).annotate({
  identifier: "FunctionRefV1",
  description:
    "Reference to one standard-library query function. Written on the wire as namespace.name, for example text.lower.",
});
export type FunctionRefV1 = {
  readonly namespace: string;
  readonly name: string;
};

/** Canonical wire spelling of a function reference: `namespace.name`. */
export const functionRefName = (ref: FunctionRefV1): string =>
  `${ref.namespace}.${ref.name}`;

// ---------------------------------------------------------------------------
// The definition reference union
// ---------------------------------------------------------------------------

/**
 * Every non-operation definition a caller can address. `kind` is the sole
 * discriminator, so a client can dispatch without inspecting other members.
 */
export const DefinitionRefV1 = Schema.Union([
  GraphRefV1,
  EntityRefV1,
  TraitRefV1,
  FieldRefV1,
]).annotate({
  identifier: "DefinitionRefV1",
  description:
    "Exact reference to one graph, entity, trait, or field, discriminated by kind.",
});
export type DefinitionRefV1 =
  | GraphRefV1
  | EntityRefV1
  | TraitRefV1
  | FieldRefV1;
