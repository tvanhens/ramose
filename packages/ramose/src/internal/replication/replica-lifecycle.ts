import * as Data from "effect/Data";
import { REPLICA_STORAGE_VERSION, type ReplicationIdentity } from "./protocol.ts";

export const REPLICA_GENERATIONS_STORE = "replica-generations-v1";

/**
 * The durable counter every scope clear advances, and the record an activation
 * reads before it has a principal to name a scope with.
 *
 * A tab that has not authenticated yet cannot fence on a scope generation: it
 * does not know which scope it is activating into until the server answers. It
 * records this counter instead, and the clear that lands while it waits stamps
 * the cleared scope with the value it advanced to, so the install transaction
 * can tell an activation that began before the clear from one that began after
 * it without either side having enrolled.
 */
export const REPLICA_CLEAR_BARRIER_KEY = "ramose-replica-clear-barrier-v1";

export const REPLICA_COMMITTED_HEADS_STORE = "replica-committed-heads-v1";

export type ReplicaScope = {
  readonly server: string;
  readonly principal: string;
};

export type ReplicaDatabaseScope = ReplicaScope & {
  readonly database: string;
};

export const replicaScopeOf = (identity: ReplicationIdentity): ReplicaScope => ({
  server: identity.server,
  principal: identity.principal,
});

export const replicaDatabaseScopeOf = (
  identity: ReplicationIdentity,
): ReplicaDatabaseScope => ({
  server: identity.server,
  principal: identity.principal,
  database: identity.database,
});

export const REPLICA_LIFECYCLE_KEY_VERSION = 2 as const;

export const replicaScopeKey = (scope: ReplicaScope): string =>
  [
    `ramose-replica-scope-v${REPLICA_LIFECYCLE_KEY_VERSION}`,
    scope.server,
    scope.principal,
  ].join(":");

export const replicaDatabaseKey = (scope: ReplicaDatabaseScope): string =>
  [
    `ramose-replica-database-v${REPLICA_LIFECYCLE_KEY_VERSION}`,
    scope.server,
    scope.principal,
    scope.database,
  ].join(":");

export const replicaPartitionKey = (identity: ReplicationIdentity): string =>
  [
    `ramose-replica-v${REPLICA_STORAGE_VERSION}`,
    identity.server,
    identity.principal,
    identity.database,
    identity.readView,
    identity.readCompatibilityHash,
  ].join(":");

export const replicaPartitionScopeKey = (partition: string): string | undefined => {
  const parts = partition.split(":");
  if (parts.length !== 6 || parts[0] !== `ramose-replica-v${REPLICA_STORAGE_VERSION}`) {
    return undefined;
  }
  return replicaScopeKey({ server: parts[1], principal: parts[2] });
};

export const replicaScopePartitionPrefix = (scope: ReplicaScope): string =>
  [`ramose-replica-v${REPLICA_STORAGE_VERSION}`, scope.server, scope.principal, ""]
    .join(":");

export const replicaDatabasePartitionPrefix = (
  scope: ReplicaDatabaseScope,
): string =>
  [
    `ramose-replica-v${REPLICA_STORAGE_VERSION}`,
    scope.server,
    scope.principal,
    scope.database,
    "",
  ].join(":");

export const identityInScope = (
  identity: ReplicationIdentity,
  scope: ReplicaScope,
): boolean =>
  identity.server === scope.server && identity.principal === scope.principal;

export const identityInDatabase = (
  identity: ReplicationIdentity,
  scope: ReplicaDatabaseScope,
): boolean =>
  identityInScope(identity, scope) && identity.database === scope.database;

export const withConfirmedScope = (
  scopes: readonly string[] | undefined,
  scope: string,
): readonly string[] =>
  scopes === undefined
    ? [scope]
    : scopes.includes(scope)
      ? scopes
      : [...scopes, scope].sort();

export const withoutConfirmedScope = (
  scopes: readonly string[] | undefined,
  scope: string,
): readonly string[] => (scopes ?? []).filter((entry) => entry !== scope);

export class ReplicaScopeUnconfirmedError extends Data.TaggedError(
  "ReplicaScopeUnconfirmedError",
)<{ readonly scope: string }> {}

export class ReplicaFencedError extends Data.TaggedError(
  "ReplicaFencedError",
)<{
  readonly key: string;
  readonly expected: number;
  readonly observed: number;
}> {}

export class ReplicaScopeClearedError extends Data.TaggedError(
  "ReplicaScopeClearedError",
)<{ readonly scope: string }> {}

export class ReplicaDatabaseActiveError extends Data.TaggedError(
  "ReplicaDatabaseActiveError",
)<{ readonly database: string; readonly pins: number }> {}

/** Whether a scope this holder was reading has been withdrawn under it. */
export const isReplicaFenceError = (error: unknown): boolean => {
  const tag = (error as { readonly _tag?: unknown } | undefined)?._tag;
  return tag === "ReplicaFencedError" || tag === "ReplicaScopeClearedError";
};

export type ReplicaFenceDecision = "adopt" | "match" | "fenced";

export const replicaFenceDecision = (
  observed: number | undefined,
  current: number,
): ReplicaFenceDecision =>
  observed === undefined ? "adopt" : observed === current ? "match" : "fenced";

export class ReplicaLease {
  private readonly observed = new Map<string, number>();

  /**
   * @param admission the clear barrier this holder was admitted at, which is
   * the barrier its activation read before it could name a scope.
   */
  constructor(private readonly admission: number = 0) {}

  /**
   * Refuse a holder admitted before the clear that stamped `clearedAt` on the
   * scope it is writing into.
   */
  admit(key: string, clearedAt: number): void {
    if (clearedAt <= this.admission) return;
    throw new ReplicaFencedError({
      key,
      expected: this.admission,
      observed: clearedAt,
    });
  }

  admittedAt(): number {
    return this.admission;
  }

  observe(key: string, current: number): void {
    const decision = replicaFenceDecision(this.observed.get(key), current);
    if (decision === "fenced") {
      throw new ReplicaFencedError({
        key,
        expected: this.observed.get(key)!,
        observed: current,
      });
    }
    if (decision === "adopt") this.observed.set(key, current);
  }

  adopt(key: string, current: number): void {
    this.observed.set(key, current);
  }

  generationOf(key: string): number | undefined {
    return this.observed.get(key);
  }
}
