/**
 * Capability Layers for raw, rule, and authorized snapshots.
 *
 * Deny stubs stay the request-edge default. Live Layers are internal-only
 * injection for the transactor (raw) and policy evaluator (rule). They
 * are not re-exported from any barrel.
 *
 * @internal
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Db } from "../../core/db.ts";
import type { CatalogId, DatabaseId, OperationId } from "../identities.ts";
import {
  AuthorizedApplicationAccess,
  openAuthorizedSnapshot,
  type AuthorizedSnapshotRequest,
} from "./application-snapshot.ts";
import { AuthenticationAdmission } from "./authentication.ts";
import { CatalogLocalOperations } from "./catalog-operations.ts";
import {
  ApplicationSnapshotUnavailable,
  AuthenticationRejected,
  CatalogOperationNotFound,
  RawStorageUnavailable,
  RuleSnapshotUnavailable,
} from "./failures.ts";
import {
  openRawSnapshot,
  RawStorageAccess,
  type RawPhysicalOpen,
  type RawSnapshotRequest,
} from "./raw-storage.ts";
import {
  evaluateRuleUnwired,
  lookupRuleField,
  projectRuleSnapshot,
  RuleSnapshotAccess,
  traverseRuleFields,
  traverseRuleFromMe,
  type RuleSnapshotRequest,
} from "./rule-snapshot.ts";
import {
  invalidateAuthorizedSnapshot,
  invalidateRawSnapshot,
  invalidateRuleSnapshot,
} from "./snapshots.ts";

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
    lookup: () => Effect.fail(new RuleSnapshotUnavailable({ message: UNWIRED })),
    traverse: () => Effect.fail(new RuleSnapshotUnavailable({ message: UNWIRED })),
    traverseFromMe: () => Effect.fail(new RuleSnapshotUnavailable({ message: UNWIRED })),
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

/** Deny stubs except raw — used to prove a raw-only environment cannot authorize. */
export const rawOnlyCapabilityLayer = (
  db: Db,
  database: DatabaseId,
): Layer.Layer<
  | RawStorageAccess
  | RuleSnapshotAccess
  | AuthorizedApplicationAccess
  | CatalogLocalOperations
  | AuthenticationAdmission
> =>
  Layer.mergeAll(
    rawStorageFromDb(db, database),
    ruleSnapshotDenyLayer,
    applicationSnapshotDenyLayer,
    catalogOperationsDenyLayer,
    authenticationDenyLayer,
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

/** Internal-only raw injection for the transactor and storage tests. */
export const transactorRawStorageLayer = (
  physical: RawPhysicalOpen,
): Layer.Layer<RawStorageAccess> =>
  Layer.succeed(RawStorageAccess, {
    open: (request) => openRawSnapshot(physical, request),
  });

/** In-memory raw opener over a physical `Db`. Test and transactor injection. */
export const rawStorageFromDb = (
  db: Db,
  database: DatabaseId,
): Layer.Layer<RawStorageAccess> =>
  transactorRawStorageLayer({
    open: (request: RawSnapshotRequest) => {
      if (request.database !== database) {
        return Effect.fail(new RawStorageUnavailable({ message: "database is not this store" }));
      }
      return Effect.succeed(db);
    },
  });

/** Internal-only rule injection for the policy evaluator. */
export const evaluatorRuleSnapshotLayer: Layer.Layer<RuleSnapshotAccess> = Layer.succeed(
  RuleSnapshotAccess,
  {
    project: (request) => projectRuleSnapshot(request),
    lookup: (snapshot, eid, field) => lookupRuleField(snapshot, eid, field),
    traverse: (snapshot, eid, steps) => traverseRuleFields(snapshot, eid, steps),
    traverseFromMe: (snapshot, steps) => traverseRuleFromMe(snapshot, steps),
    evaluateRule: () => evaluateRuleUnwired,
  },
);

/** Internal-only authorized snapshot construction. */
export const authorizedSnapshotLayer: Layer.Layer<AuthorizedApplicationAccess> = Layer.succeed(
  AuthorizedApplicationAccess,
  {
    open: (request) => openAuthorizedSnapshot(request),
  },
);

/**
 * Live snapshot construction for trusted internals. Raw still comes from
 * an explicit physical opener — query/pull must not obtain it.
 */
export const trustedSnapshotLayer = (
  physical: RawPhysicalOpen,
): Layer.Layer<RawStorageAccess | RuleSnapshotAccess | AuthorizedApplicationAccess> =>
  Layer.mergeAll(
    transactorRawStorageLayer(physical),
    evaluatorRuleSnapshotLayer,
    authorizedSnapshotLayer,
  );

export const scopedRawSnapshot = Effect.fn("Authorization.scopedRawSnapshot")(function* (
  request: RawSnapshotRequest,
) {
  const raw = yield* RawStorageAccess;
  return yield* Effect.acquireRelease(raw.open(request), (snapshot) =>
    Effect.sync(() => invalidateRawSnapshot(snapshot)),
  );
});

export const scopedRuleSnapshot = Effect.fn("Authorization.scopedRuleSnapshot")(function* (
  request: RuleSnapshotRequest,
) {
  const rules = yield* RuleSnapshotAccess;
  return yield* Effect.acquireRelease(rules.project(request), (snapshot) =>
    Effect.sync(() => invalidateRuleSnapshot(snapshot)),
  );
});

export const scopedAuthorizedSnapshot = Effect.fn("Authorization.scopedAuthorizedSnapshot")(
  function* (request: AuthorizedSnapshotRequest) {
    const app = yield* AuthorizedApplicationAccess;
    return yield* Effect.acquireRelease(app.open(request), (snapshot) =>
      Effect.sync(() => invalidateAuthorizedSnapshot(snapshot)),
    );
  },
);
