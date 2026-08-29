/**
 * `ReplicaRouteSlot` — the stable local lookup slot for one activated database.
 *
 * A slot is *local only* and never authority. It selects which stored exact
 * credential binding and which cache candidate a client may consult; it never
 * decides what a client may read. Network activation keeps sending the current
 * mutable graph-path names, so the server still authorizes every segment.
 *
 * The configured root always occupies one fixed slot. A child slot is derived
 * from the ordered, opaque, server-authenticated Graph entity lineage carried
 * by `ReplicationIdentity.graphLineage`, so renaming a Graph keeps its slot and
 * deleting/recreating a same-named Graph does not. Before the client has ever
 * confirmed a path it may fall back to a provisional path-derived slot in a
 * separate digest domain; a confirmed binding re-keys onto the stable slot.
 */

import { localDigest } from "./digest.ts";

const ROOT_DOMAIN = "ramose:replication:route-slot:root:v1";
const LINEAGE_DOMAIN = "ramose:replication:route-slot:lineage:v1";
const PROVISIONAL_DOMAIN = "ramose:replication:route-slot:provisional-path:v1";
const SCOPE_DOMAIN = "ramose:replication:route-scope:v1";
const PATH_DOMAIN = "ramose:replication:route-path:v1";

export type ReplicaRouteSlot = string;

/** Scope of one route-observation family: the canonical origin and root. */
export type ReplicaRouteScope = {
  readonly origin: string;
  readonly root: string;
};

/** One fixed slot for the immutable configured root route. */
export const rootReplicaRouteSlot = (): Promise<ReplicaRouteSlot> =>
  localDigest({ domain: ROOT_DOMAIN });

/**
 * Chain the ordered per-segment Graph entity identities. Chaining means the
 * same entity reached through a different parent is a different slot.
 */
export const stableReplicaRouteSlot = async (
  lineage: readonly string[],
): Promise<ReplicaRouteSlot> => {
  let slot = await rootReplicaRouteSlot();
  for (const entity of lineage) {
    slot = await localDigest({ domain: LINEAGE_DOMAIN, parent: slot, entity });
  }
  return slot;
};

/**
 * The slot a client may use before it has ever confirmed this path. It lives in
 * its own digest domain and therefore can never collide with a stable slot.
 */
export const provisionalReplicaRouteSlot = (
  graphPath: readonly string[],
): Promise<ReplicaRouteSlot> =>
  localDigest({ domain: PROVISIONAL_DOMAIN, graphPath });

/** Local partition of the route-observation table. */
export const replicaRouteScope = (scope: ReplicaRouteScope): Promise<string> =>
  localDigest({ domain: SCOPE_DOMAIN, origin: scope.origin, root: scope.root });

/** Opaque local key for one current root-relative path text. */
export const replicaRoutePathKey = (
  graphPath: readonly string[],
): Promise<string> => localDigest({ domain: PATH_DOMAIN, graphPath });

/**
 * Resolve the slot to use for one activation. A confirmed lineage always wins;
 * otherwise the root is fixed and a child falls back to its provisional slot.
 */
export const replicaRouteSlotFor = (input: {
  readonly graphPath: readonly string[];
  readonly lineage?: readonly string[] | undefined;
}): Promise<ReplicaRouteSlot> => {
  if (input.lineage !== undefined) {
    if (input.lineage.length !== input.graphPath.length) {
      throw new Error("graph lineage does not describe every path segment");
    }
    return stableReplicaRouteSlot(input.lineage);
  }
  return input.graphPath.length === 0
    ? rootReplicaRouteSlot()
    : provisionalReplicaRouteSlot(input.graphPath);
};
