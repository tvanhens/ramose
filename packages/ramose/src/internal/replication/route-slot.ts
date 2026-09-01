import { localDigest } from "./digest.ts";

const ROOT_DOMAIN = "ramose:replication:route-slot:root:v1";
const SCOPE_DOMAIN = "ramose:replication:route-scope:v1";
const DATABASE_ROUTE_DOMAIN = "ramose:replication:database-route:v1";

export type ReplicaRouteSlot = string;

export type ReplicaRouteScope = {
  readonly origin: string;
  readonly root: string;
};

export const rootReplicaRouteSlot = (): Promise<ReplicaRouteSlot> =>
  localDigest({ domain: ROOT_DOMAIN });

export const replicaRouteScope = (scope: ReplicaRouteScope): Promise<string> =>
  localDigest({ domain: SCOPE_DOMAIN, origin: scope.origin, root: scope.root });

export const replicaDatabaseRouteKey = (): Promise<string> =>
  localDigest({ domain: DATABASE_ROUTE_DOMAIN });
