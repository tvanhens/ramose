/**
 * Authorized application access (TCB-3, TCB-4, CUR-1, HIST-1).
 *
 * Query, pull, live, session, and operation results consume only this
 * snapshot. Construction requires a verified principal, sealed installed
 * IR, catalog identity, and explicit application and rule bases.
 * Missing any of those fails closed (FC-1).
 *
 * Raw-to-authorized conversion does not copy rule-snapshot facts onto
 * the application handle. The authorized cursor stays empty until #367.
 *
 * @internal
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { CatalogId, CatalogVersion, DatabaseId } from "../identities.ts";
import { isVerifiedInstalledAuthorization } from "../install.ts";
import type { InstalledAuthorizationIRV1 } from "../ir.ts";
import type { AuthorizationPrincipal } from "../principal.ts";
import { CatalogMismatch, InvalidIR } from "../failures.ts";
import {
  ApplicationSnapshotUnavailable,
  type ApplicationSnapshotFailure,
} from "./failures.ts";
import {
  createAuthorizedSnapshot,
  physicalCurrentDb,
  type AuthorizedSnapshot,
  type RawSnapshot,
} from "./snapshots.ts";

export interface AuthorizedSnapshotRequest {
  readonly raw: RawSnapshot;
  readonly principal: AuthorizationPrincipal;
  readonly installed: InstalledAuthorizationIRV1;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly database: DatabaseId;
  readonly applicationBasisT: number;
  readonly ruleBasisT: number;
  readonly leaseEpoch: number;
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
    if (request.principal === undefined || request.principal.subject.length === 0) {
      return yield* new ApplicationSnapshotUnavailable({
        message: "verified principal is required",
      });
    }
    if (!isVerifiedInstalledAuthorization(request.installed)) {
      return yield* new InvalidIR({ message: "compiled policy is not sealed installed IR" });
    }
    if (request.catalog === undefined || request.catalogVersion === undefined) {
      return yield* new ApplicationSnapshotUnavailable({
        message: "catalog identity is required",
      });
    }
    if (
      request.catalog !== request.installed.catalog ||
      request.catalogVersion !== request.installed.catalogVersion ||
      request.database !== request.installed.database
    ) {
      return yield* new CatalogMismatch({
        message: "catalog identity does not match installed policy",
        expected: request.installed.catalog,
        actual: request.catalog,
        expectedVersion: request.installed.catalogVersion,
        actualVersion: request.catalogVersion,
        expectedDatabase: request.installed.database,
        actualDatabase: request.database,
      });
    }
    if (request.raw.database !== request.installed.database) {
      return yield* new CatalogMismatch({
        message: "raw snapshot database does not match installed policy",
        expectedDatabase: request.installed.database,
        actualDatabase: request.raw.database,
      });
    }
    if (physicalCurrentDb(request.raw) === undefined) {
      return yield* new ApplicationSnapshotUnavailable({
        message: "raw snapshot is not a live capability",
      });
    }
    return createAuthorizedSnapshot({
      database: request.database,
      catalog: request.catalog,
      catalogVersion: request.catalogVersion,
      installed: request.installed,
      principal: request.principal,
      applicationBasisT: request.applicationBasisT,
      ruleBasisT: request.ruleBasisT,
      leaseEpoch: request.leaseEpoch,
      ...(request.asOfT === undefined ? {} : { asOfT: request.asOfT }),
      ...(request.history === undefined ? {} : { history: request.history }),
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
    });
  },
);
