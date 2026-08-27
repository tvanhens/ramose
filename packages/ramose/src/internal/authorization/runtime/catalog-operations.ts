/**
 * Catalog-local operation lookup (CAT-1, CAT-2).
 *
 * Lookup is by canonical identity (catalog + owner + local name), never
 * by wire name alone. A handle from one catalog must not invoke another.
 * #341 supplies the real table.
 *
 * @internal
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { CatalogId, CatalogVersion, OperationId } from "../identities.ts";
import type { CatalogOperationFailure } from "./failures.ts";

export interface CatalogOperationRef {
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
  readonly operation: OperationId;
}

/** Runtime descriptor — identity only until #341 fills target/input. */
export interface CatalogOperationDescriptor {
  readonly operation: OperationId;
  readonly catalog: CatalogId;
  readonly catalogVersion: CatalogVersion;
}

export interface CatalogLocalOperationsService {
  readonly resolve: (
    ref: CatalogOperationRef,
  ) => Effect.Effect<CatalogOperationDescriptor, CatalogOperationFailure>;
}

export class CatalogLocalOperations extends Context.Service<
  CatalogLocalOperations,
  CatalogLocalOperationsService
>()("ramose/authorization/runtime/CatalogLocalOperations") {}
