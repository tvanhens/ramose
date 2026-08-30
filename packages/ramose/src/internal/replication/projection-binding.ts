/**
 * Native projection binding and explicit projection identity (#476 slice 1).
 *
 * A durable layer names an operation and a projection *identity*. On restart
 * the callback is resolved from the installed client bundle by that name, and
 * the identity decides whether replaying it is honest.
 *
 * Nothing here derives identity from a callback. There is no
 * `Function.prototype.toString`, no source hash, no AST, and no interpreter:
 * the revision is author-declared and the build is bundle-declared, both inert
 * data. Durable state may hold operation identity, that projection identity,
 * validated input, `EntityId` / `ClientRef` values, declared allocation-slot
 * references, and speculative bookkeeping — never callback source, bytecode, or
 * interpreter artifacts.
 *
 * ## Independent of everything else that rotates
 *
 * Projection identity is independent of replication `readView`, the client and
 * server `readCompatibilityHash`, Worker deployment identity, and #487's
 * `OperationVersion`. The revision is deliberately *outside* the canonical
 * operation descriptor: if bumping it rotated `OperationVersion`, editing a
 * projection would revoke every already-queued invocation's right to submit,
 * and a projection-only client change would invalidate the committed replica.
 * It does neither.
 */

import {
  normalizeProjectionRevision,
  type AnyOptimisticProjection,
} from "../../db/Projection.ts";
import type { QueuedOperation } from "./outbox.ts";

/** Longest accepted client build identity, in UTF-16 code units. */
const MAX_BUILD_LENGTH = 256;

/** Any Unicode control character: a build id has to survive a durable key. */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/**
 * The explicit identity of one projection implementation.
 *
 * `revision` is the author's statement about behavior: bump it when the
 * projection no longer means what it meant. `build` names the installed client
 * bundle the callback came from, so a durable layer records which build
 * produced it.
 */
export type ProjectionIdentity = {
  readonly revision: number;
  readonly build: string;
};

/** Why a durable layer cannot be replayed against the installed bundle. */
export type ProjectionDriftReason =
  /** The installed bundle no longer declares this operation at all. */
  | "operation-missing"
  /** The operation is installed, but it no longer declares a projection. */
  | "projection-missing"
  /** The author rotated the projection's revision. */
  | "projection-revision";

/**
 * The decision, for one durable layer, before anything is replayed.
 *
 * `none` is not a failure: the invocation was queued by a build that declared
 * no projection for it, so it never had a layer, and reconstructing none is
 * exactly what "the same speculative view" means for that record.
 */
export type ProjectionBinding =
  | { readonly type: "none" }
  | {
    readonly type: "bound";
    readonly identity: ProjectionIdentity;
    /**
     * The same revision from a different build. The author has said the
     * behavior did not change, so this replays — it is reported only so a
     * caller can see that the bundle moved underneath a durable layer.
     */
    readonly rebound: boolean;
    readonly run: AnyOptimisticProjection;
  }
  | { readonly type: "update-required"; readonly reason: ProjectionDriftReason };

/** One installed operation, paired with the projection callback it declares. */
export type InstalledProjection = {
  readonly operation: QueuedOperation;
  /** `undefined` when the installed operation declares no projection. */
  readonly projection:
    | { readonly revision: number; readonly run: AnyOptimisticProjection }
    | undefined;
};

/** The installed client bundle's projections, keyed by operation identity. */
export type ClientProjectionCatalog = {
  readonly build: string;
  readonly entries: ReadonlyMap<string, InstalledProjection>;
};

const invalid = (detail: string): never => {
  throw new Error(`ramose/projection: ${detail}`);
};

/**
 * The permanent semantic name of one operation, as a map key.
 *
 * JSON-encoded rather than delimiter-joined: an owner literally named `a\0b`
 * must not collide with the pair `a` then `b`, for the same reason an
 * allocation path key is JSON.
 */
export const projectionOperationKey = (operation: QueuedOperation): string =>
  JSON.stringify([
    operation.catalog,
    operation.owner.kind,
    operation.owner.name,
    operation.localName,
  ]);

/**
 * A build identity is opaque to Ramose, but it has to survive a durable record
 * and a map key, so control characters and unbounded text are refused here
 * rather than discovered on a later restart.
 */
export const projectionBuild = (value: unknown): string => {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > MAX_BUILD_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    invalid(
      "a client build identity must be non-empty printable text of at most 256 characters",
    );
  }
  return value as string;
};

export const projectionIdentity = (
  build: unknown,
  revision?: unknown,
): ProjectionIdentity =>
  Object.freeze({
    revision: normalizeProjectionRevision(revision),
    build: projectionBuild(build),
  });

export const sameProjectionIdentity = (
  left: ProjectionIdentity,
  right: ProjectionIdentity,
): boolean =>
  left.revision === right.revision && left.build === right.build;

/**
 * Pair the inert operation/projection descriptors with the original callbacks
 * from one installed build. Every entry in one catalog is from the same
 * bundle, which is what {@link ProjectionIdentity.build} records.
 */
export const makeClientProjectionCatalog = (
  build: string,
  installed: readonly InstalledProjection[],
): ClientProjectionCatalog => {
  const entries = new Map<string, InstalledProjection>();
  for (const entry of installed) {
    const key = projectionOperationKey(entry.operation);
    if (entries.has(key)) {
      invalid(`two installed operations share the identity ${key}`);
    }
    if (entry.projection !== undefined) {
      if (typeof entry.projection.run !== "function") {
        invalid(`${key} declares a projection that is not a function`);
      }
      normalizeProjectionRevision(entry.projection.revision);
    }
    entries.set(key, entry);
  }
  return Object.freeze({
    build: projectionBuild(build),
    entries,
  });
};

/** The durable half of the decision: what a stored layer says about itself. */
export type StoredProjection = {
  readonly operation: QueuedOperation;
  /** `null` when the record was queued without a projection. */
  readonly projection: ProjectionIdentity | null;
};

/**
 * The total decision table. A missing or mismatched projection identity is the
 * typed update-required state; it never executes incompatible code, and it
 * never silently drops the layer.
 */
export const resolveProjectionBinding = (
  catalog: ClientProjectionCatalog,
  stored: StoredProjection,
): ProjectionBinding => {
  if (stored.projection === null) return NONE;
  const entry = catalog.entries.get(projectionOperationKey(stored.operation));
  if (entry === undefined) return drift("operation-missing");
  const installed = entry.projection;
  if (installed === undefined) return drift("projection-missing");
  if (installed.revision !== stored.projection.revision) {
    return drift("projection-revision");
  }
  return Object.freeze({
    type: "bound" as const,
    identity: Object.freeze({
      revision: installed.revision,
      build: catalog.build,
    }),
    rebound: catalog.build !== stored.projection.build,
    run: installed.run,
  });
};

const NONE = Object.freeze({ type: "none" as const }) as ProjectionBinding;

const drift = (reason: ProjectionDriftReason): ProjectionBinding =>
  Object.freeze({ type: "update-required" as const, reason });
