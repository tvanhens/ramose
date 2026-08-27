/**
 * Raw storage access (TCB-1).
 *
 * Holders: storage, transactor, indexer. Application-facing code must
 * not obtain a raw snapshot. The tag, constructor, and granting Layer
 * stay module-private — import this file only from trusted internals.
 *
 * @internal
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { DatabaseId } from "../identities.ts";
import type { RawSnapshot } from "./brands.ts";
import type { RawStorageFailure } from "./failures.ts";

export interface RawSnapshotRequest {
  readonly database: DatabaseId;
  readonly basisT: number;
  readonly asOfT?: number | undefined;
  readonly history?: boolean | undefined;
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
