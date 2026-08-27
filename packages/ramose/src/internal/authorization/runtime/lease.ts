/**
 * Snapshot lease and cancellation (REV-1, REV-5).
 *
 * A snapshot that has expired or been released must not produce further
 * use or output. Lease state is synchronous so tests can assert it
 * without an Effect environment.
 *
 * @internal
 */

import * as Result from "effect/Result";
import { MAX_READ_LEASE_MS } from "../bounds.ts";
import { LeaseExpired } from "../failures.ts";
import { SnapshotCancelled } from "./failures.ts";

export type SnapshotLeaseState = {
  readonly epoch: number;
  readonly expiresAt: number;
  cancelled: boolean;
};

export const createLeaseState = (input: {
  readonly epoch: number;
  readonly expiresAt?: number;
  readonly now?: number;
}): SnapshotLeaseState => {
  const now = input.now ?? Date.now();
  const maxExpiresAt = now + MAX_READ_LEASE_MS;
  const requested = input.expiresAt ?? maxExpiresAt;
  const expiresAt =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.min(requested, maxExpiresAt)
      : maxExpiresAt;
  return { epoch: input.epoch, expiresAt, cancelled: false };
};

export const inspectLease = (
  lease: SnapshotLeaseState,
): { readonly epoch: number; readonly expiresAt: number; readonly cancelled: boolean } => ({
  epoch: lease.epoch,
  expiresAt: lease.expiresAt,
  cancelled: lease.cancelled,
});

export const cancelLease = (lease: SnapshotLeaseState): void => {
  lease.cancelled = true;
};

export const checkLease = (
  lease: SnapshotLeaseState,
  now = Date.now(),
): Result.Result<void, LeaseExpired | SnapshotCancelled> => {
  if (lease.cancelled) {
    return Result.fail(new SnapshotCancelled({ message: "snapshot lease was cancelled" }));
  }
  if (now >= lease.expiresAt) {
    return Result.fail(new LeaseExpired({ message: "snapshot lease expired" }));
  }
  return Result.succeed(undefined);
};
