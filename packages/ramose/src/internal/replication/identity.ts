/** Opaque, server-authenticated replication identities and revisions. */

import type { AuthenticatedCaller } from "../authorization/request.ts";
import type { GraphPathLeaseIdentity } from "../authorization/graph-path.ts";
import { canonicalizeJson } from "../authorization/canonical-json.ts";
import type { JsonValue } from "../authorization/json.ts";
import type {
  OpaqueReplicationId,
  ReplicationIdentity,
} from "./protocol.ts";

const utf8 = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();
const MAX_CACHED_KEYS = 4;

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const keyFor = (secret: string): Promise<CryptoKey> => {
  let key = keys.get(secret);
  if (key !== undefined) return key;
  if (keys.size >= MAX_CACHED_KEYS) keys.delete(keys.keys().next().value!);
  key = crypto.subtle.importKey(
    "raw",
    utf8.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  keys.set(secret, key);
  return key;
};

const canonical = (value: JsonValue): string => canonicalizeJson(value);

export const opaqueHmac = async (
  secret: string,
  domain: string,
  value: JsonValue,
): Promise<OpaqueReplicationId> => {
  const key = await keyFor(secret);
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
  readonly secret: string;
  readonly origin: string;
  readonly deployment: string;
  readonly caller: AuthenticatedCaller;
  readonly path: GraphPathLeaseIdentity;
};

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
    input.secret,
    "ramose:replication:server:v1",
    input.origin,
  );
  const principal = await opaqueHmac(
    input.secret,
    "ramose:replication:principal:v1",
    callerMaterial(input.caller),
  );
  const database = await opaqueHmac(
    input.secret,
    "ramose:replication:database:v1",
    target.database,
  );
  const catalog = await opaqueHmac(
    input.secret,
    "ramose:replication:catalog:v1",
    target.catalogKey,
  );
  const readView = await opaqueHmac(
    input.secret,
    "ramose:replication:read-view:v1",
    {
      deployment: input.deployment,
      principal,
      root: input.path.rootDatabase,
      graphPath: [...input.path.path],
      routes: input.path.routes.map((route) => ({
        database: route.database,
        catalog: route.catalogKey,
        unit: route.unitHash,
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
  };
  const authenticator = await opaqueHmac(
    input.secret,
    "ramose:replication:identity:v1",
    unsigned,
  );
  return Object.freeze({ ...unsigned, authenticator });
};

export const makeEntityIdentity = (
  secret: string,
  database: string,
  eid: number,
): Promise<OpaqueReplicationId> =>
  opaqueHmac(secret, "ramose:replication:entity:v1", { database, eid });

export const makeRevision = (
  secret: string,
  identity: ReplicationIdentity,
  stateDigest: OpaqueReplicationId,
): Promise<OpaqueReplicationId> =>
  opaqueHmac(secret, "ramose:replication:revision:v1", {
    binding: identity.authenticator,
    state: stateDigest,
  });

export const makeSnapshotIdentity = (
  secret: string,
  identity: ReplicationIdentity,
  revision: OpaqueReplicationId,
): Promise<OpaqueReplicationId> =>
  opaqueHmac(secret, "ramose:replication:snapshot:v1", {
    binding: identity.authenticator,
    revision,
  });
