import * as Data from "effect/Data";
import { REPLICA_STORAGE_VERSION } from "./protocol.ts";

export const replicaSweepKey = (partition: string): string =>
  [`ramose-replica-sweep-v${REPLICA_STORAGE_VERSION}`, partition].join(":");

export const replicaSweepPrefix = (partitionPrefix: string): string =>
  [`ramose-replica-sweep-v${REPLICA_STORAGE_VERSION}`, partitionPrefix].join(":");

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

  next(limit: number): readonly string[] {
    return this.frontier.splice(0, Math.max(0, limit));
  }

  expand(children: Iterable<string>): void {
    for (const child of children) this.add(child);
  }

  fail(): void {
    this.failed = true;
  }

  get pending(): boolean {
    return this.frontier.length > 0;
  }

  get complete(): boolean {
    return !this.failed && this.frontier.length === 0;
  }

  get reachable(): ReadonlySet<string> {
    return this.known;
  }
}

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

export const stagingIsSweepable = (
  staging: { readonly baseRevision: string | null } | undefined,
  committedRevision: string | null,
): boolean => staging !== undefined && staging.baseRevision !== committedRevision;

export type ReplicaStorageFailureKind = "quota" | "unrelated";

const QUOTA_CODES: ReadonlySet<number> = new Set([
  22,
  1014,
]);

const QUOTA_NAMES: ReadonlySet<string> = new Set([
  "QuotaExceededError",
  "NS_ERROR_DOM_QUOTA_REACHED",
  "QUOTA_EXCEEDED_ERR",
]);

export const classifyReplicaStorageFailure = (
  error: unknown,
): ReplicaStorageFailureKind => {
  if (typeof error !== "object" || error === null) return "unrelated";
  const named = error as { readonly name?: unknown; readonly code?: unknown };
  if (typeof named.name === "string" && QUOTA_NAMES.has(named.name)) return "quota";
  if (typeof named.code === "number" && QUOTA_CODES.has(named.code)) return "quota";
  return "unrelated";
};

export type ReplicaQuotaRecovery = "propagate" | "reclaim" | "exhausted";

export const replicaQuotaRecovery = (
  attempt: number,
  failure: ReplicaStorageFailureKind,
): ReplicaQuotaRecovery =>
  failure !== "quota" ? "propagate" : attempt >= 2 ? "exhausted" : "reclaim";

export class ReplicaQuotaExhaustedError extends Data.TaggedError(
  "ReplicaQuotaExhaustedError",
)<{
  readonly partition: string;
  readonly reclaimedNodes: number;
}> {}

export type ReplicaGcOutcome = {
  readonly partitions: number;
  readonly swept: number;
  readonly skipped: number;
  readonly nodes: number;
  readonly retained: number;
  readonly staging: number;
};

export const emptyReplicaGcOutcome = (): ReplicaGcOutcome =>
  Object.freeze({ partitions: 0, swept: 0, skipped: 0, nodes: 0, retained: 0, staging: 0 });
