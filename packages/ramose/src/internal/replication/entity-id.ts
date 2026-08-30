/**
 * The sealed public entity handle — #475 milestone E0.
 *
 * `makeEntityIdentity` in `identity.ts` is a one-way HMAC scoped by the *full*
 * replication authenticator. It is not reversible and it rotates with the
 * catalog/read-view identity, so it can name an entity inside one live
 * replication stream but it cannot be a durable queued mutation target.
 * That handle stays exactly as it is; this module adds the separate,
 * reversible one.
 *
 * A sealed entity id is authenticated ciphertext of the private numeric eid,
 * bound to one *stable* scope: the confirmed server, the authenticated
 * principal, and the stable database identity. It deliberately excludes the
 * deployment, the operation, the revision, the catalog, the read-view/schema
 * hash, the graph path text, and the bearer token — so a compatible read-view
 * or schema change preserves every queued target, and ordinary token refresh
 * preserves every handle.
 *
 * Resolution decrypts straight to the eid. There is no scan and no mapping
 * table, bounded or otherwise. Resolution is *not* an authorization decision:
 * it yields `{ eid, scope }` and the authoritative operation boundary then
 * reruns its ordinary current visibility, type-compatibility, and operation
 * admission checks against that eid. Nothing here weakens or replaces them.
 *
 * Failure taxonomy, frozen with the construction:
 *   - an unsupported codec version or a key epoch this server no longer holds
 *     is a data-free `update-required` quarantine. It is decided from the
 *     envelope preamble alone, before any key is derived or any ciphertext is
 *     touched, so it is never an oracle for whether the rest of the token was
 *     valid.
 *   - everything else — malformed, tampered, wrong scope, wrong key material —
 *     collapses to the single payload-free `denied`, indistinguishable from
 *     not-found or unauthorized under #419's seal.
 *
 * Numeric eids never appear in a token, a receipt, a URL, browser storage, or
 * any public API; only the sealed form crosses those boundaries.
 *
 * Construction (WebCrypto only; verified available in workerd and in the
 * repository's test runtimes):
 *   HKDF-SHA-256 derives one AES-256-GCM key and one HMAC-SHA-256 nonce key
 *   per scope from the durable identity/sealing root; the nonce is the first
 *   96 bits of HMAC-SHA-256(nonceKey, eidBytes), which makes the whole token a
 *   deterministic function of (root, scope, eid) — cacheable, replay-friendly,
 *   and equality-comparable — while never repeating a nonce for two different
 *   eids under one derived key. Deterministic AES-GCM is safe here precisely
 *   because the plaintext is the only nonce input: identical plaintext is the
 *   only thing that reuses a nonce, and it produces the identical token.
 */

import { canonicalizeJson } from "../authorization/canonical-json.ts";
import { base64Url, type ServerSealingKey } from "./server-identity.ts";

const utf8 = new TextEncoder();

/** Byte views WebCrypto accepts: never backed by a `SharedArrayBuffer`. */
type Bytes = Uint8Array<ArrayBuffer>;

/**
 * Bump only for a change to the envelope layout, the derivation, or the AAD.
 * An older server reading a newer token quarantines it as `update-required`.
 */
export const ENTITY_ID_CODEC_VERSION = 1;

const KEY_ID_BYTES = 16;
const NONCE_BYTES = 12;
const EID_BYTES = 8;
const TAG_BYTES = 16;

/**
 * `version || keyId || nonce || ciphertext || tag` — a fixed 53 bytes.
 *
 * Byte 0 is the codec version and bytes 1..17 are the key id in *every*
 * version of this envelope; a future version may move nothing else. That is
 * what lets an older build classify a newer token as `update-required`
 * instead of denying it.
 */
const ENVELOPE_BYTES = 1 + KEY_ID_BYTES + NONCE_BYTES + EID_BYTES + TAG_BYTES;
const NONCE_AT = 1 + KEY_ID_BYTES;
const SEALED_AT = NONCE_AT + NONCE_BYTES;

/** Canonical unpadded base64url of exactly {@link ENVELOPE_BYTES} bytes. */
export const SEALED_ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{71}$/;

/** Fixed, non-secret HKDF salt. Domain separation lives in the info strings. */
const HKDF_SALT = utf8.encode("ramose:entity-id:v1");
const AES_INFO = "ramose:entity-id:aes-256-gcm:v1";
const NONCE_INFO = "ramose:entity-id:nonce:v1";
const AAD_DOMAIN = "ramose:entity-id:aad:v1";

/**
 * The opaque public handle. Named `SealedEntityId` internally because
 * `authorization/identities.ts` already owns `EntityId` as a catalog-scoped
 * entity *type* identity; #475's public `EntityId<Entity>` brands over this
 * wire form.
 */
export type SealedEntityId = string;

