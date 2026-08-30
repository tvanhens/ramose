/**
 * The one operation-scoped compatibility version (#487).
 *
 * `OperationVersion` is the full SHA-256 of a single operation's canonical
 * descriptor. Every consumer that has to decide whether an invocation minted
 * earlier is still the same operation — offline queues, invocation receipts,
 * operation references — compares this value and nothing else.
 *
 * ## What the canonical descriptor covers
 *
 * - the semantic operation identity: catalog key, owner kind/name, local name;
 * - the target mode (`required` / `none`) — the public interaction shape;
 * - the normalized semantic input and output contracts: the declared schema
 *   representation plus the lowered Ramose shape;
 * - the public precondition and allocation behavior: the admissible composer
 *   entity names for a targeted trait operation, and the declared write
 *   entity names;
 * - the author-declared executable revision.
 *
 * ## What it must never cover
 *
 * Catalog unit hashes, deployment or build-artifact identity, executable
 * source, unrelated definitions in the same catalog, grants and policies,
 * documentation, graph paths and database instances, and wire projections or
 * aliases. Deployment binding stays a separate private fence: it may still
 * refuse to *execute*, but it never participates in the compatibility
 * decision. Excluding executable source is why the revision exists — bump
 * `revision` to rotate an operation whose declared contract is unchanged but
 * whose behavior is not.
 */

import * as Effect from "effect/Effect";
import type { OperationInputShape } from "./catalog.ts";
import { hashDomainSeparatedCanonicalJson } from "./decode.ts";
import {
  OperationVersion,
  type CatalogId,
  type OperationTarget,
  type OwnerRef,
} from "./identities.ts";
import type { JsonValue } from "./json.ts";

const OPERATION_VERSION_DOMAIN_V1 = "ramose/operation-version/v1\0";

/** Canonical descriptor generation. Bumping it rotates every version. */
export const OPERATION_VERSION_DESCRIPTOR_VERSION = 1 as const;

/** Revision assumed when an operation does not declare one. */
export const DEFAULT_OPERATION_REVISION = 1;

/** One declared semantic contract: the wire representation and lowered shape. */
export type OperationContractMaterial = {
  readonly representation: JsonValue;
  readonly shape: OperationInputShape;
};

/** Exactly the inputs the canonical operation descriptor is allowed to see. */
export type OperationVersionDescriptor = {
  readonly catalog: CatalogId;
  readonly owner: OwnerRef;
  readonly localName: string;
  readonly target: OperationTarget;
  readonly revision: number;
  readonly input: OperationContractMaterial;
  readonly output: OperationContractMaterial;
  /** Entity types admitted as the target of a trait operation. */
  readonly composers: readonly string[];
  /** Entity definitions this operation may allocate or write. */
  readonly writes: readonly string[];
};

/**
 * An author-declared revision must be an ordinary positive integer. It is the
 * only way to rotate an operation whose declared contract did not change.
 */
export const requireOperationRevision = (
  value: unknown,
  label: string,
): number => {
  if (value === undefined) return DEFAULT_OPERATION_REVISION;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `ramose: ${label} revision must be a positive integer, not ${JSON.stringify(value)}`,
    );
  }
  return value;
};

const sortedNames = (names: readonly string[]): readonly string[] =>
  [...new Set(names)].sort();

/**
 * Canonical, deployment-free operation material. Construction is the
 * enforcement: nothing outside {@link OperationVersionDescriptor} can reach
 * the digest.
 */
export const operationVersionMaterial = (
  descriptor: OperationVersionDescriptor,
): JsonValue => ({
  version: OPERATION_VERSION_DESCRIPTOR_VERSION,
  operation: {
    catalog: descriptor.catalog,
    owner: { kind: descriptor.owner.kind, name: descriptor.owner.name },
    localName: descriptor.localName,
    target: descriptor.target,
  },
  revision: descriptor.revision,
  contract: {
    input: {
      representation: descriptor.input.representation,
      shape: descriptor.input.shape as unknown as JsonValue,
    },
    output: {
      representation: descriptor.output.representation,
      shape: descriptor.output.shape as unknown as JsonValue,
    },
  },
  behavior: {
    composers: [...sortedNames(descriptor.composers)],
    writes: [...sortedNames(descriptor.writes)],
  },
});

/** Hash one canonical operation descriptor into its branded version. */
export const hashOperationVersion = Effect.fn("Authorization.hashOperationVersion")(
  function* (descriptor: OperationVersionDescriptor) {
    const digest = yield* hashDomainSeparatedCanonicalJson(
      OPERATION_VERSION_DOMAIN_V1,
      operationVersionMaterial(descriptor),
    );
    return OperationVersion.make(digest);
  },
);
