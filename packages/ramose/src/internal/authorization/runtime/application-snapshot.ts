/**
 * Authorized application access (TCB-3, TCB-4, CUR-1).
 *
 * Query, pull, live, session, and operation results consume only this
 * snapshot. Construction requires a verified principal, installed IR,
 * catalog identity, and explicit bases — missing any of those fails
 * closed (FC-1). #339/#343 implement construction.
 *
 * @internal
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { DatabaseId } from "../identities.ts";
import type { InstalledAuthorizationIRV1 } from "../ir.ts";
import type { AuthorizationPrincipal } from "../principal.ts";
import type { ApplicationSnapshot } from "./brands.ts";
import type { ApplicationSnapshotFailure } from "./failures.ts";

export interface ApplicationSnapshotRequest {
  readonly database: DatabaseId;
  readonly basisT: number;
  readonly principal: AuthorizationPrincipal;
  readonly installed: InstalledAuthorizationIRV1;
  readonly leaseEpoch: number;
  readonly asOfT?: number | undefined;
  readonly history?: boolean | undefined;
}

export interface AuthorizedApplicationAccessService {
  readonly open: (
    request: ApplicationSnapshotRequest,
  ) => Effect.Effect<ApplicationSnapshot, ApplicationSnapshotFailure>;
}

export class AuthorizedApplicationAccess extends Context.Service<
  AuthorizedApplicationAccess,
  AuthorizedApplicationAccessService
>()("ramose/authorization/runtime/AuthorizedApplicationAccess") {}
