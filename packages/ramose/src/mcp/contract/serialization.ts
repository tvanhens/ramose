/**
 * Canonical serialization and the public seal (#485).
 *
 * ## Canonical form
 *
 * The contract does not invent a serialization. It reuses the engine's
 * existing RFC 8785 JCS profile (`rfc8785-jcs/1`), the same one that produces
 * operation versions and invocation digests. One profile means a value that
 * hashes equal internally serializes equal publicly, and there is no second
 * canonicalizer to keep in step.
 *
 * Canonical form is what makes the derived text representation deterministic,
 * what makes goldens meaningful, and what a future signed or cached
 * projection would be computed over.
 *
 * ## The seal
 *
 * {@link assertSealedPublicJson} is the mechanical form of the rule that
 * everything else in this module states in prose: a public result may not
 * carry internal identity. In a contract-owned position it refuses:
 *
 * - **raw digests** — any 64-character lowercase hex run, which is exactly the
 *   serialized form of every internal SHA-256 identity in the engine
 *   (`OperationVersion`, `PolicyHash`, `CatalogUnitHash`, scope and invocation
 *   digests, authorization digests);
 * - **internal property names** — database and entity ids, catalog keys, unit
 *   hashes, transaction and writer positions, storage locators, principal and
 *   scope identity, replay fences;
 * - **executable payloads** — source, ASTs, bytecode, or interpreter
 *   artifacts, which MCP must never receive, describe, store, or execute
 *   (#501);
 * - **reserved MCP argument names**, which the protocol would silently claim.
 *
 * It is a guard, not a sanitizer: it throws rather than quietly removing
 * something, because a result that contains internal identity is a bug in the
 * projection that produced it, and hiding it would only move the leak.
 *
 * ## Why the seal stops at application-owned members
 *
 * A public result is two different kinds of data wearing one shape. Most of it
 * the projection *constructs*: `ok`, `at`, `catalogToken`, `page`, `receipt`,
 * every reference and card member. A few members it merely *forwards* — an
 * operation card's schemas come from the engine's inert deployed-schema
 * projection of an author's own schema, a query row's `values` are the columns
 * the caller selected, and a mutation's `output` is whatever the operation's
 * codec produced.
 *
 * The names inside a forwarded subtree belong to the application author. An
 * ordinary domain model has a `source` column, a `database` entity, a `bucket`
 * field; an ordinary row carries a content hash that is 64 hex characters. A
 * blacklist applied there does not catch a leak — there is no projection code
 * in a forwarded subtree to have a bug — but it does reject the application's
 * own schema-valid data, permanently and with no workaround. A guard whose
 * only reachable effect is a false positive is worse than no guard.
 *
 * So the walk stops at {@link APPLICATION_OWNED_MEMBERS} and checks nothing
 * inside. That is safe because the seal is not the only check: schema
 * validation runs over the same result, every contract struct is
 * `additionalProperties: false`, and each of these member names has exactly
 * one home in the contract — the one being skipped. A stray `values` or
 * `output` cannot appear in a contract-owned position and be admitted.
 *
 * Author-written prose (`message`, `hint`) is deliberately *not* exempt. It is
 * a contract-owned position that happens to carry an author's words, and prose
 * that names an internal identifier is precisely the leak this exists to
 * catch. `receipts.ts` bounds and normalizes that prose before it gets here.
 */

import { canonicalizeJson } from "../../internal/authorization/canonical-json.ts";
import type { JsonValue } from "../../internal/authorization/json.ts";
import { RESERVED_MRTR_ARGUMENT_NAMES } from "./json-schema.ts";

/** The canonical JSON profile every public value is serialized under. */
export const CONTRACT_CANONICAL_JSON_VERSION = "rfc8785-jcs/1" as const;

/**
 * Refuse a value the canonical writer is not allowed to see.
 *
 * The engine's canonicalizer documents that its callers have already rejected
 * non-finite numbers and non-JSON values — it is fed schema-validated data.
 * Here the input is a projection's freshly built result, so this boundary does
 * that rejection rather than assuming it: a `NaN` or an `undefined` member
 * must be a loud failure, not a value that serializes one way for the wire and
 * another way for a digest.
 */
const assertContractJson = (
  value: unknown,
  path: readonly (string | number)[],
): void => {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `ramose/mcp: ${
            describePath(path)
          } is not a JSON number; a public value must be finite`,
        );
      }
      return;
    case "object":
      break;
    default:
      throw new TypeError(
        `ramose/mcp: ${describePath(path)} is not JSON data (${typeof value})`,
      );
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertContractJson(child, [...path, index]));
    return;
  }
  for (const [key, child] of Object.entries(value as object)) {
    assertContractJson(child, [...path, key]);
  }
};