/**
 * The one stable scope a handle is bound to. Each component is an opaque
 * server-derived identity — see `makeEntityIdScope` in `identity.ts`, which
 * derives exactly the server/principal/database components of the replication
 * identity and nothing else.
 */
export type EntityIdScope = {
  readonly server: string;
  readonly principal: string;
  readonly database: string;
};

/** The bounded resolver's outcome. Both failures are data-free. */
export type EntityIdResolution =
  | {
    readonly type: "resolved";
    readonly eid: number;
    readonly scope: EntityIdScope;
  }
  /**
   * This build cannot read the token's codec version or key epoch. The reason
   * repeats only what the caller's own envelope preamble already says, so it
   * discloses nothing about the entity or about the rest of the token.
   */
  | {
    readonly type: "update-required";
    readonly reason: "codec-version" | "key-epoch";
  }
  /** #419's seal: one fixed denial for every other failure. */
  | { readonly type: "denied" };

const DENIED = Object.freeze({ type: "denied" }) as EntityIdResolution;

const quarantine = (
  reason: "codec-version" | "key-epoch",
): EntityIdResolution => Object.freeze({ type: "update-required", reason });

/**
 * RFC 8785 canonical JSON: exactly one encoding, control characters escaped,
 * so no scope component can forge a separator or collide with another.
 */
const canonicalScope = (scope: EntityIdScope): string =>
  canonicalizeJson({
    database: scope.database,
    principal: scope.principal,
    server: scope.server,
  });

type EntityIdKeys = { readonly aes: CryptoKey; readonly nonce: CryptoKey };

const derived = new Map<string, Promise<EntityIdKeys>>();
const MAX_CACHED_SCOPES = 32;

const deriveKeys = async (
  material: string,
  scopeText: string,
): Promise<EntityIdKeys> => {
  const root = await crypto.subtle.importKey(
    "raw",
    utf8.encode(material),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = (info: string): Promise<ArrayBuffer> =>
    crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: HKDF_SALT,
        info: utf8.encode(`${info}\u0000${scopeText}`),
      },
      root,
      256,
    );
  const [aesBits, nonceBits] = await Promise.all([
    bits(AES_INFO),
    bits(NONCE_INFO),
  ]);
  const [aes, nonce] = await Promise.all([
    crypto.subtle.importKey("raw", aesBits, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]),
    crypto.subtle.importKey(
      "raw",
      nonceBits,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  ]);
  return Object.freeze({ aes, nonce });
};

/**
 * Cached by key material and scope, never by the public key id: a mislabelled
 * key id must not be able to serve the wrong `CryptoKey`.
 */
const keysFor = (
  sealing: ServerSealingKey,
  scopeText: string,
): Promise<EntityIdKeys> => {
  const cacheKey = `${sealing.material}\u0000${scopeText}`;
  const existing = derived.get(cacheKey);
  if (existing !== undefined) return existing;
  if (derived.size >= MAX_CACHED_SCOPES) {
    derived.delete(derived.keys().next().value!);
  }
  const pending = deriveKeys(sealing.material, scopeText).catch(
    (cause): never => {
      if (derived.get(cacheKey) === pending) derived.delete(cacheKey);
      throw cause;
    },
  );
  derived.set(cacheKey, pending);
  return pending;
};

/**
 * The key id is bound by its 16 canonical bytes, never by the spelling the
 * root record happens to store, so a key id that is a non-canonical base64url
 * spelling of the same bytes still opens its own tokens.
 */
const keyIdBytes = (sealing: ServerSealingKey): Bytes => {
  const bytes = decodeBase64Url(sealing.keyId);
  if (bytes === undefined || bytes.length !== KEY_ID_BYTES) {
    throw new TypeError(
      "ramose/replication: the sealing key id is not 16 base64url bytes",
    );
  }
  return bytes;
};

/**
 * NUL separators are written as an explicit \u0000 escape: the bundler
 * folds the adjacent constant into the literal, and the short escape
 * followed by a digit is an octal escape a template string rejects.
 */
const additionalData = (
  keyId: Bytes,
  scopeText: string,
): Bytes =>
  utf8.encode(
    `${AAD_DOMAIN}\u0000${ENTITY_ID_CODEC_VERSION}\u0000${base64Url(keyId)}\u0000${scopeText}`,
  );

/**
 * Eight-byte unsigned big-endian. An eid outside the safe-integer range is an
 * engine bug, not an untrusted input, so it throws instead of sealing a value
 * that could not be read back exactly.
 */
const encodeEid = (eid: number): Bytes => {
  if (!Number.isSafeInteger(eid) || eid < 0) {
    throw new TypeError(
      "ramose/replication: an entity id must be a non-negative safe integer",
    );
  }
  const bytes = new Uint8Array(EID_BYTES);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(eid));
  return bytes;
};

const deterministicNonce = async (
  keys: EntityIdKeys,
  eidBytes: Bytes,
): Promise<Bytes> =>
  new Uint8Array(await crypto.subtle.sign("HMAC", keys.nonce, eidBytes))
    .slice(0, NONCE_BYTES);

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
};

