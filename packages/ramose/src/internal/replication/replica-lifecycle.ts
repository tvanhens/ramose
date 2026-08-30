/**
 * Same-realm lifecycle fencing for the persisted browser replica (#474 slice 8).
 *
 * Destructive local maintenance — the storage semantics behind the frozen
 * `client.clearLocalData()` contract, and scoped eviction of one stable graph
 * database — must never race a live replication session. Two rules make that
 * decidable without any cross-tab coordination:
 *
 * 1. **Durable generations.** One monotonic generation record guards each
 *    server/principal scope, and one guards each stable graph database inside
 *    it. The records live in an ordinary IndexedDB store, so every write path
 *    can read them inside the very transaction that installs data. Clearing a
 *    scope bumps the scope record; evicting a database bumps only that
 *    database's record, leaving its ancestors and siblings running. #478
 *    extends exactly these records into the all-tab barrier; BroadcastChannel
 *    stays notification only.
 * 2. **In-process leases.** A session holds a {@link ReplicaLease}. The first
 *    fenced write adopts whatever generation the durable record carries, and
 *    every later write of that lease must observe the same generation or be
 *    refused. A session therefore cannot write old-generation data after a
 *    clear or eviction begins, whichever tab performed the bump.
 *
 * Selection is deliberately narrow. Only an opaque server-confirmed
 * `ReplicationIdentity` names a scope; `cacheKey`, bearer text, path text, and
 * unconfirmed candidates never do. Everything here is pure, so the selection
 * and fence decisions are ordinary unit-testable values.
 */

import * as Data from "effect/Data";
import { REPLICA_STORAGE_VERSION, type ReplicationIdentity } from "./protocol.ts";

/**
 * The durable generation store. Named here rather than in the storage adapter
 * because every family that must be fenced — the committed replica and, since
 * #475, the mutation queue — names the same store inside its own write.
 */
export const REPLICA_GENERATIONS_STORE = "replica-generations-v1";

/** One server/authenticated-principal realm. Both halves are server-minted. */
export type ReplicaScope = {
  readonly server: string;
  readonly principal: string;
};

/** One stable graph database inside a scope, across every read view it has. */
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

/** Durable key of the generation record guarding one scope. */
export const replicaScopeKey = (scope: ReplicaScope): string =>
  [
    `ramose-replica-scope-v${REPLICA_STORAGE_VERSION}`,
    scope.server,
    scope.principal,
  ].join(":");

/** Durable key of the generation record guarding one stable graph database. */
export const replicaDatabaseKey = (scope: ReplicaDatabaseScope): string =>
  [
    `ramose-replica-database-v${REPLICA_STORAGE_VERSION}`,
    scope.server,
    scope.principal,
    scope.database,
  ].join(":");

/**
 * Partition key of one committed replica. Every partitioned store family keys
 * its records by this string (alone, or as the first element of a compound
 * key), so a scope or a database selects its records by an ordinary prefix
 * range. Components are fixed-shape opaque identifiers that never contain the
 * separator, so a prefix can never straddle two realms.
 */
export const replicaPartitionKey = (identity: ReplicationIdentity): string =>
  [
    `ramose-replica-v${REPLICA_STORAGE_VERSION}`,
    identity.server,
    identity.principal,
    identity.database,
    identity.readView,
    identity.readCompatibilityHash,
  ].join(":");

/**
 * The scope key owning one partition key, when the string really is one.
 *
 * A sweep records its generation against a partition it may only know as a
 * stored key — a quarantined partition has no manifest left to name its
 * identity — so the owning scope has to be recovered from the key itself.
 * That is sound because the components are fixed-shape opaque identifiers that
 * never contain the separator: a partition key splits into exactly the version
 * tag and its five components, and anything else is not one.
 */
export const replicaPartitionScopeKey = (partition: string): string | undefined => {
  const parts = partition.split(":");
  if (parts.length !== 6 || parts[0] !== `ramose-replica-v${REPLICA_STORAGE_VERSION}`) {
    return undefined;
  }
  return replicaScopeKey({ server: parts[1], principal: parts[2] });
};

/** Prefix owning every partition of one server/principal scope. */
export const replicaScopePartitionPrefix = (scope: ReplicaScope): string =>
  [`ramose-replica-v${REPLICA_STORAGE_VERSION}`, scope.server, scope.principal, ""]
    .join(":");

/** Prefix owning every read view of one stable graph database. */
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

/**
 * Record the scope that confirmed one route observation. Observations are
 * looked up before any identity is known, so they are keyed by origin and
 * configured root and may be shared by several principals; the confirming
 * scopes decide who a scoped clear may remove the observation on behalf of.
 */
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

/** Requested deletion for a scope this client has never confirmed. */
export class ReplicaScopeUnconfirmedError extends Data.TaggedError(
  "ReplicaScopeUnconfirmedError",
)<{ readonly scope: string }> {}

/** A write lost its generation: a clear or eviction fenced it first. */
export class ReplicaFencedError extends Data.TaggedError(
  "ReplicaFencedError",
)<{
  readonly key: string;
  readonly expected: number;
  readonly observed: number;
}> {}

/** This storage handle already cleared the scope and is terminal for it. */
export class ReplicaScopeClearedError extends Data.TaggedError(
  "ReplicaScopeClearedError",
)<{ readonly scope: string }> {}

/** A pinned database is still in use by a session and cannot be evicted. */
export class ReplicaDatabaseActiveError extends Data.TaggedError(
  "ReplicaDatabaseActiveError",
)<{ readonly database: string; readonly pins: number }> {}

export type ReplicaFenceDecision = "adopt" | "match" | "fenced";

/**
 * Trust-on-first-use. A lease that has never seen a key adopts whatever the
 * durable record carries; afterwards only that exact generation is writable.
 */
export const replicaFenceDecision = (
  observed: number | undefined,
  current: number,
): ReplicaFenceDecision =>
  observed === undefined ? "adopt" : observed === current ? "match" : "fenced";

/**
 * One in-process lease over the durable generation records. A replication
 * session holds exactly one and passes it to every write it performs, so a
 * clear or eviction that bumps a guarded generation refuses those writes
 * deterministically rather than interleaving old-generation data.
 */
export class ReplicaLease {
  private readonly observed = new Map<string, number>();

  /** Adopt or verify the generation read inside a write transaction. */
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

  /** Replace an observation because this lease itself performed the bump. */
  adopt(key: string, current: number): void {
    this.observed.set(key, current);
  }

  generationOf(key: string): number | undefined {
    return this.observed.get(key);
  }
}