/**
 * Serialize a public value to its canonical form.
 *
 * Rejects anything that is not JSON — no `undefined`, no `NaN`, no functions —
 * so a value that cannot be canonically serialized can never reach the wire in
 * some other, uncomparable shape.
 */
export const canonicalizeContractJson = (value: JsonValue): string => {
  assertContractJson(value, []);
  return canonicalizeJson(value);
};

/**
 * Property names that name engine-internal identity. A public result that
 * carries one of these is leaking implementation, whatever its value is.
 */
export const SEALED_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  // Database and entity identity.
  "eid",
  "entityId",
  "databaseId",
  "database",
  "referenceEid",
  // Catalog and deployment identity.
  "catalogId",
  "catalogKey",
  "catalogVersion",
  "unitHash",
  "catalogUnitHash",
  "deploymentId",
  "schemaFingerprint",
  // Writer and transaction position.
  "committedT",
  "basisT",
  "txId",
  "transactionId",
  // Authorization and receipt internals.
  "principalId",
  "scopeDigest",
  "invocationDigest",
  "authorizationDigest",
  "authorizationReadSet",
  "operationVersionDigest",
  "policyHash",
  "ruleId",
  "replayFence",
  "consumedRefs",
  // Storage locators.
  "storageKey",
  "objectKey",
  "r2Key",
  "bucket",
  // Executable artifacts.
  "source",
  "ast",
  "bytecode",
  "executable",
  "run",
  // Protocol-reserved argument names.
  ...RESERVED_MRTR_ARGUMENT_NAMES,
]);

/**
 * Members whose subtree is authored by the application, not by this contract.
 *
 * Each name has exactly one home in the contract, and that home is the one
 * listed here — so skipping the subtree cannot also skip a contract-owned
 * position of the same name. See the module docs for why the seal stops here.
 */
export const APPLICATION_OWNED_MEMBERS: ReadonlySet<string> = new Set([
  /** `OperationCardV1.inputSchema` — the author's own schema, as deployed. */
  "inputSchema",
  /** `OperationCardV1.outputSchema` — likewise. */
  "outputSchema",
  /** `FieldCardV1.schema` — the author's schema for one field's value. */
  "schema",
  /** `QueryRowV1.values` — the columns the caller's own query selected. */
  "values",
  /** `MutateSuccessV1.output` — what the operation's own codec produced. */
  "output",
  /** `MutateInputV1.input` — arguments the caller wrote for the operation. */
  "input",
]);

/** Any 64-character lowercase hex run: the serialized form of every internal digest. */
const RAW_DIGEST_PATTERN = /[0-9a-f]{64}/;

const describePath = (path: readonly (string | number)[]): string =>
  path.length === 0 ? "<root>" : path.join(".");

/**
 * Refuse a public value whose contract-owned positions carry internal
 * identity.
 *
 * Applied to whole tool results in the golden tests, and available to the
 * projection (#488) as the last check before a value becomes public.
 * Application-owned subtrees are treated as opaque and are not inspected.
 */
export const assertSealedPublicJson = (
  value: JsonValue,
  label = "public result",
): void => {
  const visit = (node: unknown, path: readonly (string | number)[]): void => {
    if (typeof node === "string") {
      if (RAW_DIGEST_PATTERN.test(node)) {
        throw new TypeError(
          `ramose/mcp: ${label} exposes a raw internal digest at ${
            describePath(path)
          }`,
        );
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, [...path, index]));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, child] of Object.entries(node)) {
      if (SEALED_PROPERTY_NAMES.has(key)) {
        throw new TypeError(
          `ramose/mcp: ${label} exposes the internal property "${key}" at ${
            describePath(path)
          }`,
        );
      }
      // The member name is contract-owned and checked above; its contents are
      // the application's, so the walk stops rather than judging them.
      if (APPLICATION_OWNED_MEMBERS.has(key)) continue;
      visit(child, [...path, key]);
    }
  };
  visit(value, []);
};

/** Canonicalize and seal in one step, for a value about to become public. */
export const sealPublicJson = (
  value: JsonValue,
  label = "public result",
): string => {
  assertSealedPublicJson(value, label);
  return canonicalizeContractJson(value);
};
