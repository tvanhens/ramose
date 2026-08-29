/** Opaque, server-authenticated replication identities and revisions. */

import * as Effect from "effect/Effect";
import type { AuthenticatedCaller } from "../authorization/request.ts";
import type { GraphPathLeaseIdentity } from "../authorization/graph-path.ts";
import type { ResolvedDatabaseRoute } from "../authorization/database-bindings.ts";
import { canonicalizeJson } from "../authorization/canonical-json.ts";
import {
  canonicalizeReadPolicy,
  GRAPH_READ_SEMANTICS_VERSION,
  hashReadCompatibility,
} from "../authorization/read-compatibility.ts";
import type { JsonValue } from "../authorization/json.ts";
import type {
  DatabaseId,
  ReadCompatibilityHash,
} from "../authorization/identities.ts";
import type {
  OpaqueReplicationId,
  ReplicationIdentity,
} from "./protocol.ts";
import { base64Url, type ServerSealingKey } from "./server-identity.ts";

const utf8 = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();
const MAX_CACHED_KEYS = 4;

/**
 * Key material comes from the durable server identity/sealing root, never from
 * the rotating `RAMOSE_INTERNAL_SECRET` Worker→DO capability — an ordinary
 * redeploy must not rotate a single identity or revision.
 */
const keyFor = (sealing: ServerSealingKey): Promise<CryptoKey> => {
  // Cached by material, never by key id: an HMAC depends only on the material,
  // and a cache keyed by the public name would let a mislabelled key id serve
  // the wrong CryptoKey.
  let key = keys.get(sealing.material);
  if (key !== undefined) return key;
  if (keys.size >= MAX_CACHED_KEYS) keys.delete(keys.keys().next().value!);
  key = crypto.subtle.importKey(
    "raw",
    utf8.encode(sealing.material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  keys.set(sealing.material, key);
  return key;
};

const canonical = (value: JsonValue): string => canonicalizeJson(value);

export const opaqueHmac = async (
  sealing: ServerSealingKey,
  domain: string,
  value: JsonValue,
): Promise<OpaqueReplicationId> => {
  const key = await keyFor(sealing);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    utf8.encode(`${domain}\0${canonical(value)}`),
  );
  return base64Url(new Uint8Array(signature)) as OpaqueReplicationId;
};

export const opaqueDigest = async (
  domain: string,
  bytes: Uint8Array,
): Promise<OpaqueReplicationId> => {
  const prefix = utf8.encode(`${domain}\0`);
  const material = new Uint8Array(prefix.byteLength + bytes.byteLength);
  material.set(prefix);
  material.set(bytes, prefix.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return base64Url(new Uint8Array(digest)) as OpaqueReplicationId;
};

const callerMaterial = (caller: AuthenticatedCaller): JsonValue => ({
  claims: caller.claims,
  classes: [...caller.classes].sort(),
});

export type ReplicationIdentityInput = {
  readonly sealing: ServerSealingKey;
  readonly origin: string;
  readonly caller: AuthenticatedCaller;
  readonly path: GraphPathLeaseIdentity;
  readonly readRoutes: readonly ReplicationReadRouteIdentity[];
};

export type ReplicationReadRouteIdentity = {
  readonly database: DatabaseId;
  readonly readCompatibilityHash: ReadCompatibilityHash;
  readonly readPolicy: string;
};

/** Read-only route material deliberately excludes the deployment/unit hash. */
export const replicationReadRouteIdentities = async (
  routes: readonly ResolvedDatabaseRoute[],
): Promise<readonly ReplicationReadRouteIdentity[]> => Promise.all(routes.map(async (route) => ({
  database: route.database,
  readCompatibilityHash: await Effect.runPromise(hashReadCompatibility(route.deployed.unit.catalog)),
  readPolicy: canonicalizeReadPolicy(route.deployed.unit.policy),
})));

/**
 * Derive the five partition dimensions solely from authenticated server
 * state. JWT expiry/issued-at are absent, so ordinary refresh is stable;
 * subject, declared claim values, or classes change the principal partition.
 */
export const makeReplicationIdentity = async (
  input: ReplicationIdentityInput,
): Promise<ReplicationIdentity> => {
  const target = input.path.routes[input.path.routes.length - 1];
  if (target === undefined) throw new Error("replication path has no target");
  const server = await opaqueHmac(
    input.sealing,
    "ramose:replication:server:v1",
    input.origin,
  );
  const principal = await opaqueHmac(
    input.sealing,
    "ramose:replication:principal:v1",
    callerMaterial(input.caller),
  );
  const database = await opaqueHmac(
    input.sealing,
    "ramose:replication:database:v1",
    target.database,
  );
  const catalog = await opaqueHmac(
    input.sealing,
    "ramose:replication:catalog:v1",
    target.catalogKey,
  );
  const readCompatibilityHash = input.readRoutes[input.readRoutes.length - 1]
    ?.readCompatibilityHash;
  if (readCompatibilityHash === undefined) throw new Error("replication path has no read route");
  const readView = await opaqueHmac(
    input.sealing,
    "ramose:replication:read-view:v2",
    {
      graphReadSemantics: GRAPH_READ_SEMANTICS_VERSION,
      routes: input.readRoutes.map((route) => ({
        database: route.database,
        compatibility: route.readCompatibilityHash,
        policy: route.readPolicy,
      })),
      dependencies: input.path.dependencies.map((dependency) => ({
        parent: dependency.parentDatabase,
        entity: dependency.graphEntity,
      })),
    },
  );
  const unsigned = {
    version: 1 as const,
    server,
    principal,
    database,
    catalog,
    readView,
    readCompatibilityHash,
  };
  const authenticator = await opaqueHmac(
    input.sealing,
    "ramose:replication:identity:v1",
    unsigned,
  );
  return Object.freeze({ ...unsigned, authenticator });
};

export const makeEntityIdentity = (
  sealing: ServerSealingKey,
  database: string,
  eid: number,
): Promise<OpaqueReplicationId> =>
  opaqueHmac(sealing, "ramose:replication:entity:v1", { database, eid });

export const makeRevision = (
  sealing: ServerSealingKey,
  identity: ReplicationIdentity,
  stateDigest: OpaqueReplicationId,
): Promise<OpaqueReplicationId> =>
  opaqueHmac(sealing, "ramose:replication:revision:v1", {
    binding: identity.authenticator,
    state: stateDigest,
  });

export const makeSnapshotIdentity = (
  sealing: ServerSealingKey,
  identity: ReplicationIdentity,
  revision: OpaqueReplicationId,
): Promise<OpaqueReplicationId> =>
  opaqueHmac(sealing, "ramose:replication:snapshot:v1", {
    binding: identity.authenticator,
    revision,
  });
