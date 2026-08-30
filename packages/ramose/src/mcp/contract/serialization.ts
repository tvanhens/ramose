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
 * carry internal identity. It refuses, anywhere in a result:
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

/** Any 64-character lowercase hex run: the serialized form of every internal digest. */
const RAW_DIGEST_PATTERN = /[0-9a-f]{64}/;

const describePath = (path: readonly (string | number)[]): string =>
  path.length === 0 ? "<root>" : path.join(".");

/**
 * Refuse a public value that carries internal identity.
 *
 * Applied to whole tool results in the golden tests, and available to the
 * projection (#488) as the last check before a value becomes public.
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