const decodeBase64Url = (text: string): Bytes | undefined => {
  if (text.length === 0 || text.length % 4 === 1) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return undefined;
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/** Strict: exactly one spelling decodes, verified by re-encoding. */
const decodeCanonicalBase64Url = (text: string): Bytes | undefined => {
  const bytes = decodeBase64Url(text);
  // Rejects a non-zero tail in the final sextet, which would otherwise give a
  // second encoding of the same bytes.
  if (bytes === undefined || base64Url(bytes) !== text) return undefined;
  return bytes;
};

const sealWith = async (
  sealing: ServerSealingKey,
  scopeText: string,
  keys: EntityIdKeys,
  eidBytes: Bytes,
  nonce: Bytes,
): Promise<SealedEntityId> => {
  const keyId = keyIdBytes(sealing);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: additionalData(keyId, scopeText),
        tagLength: TAG_BYTES * 8,
      },
      keys.aes,
      eidBytes,
    ),
  );
  const envelope = new Uint8Array(ENVELOPE_BYTES);
  envelope[0] = ENTITY_ID_CODEC_VERSION;
  envelope.set(keyId, 1);
  envelope.set(nonce, NONCE_AT);
  envelope.set(sealed, SEALED_AT);
  return base64Url(envelope);
};

/**
 * Seal one private eid into the public handle for one scope.
 *
 * Deterministic: the same `(root, scope, eid)` always produces byte-identical
 * output, so handles compare with `===` and cache safely.
 */
export const sealEntityId = async (
  sealing: ServerSealingKey,
  scope: EntityIdScope,
  eid: number,
): Promise<SealedEntityId> => {
  const eidBytes = encodeEid(eid);
  const scopeText = canonicalScope(scope);
  const keys = await keysFor(sealing, scopeText);
  return sealWith(
    sealing,
    scopeText,
    keys,
    eidBytes,
    await deterministicNonce(keys, eidBytes),
  );
};

/**
 * The general sealing form, with the nonce supplied instead of derived.
 *
 * Only {@link sealEntityId}'s deterministic nonce survives resolution — any
 * other nonce authenticates under AES-GCM and is then rejected by the nonce
 * recomputation. Exported so that check is covered against the real derived
 * keys rather than a substitute.
 */
export const sealEntityIdWithNonce = async (
  sealing: ServerSealingKey,
  scope: EntityIdScope,
  eid: number,
  nonce: Uint8Array,
): Promise<SealedEntityId> => {
  if (nonce.length !== NONCE_BYTES) {
    throw new TypeError("ramose/replication: an entity id nonce is 12 bytes");
  }
  const scopeText = canonicalScope(scope);
  return sealWith(
    sealing,
    scopeText,
    await keysFor(sealing, scopeText),
    encodeEid(eid),
    new Uint8Array(nonce),
  );
};

/**
 * Resolve a public handle to the private eid for one scope.
 *
 * This is the whole resolver: a decrypt, not a lookup. The returned
 * `{ eid, scope }` is an *identity* claim only — the caller still runs its
 * ordinary visibility, type, and operation-admission checks.
 */
export const openEntityId = async (
  sealing: ServerSealingKey,
  scope: EntityIdScope,
  token: string,
): Promise<EntityIdResolution> => {
  const envelope = decodeCanonicalBase64Url(token);
  if (envelope === undefined) return DENIED;
  // Decided from the preamble alone, before a key exists: never an oracle.
  if (envelope[0] !== ENTITY_ID_CODEC_VERSION) return quarantine("codec-version");
  if (envelope.length !== ENVELOPE_BYTES) return DENIED;
  const keyId = keyIdBytes(sealing);
  if (!equalBytes(envelope.subarray(1, NONCE_AT), keyId)) {
    return quarantine("key-epoch");
  }
  const nonce = envelope.slice(NONCE_AT, SEALED_AT);
  const scopeText = canonicalScope(scope);
  const keys = await keysFor(sealing, scopeText);
  let opened: ArrayBuffer;
  try {
    opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: additionalData(keyId, scopeText),
        tagLength: TAG_BYTES * 8,
      },
      keys.aes,
      envelope.slice(SEALED_AT),
    );
  } catch {
    return DENIED;
  }
  const eidBytes = new Uint8Array(opened);
  if (eidBytes.length !== EID_BYTES) return DENIED;
  if (!equalBytes(await deterministicNonce(keys, eidBytes), nonce)) {
    return DENIED;
  }
  const eid = new DataView(
    eidBytes.buffer,
    eidBytes.byteOffset,
    EID_BYTES,
  ).getBigUint64(0);
  if (eid > BigInt(Number.MAX_SAFE_INTEGER)) return DENIED;
  return Object.freeze({ type: "resolved", eid: Number(eid), scope });
};
