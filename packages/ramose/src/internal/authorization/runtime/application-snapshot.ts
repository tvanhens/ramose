/**
 * Authorized application access (TCB-3, TCB-4, CUR-1, HIST-1).
 *
 * Query, pull, live, session, and operation results consume only this
 * snapshot. Construction requires a sealed admission ticket, sealed
 * installed IR, catalog identity, and explicit application and rule
 * bases. Missing any of those fails closed (FC-1).
 *
 * Raw-to-authorized conversion does not copy rule-snapshot facts onto
 * the application handle. The authorized cursor stays empty until #367.
 *
 * @internal
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { CatalogId, CatalogVersion, DatabaseId } from "../identities.ts";
import type { InstalledAuthorizationIRV1 } from "../ir.ts";
import type { AdmissionTicket } from "./authentication.ts";
import { type ApplicationSnapshotFailure } from "./failures.ts";
import {
  mintAuthorizedSnapshot,
  type AuthorizedSnapshot,
  type RawSnapshot,
} from "./snapshots.ts";

export interface AuthorizedSnapshotRequest {
  readonly raw: RawSnapshot;
  readonly ticket: AdmissionTicket;
  readonly installed: InstalledAuthorizationIRV1;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly database: DatabaseId;
  readonly applicationBasisT: number;
  readonly ruleBasisT: number;
  readonly leaseEpoch?: number | undefined;
  readonly asOfT?: number | undefined;
  readonly history?: boolean | undefined;
  readonly expiresAt?: number | undefined;
}

export interface AuthorizedApplicationAccessService {
  readonly open: (
    request: AuthorizedSnapshotRequest,
  ) => Effect.Effect<AuthorizedSnapshot, ApplicationSnapshotFailure>;
}

export class AuthorizedApplicationAccess extends Context.Service<
  AuthorizedApplicationAccess,
  AuthorizedApplicationAccessService
>()("ramose/authorization/runtime/AuthorizedApplicationAccess") {}

export const openAuthorizedSnapshot = Effect.fn("Authorization.openAuthorizedSnapshot")(
  function* (request: AuthorizedSnapshotRequest) {
    return yield* Effect.fromResult(mintAuthorizedSnapshot(request));
  },
);
