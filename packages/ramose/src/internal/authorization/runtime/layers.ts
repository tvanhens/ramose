/**
 * Fail-closed stub Layers for the #338 capability boundaries.
 *
 * Not re-exported from any barrel. Trusted bootstrap (worker / transactor)
 * imports this file directly. Layers that would grant raw or rule access
 * stay here — there is no public constructor for a live snapshot.
 *
 * @internal
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CatalogId, OperationId } from "../identities.ts";
import { AuthorizedApplicationAccess } from "./application-snapshot.ts";
import { AuthenticationAdmission } from "./authentication.ts";
import { CatalogLocalOperations } from "./catalog-operations.ts";
import {
  ApplicationSnapshotUnavailable,
  AuthenticationRejected,
  CatalogOperationNotFound,
  RawStorageUnavailable,
  RuleSnapshotUnavailable,
} from "./failures.ts";
import { RawStorageAccess } from "./raw-storage.ts";
import { RuleSnapshotAccess } from "./rule-snapshot.ts";

const UNWIRED = "authorization runtime is not wired";

/** @internal */
export const rawStorageDenyLayer: Layer.Layer<RawStorageAccess> = Layer.succeed(
  RawStorageAccess,
  {
    open: () => Effect.fail(new RawStorageUnavailable({ message: UNWIRED })),
  },
);

/** @internal */
export const ruleSnapshotDenyLayer: Layer.Layer<RuleSnapshotAccess> = Layer.succeed(
  RuleSnapshotAccess,
  {
    project: () => Effect.fail(new RuleSnapshotUnavailable({ message: UNWIRED })),
    evaluateRule: () => Effect.fail(new RuleSnapshotUnavailable({ message: UNWIRED })),
  },
);

/** @internal */
export const applicationSnapshotDenyLayer: Layer.Layer<AuthorizedApplicationAccess> =
  Layer.succeed(AuthorizedApplicationAccess, {
    open: () => Effect.fail(new ApplicationSnapshotUnavailable({ message: UNWIRED })),
  });

/** @internal */
export const catalogOperationsDenyLayer: Layer.Layer<CatalogLocalOperations> = Layer.succeed(
  CatalogLocalOperations,
  {
    resolve: (ref: { readonly catalog: CatalogId; readonly operation: OperationId }) =>
      Effect.fail(
        new CatalogOperationNotFound({ catalog: ref.catalog, operation: ref.operation }),
      ),
  },
);

/** @internal */
export const authenticationDenyLayer: Layer.Layer<AuthenticationAdmission> = Layer.succeed(
  AuthenticationAdmission,
  {
    admit: () => Effect.fail(new AuthenticationRejected({ message: UNWIRED })),
  },
);

/**
 * Every capability boundary, fail-closed. Provide once at the request
 * edge. Missing a service still fails through {@link import("./deny.ts").closeConfiguredAccess}.
 *
 * @internal
 */
export const denyAllCapabilityLayer: Layer.Layer<
  | RawStorageAccess
  | RuleSnapshotAccess
  | AuthorizedApplicationAccess
  | CatalogLocalOperations
  | AuthenticationAdmission
> = Layer.mergeAll(
  rawStorageDenyLayer,
  ruleSnapshotDenyLayer,
  applicationSnapshotDenyLayer,
  catalogOperationsDenyLayer,
  authenticationDenyLayer,
);
