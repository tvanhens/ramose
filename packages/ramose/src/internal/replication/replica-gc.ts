/**
 * Reachability decisions and quota classification for the persisted browser
 * replica (#474 slice 11).
 *
 * A committed replica is content-addressed and immutable, so every install
 * abandons the nodes it superseded — at 100k datoms one changed datom orphans
 * 62 of 81 nodes. Reclaiming them is one sweep, and everything that decides
 * *what* a sweep may remove is an ordinary value transformation, so it lives
 * here rather than inside the IndexedDB adapter: which addresses a set of live
 * roots keeps alive, whether a staged snapshot can still commit, whether a
 * native failure was a quota exhaustion, and how many attempts an install gets
 * after one. `indexeddb.ts` supplies the storage reads and the transaction that
 * makes a decision durable; none of it is decided there.
 */

import * as Data from "effect/Data";
import { REPLICA_STORAGE_VERSION } from "./protocol.ts";

/**
 * Durable key of the sweep generation guarding one replica partition.
 *
 * It lives in the same generation store as the scope and database records, so
 * the restore publish fence can read it inside the very transaction that
 * re-confirms those two. Exactly one writer bumps it — a sweep that deleted at
 * least one node — and exactly one reader observes it.
 */
export const replicaSweepKey = (partition: string): string =>
  [`ramose-replica-sweep-v${REPLICA_STORAGE_VERSION}`, partition].join(":");

/**
 * A partial reachability walk over one partition's content-addressed nodes.
 *
 * The walk itself is ordinary graph mechanics and is kept separate from the
 * storage that answers it: the caller asks for the next frontier addresses,
 * reads those node bodies however it likes, and reports either each node's
 * outgoing references or that it could not be read. Deduplication by address is
 * what bounds the walk, and a node that could not be expanded makes the whole
 * result incomplete — a sweep may never treat unreadable structure as absence.
 */
export class ReplicaReachability {
  private readonly known = new Set<string>();
  private readonly frontier: string[] = [];
  private failed = false;

  constructor(roots: Iterable<string>) {
    for (const root of roots) this.add(root);
  }

  private add(hash: string): void {
    if (this.known.has(hash)) return;
    this.known.add(hash);
    this.frontier.push(hash);
  }

  /** Up to `limit` addresses whose references are not known yet. */
  next(limit: number): readonly string[] {
    return this.frontier.splice(0, Math.max(0, limit));
  }

  /** Record one node's outgoing references; leaves report none. */
  expand(children: Iterable<string>): void {
    for (const child of children) this.add(child);
  }

  /** Record that a node could not be read, decoded, or interpreted. */
  fail(): void {
    this.failed = true;
  }

  get pending(): boolean {
    return this.frontier.length > 0;
  }

  /** True only when every reachable node was expanded successfully. */
  get complete(): boolean {
    return !this.failed && this.frontier.length === 0;
  }

  /** Every address reached, whether or not the walk completed. */
  get reachable(): ReadonlySet<string> {
    return this.known;
  }
}

/**
 * Addresses stored in one partition that no live root set reaches.
 *
 * Order follows the stored order so a sweep deletes deterministically, and a
 * duplicate stored address contributes one deletion.
 */
export const unreachableNodeHashes = (
  stored: Iterable<string>,
  live: ReadonlySet<string>,
): readonly string[] => {
  const swept: string[] = [];
  const seen = new Set<string>();
  for (const hash of stored) {
    if (live.has(hash) || seen.has(hash)) continue;
    seen.add(hash);
    swept.push(hash);
  }
  return Object.freeze(swept);
};

/**
 * Whether one staged snapshot can be swept.
 *
 * A staging record names the committed revision it was opened against, and
 * `commitSnapshot` installs only when that base is still the committed one. A
 * staging whose base has moved can therefore never install again, whatever
 * happens next, so removing it costs nothing: the next `SnapshotStart` rebases
 * and rewrites it. Staging that could still commit — including a snapshot
 * streaming right now against a current base — is never swept.
 */
export const stagingIsSweepable = (
  staging: { readonly baseRevision: string | null } | undefined,
  committedRevision: string | null,
): boolean => staging !== undefined && staging.baseRevision !== committedRevision;

/** What one storage failure was, as far as recovery is concerned. */
export type ReplicaStorageFailureKind = "quota" | "unrelated";

/**
 * Legacy numeric `DOMException` codes for storage exhaustion. Modern browsers
 * report the name, but the code is what older Firefox and Safari builds set,
 * and a wrapped exception may carry only that.
 */
const QUOTA_CODES: ReadonlySet<number> = new Set([
  /** `QUOTA_EXCEEDED_ERR`. */
  22,
  /** Firefox `NS_ERROR_DOM_QUOTA_REACHED`. */
  1014,
]);

const QUOTA_NAMES: ReadonlySet<string> = new Set([
  "QuotaExceededError",
  "NS_ERROR_DOM_QUOTA_REACHED",
  "QUOTA_EXCEEDED_ERR",
]);

/**
 * Classify a native storage failure without reading its message text.
 *
 * The name is the specified signal and every current engine sets it; the codes
 * cover the historical spellings. Message text is deliberately not consulted —
 * it is localized, engine-specific, and would make an unrelated failure look
 * recoverable. Anything unrecognized is `unrelated` and propagates untouched,
 * so a bug can never be retried as if it were pressure.
 */
export const classifyReplicaStorageFailure = (
  error: unknown,
): ReplicaStorageFailureKind => {
  if (typeof error !== "object" || error === null) return "unrelated";
  const named = error as { readonly name?: unknown; readonly code?: unknown };
  if (typeof named.name === "string" && QUOTA_NAMES.has(named.name)) return "quota";
  if (typeof named.code === "number" && QUOTA_CODES.has(named.code)) return "quota";
  return "unrelated";
};

/** What an install does after one attempt ended in `failure`. */
export type ReplicaQuotaRecovery = "propagate" | "reclaim" | "exhausted";

/**
 * The bound: one GC pass and one retry, never more.
 *
 * `attempt` counts attempts already made. The first quota failure reclaims and
 * retries; the second gives up with a typed outcome rather than sweeping again,
 * because a second pass can only find what the first one already took.
 */
export const replicaQuotaRecovery = (
  attempt: number,
  failure: ReplicaStorageFailureKind,
): ReplicaQuotaRecovery =>
  failure !== "quota" ? "propagate" : attempt >= 2 ? "exhausted" : "reclaim";

/** An install exhausted storage with one reclaim pass already behind it. */
export class ReplicaQuotaExhaustedError extends Data.TaggedError(
  "ReplicaQuotaExhaustedError",
)<{
  readonly partition: string;
  /** Node records the single recovery pass reclaimed before the retry. */
  readonly reclaimedNodes: number;
}> {}

/** What one reachability sweep examined and removed. */
export type ReplicaGcOutcome = {
  /** Partitions with stored nodes or staging that the pass considered. */
  readonly partitions: number;
  /** Partitions the pass actually swept something from. */
  readonly swept: number;
  /**
   * Partitions left untouched: an in-flight materialization, a manifest that
   * moved under the pass, or an incomplete reachability walk.
   */
  readonly skipped: number;
  /** Node records deleted. */
  readonly nodes: number;
  /** Node records kept because a live root set reaches them. */
  readonly retained: number;
  /** Staging records whose commit was already impossible, deleted. */
  readonly staging: number;
};

export const emptyReplicaGcOutcome = (): ReplicaGcOutcome =>
  Object.freeze({ partitions: 0, swept: 0, skipped: 0, nodes: 0, retained: 0, staging: 0 });
