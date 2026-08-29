/**
 * The durable, versioned server identity/sealing root.
 *
 * Ramose has two distinct secrets and they must not be the same value:
 *
 *   - `RAMOSE_INTERNAL_SECRET` is the *rotating* Worker→DO capability. It is
 *     re-minted on every owned-server deployment (see `peer.ts`) precisely so
 *     an old deployment cannot keep addressing the Durable Objects.
 *   - The **identity/sealing root** in this module is *durable*. It is
 *     generated once, inside real Durable Object state, and never regenerated.
 *     Every replication identity, entity identity, revision, and snapshot id
 *     is a PRF of this root, so an ordinary redeploy keeps them all stable.
 *
 * Deriving identities from the rotating capability made every `alchemy deploy`
 * silently rotate every opaque identity and orphan every persisted revision.
 *
 * The record is versioned and carries a key id. Consumers that persist durable
 * state under a root record the key id alongside it; a missing or replaced
 * root is an explicit, typed incompatibility that quarantines that state
 * rather than silently reusing or corrupting it.
 */

import * as Data from "effect/Data";

/** Bump only when the record shape or its generation changes. */
export const SERVER_IDENTITY_ROOT_VERSION = 1;

/** 16 random bytes, canonical unpadded base64url. */
export const SERVER_IDENTITY_KEY_ID = /^[A-Za-z0-9_-]{22}$/;
/** 32 random bytes, canonical unpadded base64url. */
const SERVER_IDENTITY_KEY_MATERIAL = /^[A-Za-z0-9_-]{43}$/;

export type ServerIdentityRoot = {
  readonly version: typeof SERVER_IDENTITY_ROOT_VERSION;
  /** Stable public name of this key. Safe to persist and compare. */
  readonly keyId: string;
  /** Secret key material. Never leaves the Worker/DO trust boundary. */
  readonly key: string;
  readonly createdAt: number;
};

/**
 * The sealing key an identity derivation is allowed to use. A distinct type
 * (rather than a bare `string`) so `RAMOSE_INTERNAL_SECRET` cannot be handed
 * to a derivation by mistake.
 */
export type ServerSealingKey = {
  readonly keyId: string;
  readonly material: string;
};

export class ServerIdentityUnavailable extends Data.TaggedError(
  "ServerIdentityUnavailable",
)<{ readonly reason: string; readonly cause?: unknown }> {}

export class ServerIdentityIncompatible extends Data.TaggedError(
  "ServerIdentityIncompatible",
)<{ readonly persisted: string; readonly current: string }> {}

export const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const randomBase64Url = (byteLength: number): string => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
};

/**
 * Mint one root. The caller must only ever call this when no record exists,
 * and must store the result before any await — inside a Durable Object that
 * makes creation atomic without an extra lock.
 */
export const generateServerIdentityRoot = (
  createdAt: number,
): ServerIdentityRoot =>
  Object.freeze({
    version: SERVER_IDENTITY_ROOT_VERSION,
    // Random rather than derived: the id must be stable and comparable
    // without ever being a function of the secret material.
    keyId: randomBase64Url(16),
    key: randomBase64Url(32),
    createdAt,
  });

/** Strict decode. Anything unexpected is "no usable root", never a guess. */
export const decodeServerIdentityRoot = (
  value: unknown,
): ServerIdentityRoot | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== SERVER_IDENTITY_ROOT_VERSION) return undefined;
  if (
    typeof record.keyId !== "string" ||
    !SERVER_IDENTITY_KEY_ID.test(record.keyId)
  ) return undefined;
  if (
    typeof record.key !== "string" ||
    !SERVER_IDENTITY_KEY_MATERIAL.test(record.key)
  ) return undefined;
  if (
    typeof record.createdAt !== "number" ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0
  ) return undefined;
  return Object.freeze({
    version: SERVER_IDENTITY_ROOT_VERSION,
    keyId: record.keyId,
    key: record.key,
    createdAt: record.createdAt,
  });
};

export const sealingKeyOf = (root: ServerIdentityRoot): ServerSealingKey =>
  Object.freeze({ keyId: root.keyId, material: root.key });

export type ServerIdentityBinding =
  /** Nothing persisted yet: this store adopts the current key id. */
  | { readonly type: "adopt" }
  | { readonly type: "compatible" }
  /** Durable state under `persisted` is unreachable and stays quarantined. */
  | { readonly type: "incompatible"; readonly persisted: string };

/**
 * The one decision every durable consumer of the root makes before it reads or
 * writes state keyed by a derived identity.
 */
export const decideServerIdentityBinding = (
  persistedKeyId: string | undefined,
  currentKeyId: string,
): ServerIdentityBinding => {
  if (persistedKeyId === undefined) return { type: "adopt" };
  if (persistedKeyId === currentKeyId) return { type: "compatible" };
  return { type: "incompatible", persisted: persistedKeyId };
};

/** Wire code the Replica DO returns for a quarantining key mismatch. */
export const SERVER_IDENTITY_INCOMPATIBLE = "server-identity-incompatible";
