import { localDigest } from "./digest.ts";

const ROOT_DOMAIN = "ramose:replication:route-slot:root:v1";
const LINEAGE_DOMAIN = "ramose:replication:route-slot:lineage:v1";
const PROVISIONAL_DOMAIN = "ramose:replication:route-slot:provisional-path:v1";
const SCOPE_DOMAIN = "ramose:replication:route-scope:v1";
const PATH_DOMAIN = "ramose:replication:route-path:v1";

export type ReplicaRouteSlot = string;

export type ReplicaRouteScope = {
  readonly origin: string;
  readonly root: string;
};

export const rootReplicaRouteSlot = (): Promise<ReplicaRouteSlot> =>
  localDigest({ domain: ROOT_DOMAIN });

export const stableReplicaRouteSlot = async (
  lineage: readonly string[],
): Promise<ReplicaRouteSlot> => {
  let slot = await rootReplicaRouteSlot();
  for (const entity of lineage) {
    slot = await localDigest({ domain: LINEAGE_DOMAIN, parent: slot, entity });
  }
  return slot;
};

export const provisionalReplicaRouteSlot = (
  graphPath: readonly string[],
): Promise<ReplicaRouteSlot> =>
  localDigest({ domain: PROVISIONAL_DOMAIN, graphPath });

export const replicaRouteScope = (scope: ReplicaRouteScope): Promise<string> =>
  localDigest({ domain: SCOPE_DOMAIN, origin: scope.origin, root: scope.root });

export const replicaRoutePathKey = (
  graphPath: readonly string[],
): Promise<string> => localDigest({ domain: PATH_DOMAIN, graphPath });

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
