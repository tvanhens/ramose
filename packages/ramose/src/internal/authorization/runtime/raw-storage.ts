/**
 * Raw storage access (TCB-1, CUR-4).
 *
 * Holders: storage, transactor, indexer. Application-facing code must
 * not obtain a raw snapshot. The tag, constructor, and granting Layer
 * stay module-private — import this file only from trusted internals.
 *
 * Effect Context tags are not the security boundary. The snapshot value
 * is opaque; a substituted service cannot mint a live raw handle without
 * going through {@link mintRawSnapshot}.
 *
 * @internal
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Db } from "../../core/db.ts";
import type { DatabaseId } from "../identities.ts";
import type { RawStorageFailure } from "./failures.ts";
import { mintRawSnapshot, type RawSnapshot } from "./snapshots.ts";

export interface RawSnapshotRequest {
  readonly database: DatabaseId;
  readonly basisT: number;
  readonly asOfT?: number | undefined;
  readonly history?: boolean | undefined;
  readonly leaseEpoch?: number | undefined;
  readonly expiresAt?: number | undefined;
}

export interface RawPhysicalOpen {
  readonly open: (request: RawSnapshotRequest) => Effect.Effect<Db, RawStorageFailure>;
}

export interface RawStorageAccessService {
  readonly open: (
    request: RawSnapshotRequest,
  ) => Effect.Effect<RawSnapshot, RawStorageFailure>;
}

export class RawStorageAccess extends Context.Service<
  RawStorageAccess,
  RawStorageAccessService
>()("ramose/authorization/runtime/RawStorageAccess") {}

export const openRawSnapshot = Effect.fn("Authorization.openRawSnapshot")(function* (
  physical: RawPhysicalOpen,
  request: RawSnapshotRequest,
) {
  const current = yield* physical.open(request);
  return yield* Effect.fromResult(
    mintRawSnapshot({
      database: request.database,
      current,
      basisT: request.basisT,
      leaseEpoch: request.leaseEpoch ?? 0,
      ...(request.asOfT === undefined ? {} : { asOfT: request.asOfT }),
      ...(request.history === undefined ? {} : { history: request.history }),
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
    }),
  );
});
