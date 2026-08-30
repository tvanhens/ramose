import {
  normalizeProjectionRevision,
  type AnyOptimisticProjection,
} from "../../db/Projection.ts";
import type { QueuedOperation } from "./outbox.ts";

const MAX_BUILD_LENGTH = 256;

const CONTROL_CHARACTERS = /\p{Cc}/u;

export type ProjectionIdentity = {
  readonly revision: number;
  readonly build: string;
};

export type ProjectionDriftReason =
  | "operation-missing"
  | "projection-missing"
  | "projection-revision";

export type ProjectionBinding =
  | { readonly type: "none" }
  | {
    readonly type: "bound";
    readonly identity: ProjectionIdentity;
    readonly rebound: boolean;
    readonly run: AnyOptimisticProjection;
  }
  | { readonly type: "update-required"; readonly reason: ProjectionDriftReason };

export type InstalledProjection = {
  readonly operation: QueuedOperation;
  readonly projection:
    | { readonly revision: number; readonly run: AnyOptimisticProjection }
    | undefined;
};

export type ClientProjectionCatalog = {
  readonly build: string;
  readonly entries: ReadonlyMap<string, InstalledProjection>;
};

const invalid = (detail: string): never => {
  throw new Error(`ramose/projection: ${detail}`);
};

export const projectionOperationKey = (operation: QueuedOperation): string =>
  JSON.stringify([
    operation.catalog,
    operation.owner.kind,
    operation.owner.name,
    operation.localName,
  ]);

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
    if (entry.projection === undefined) {
      entries.set(key, entry);
      continue;
    }
    if (typeof entry.projection.run !== "function") {
      invalid(`${key} declares a projection that is not a function`);
    }
    entries.set(key, Object.freeze({
      operation: entry.operation,
      projection: Object.freeze({
        revision: normalizeProjectionRevision(entry.projection.revision),
        run: entry.projection.run,
      }),
    }));
  }
  return Object.freeze({
    build: projectionBuild(build),
    entries,
  });
};

export type StoredProjection = {
  readonly operation: QueuedOperation;
  readonly projection: ProjectionIdentity | null;
};

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
