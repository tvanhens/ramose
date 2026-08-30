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
 * Construction — deterministic authenticated encryption with a synthetic IV
 * (SIV, RFC 5297 in structure, with HMAC-SHA-256 in place of S2V). WebCrypto
 * only; every primitive is verified available in workerd and in the
 * repository's test runtimes:
 *
 *   HKDF-SHA-256 derives one HMAC-SHA-256 key and one AES-256-CTR key per
 *   scope from the durable identity/sealing root. The synthetic IV is the
 *   first 128 bits of HMAC-SHA-256(macKey, aad || eidBytes) — the eid bytes
 *   are always the trailing eight, so that encoding is unambiguous — and the
 *   ciphertext is AES-256-CTR over the eid bytes with the synthetic IV as the
 *   counter. The synthetic IV is therefore the authentication tag *and* the
 *   counter, and the whole token is a deterministic function of
 *   (root, scope, eid): cacheable, replay-friendly, equality-comparable.
 *
 * Why not deterministic AES-GCM. A nonce derived by truncating a PRF is not
 * injective, so two eids in one scope would eventually share a GCM nonce under
 * one key — and a repeated GCM (key, nonce) pair does not fail gracefully: it
 * leaks the XOR of the plaintexts *and* exposes the GHASH authentication key,
 * which forges handles. HMAC-SHA-256 has no such key-recovery mode. Here two
 * distinct eids collide only on a 128-bit HMAC collision (about 2^-64 for a
 * scope holding 2^32 handles) and even that leaks nothing beyond the XOR of
 * two eight-byte plaintexts. Keys are per-scope, so the birthday count never
 * spans databases or principals. Reusing the IV for the *same* eid is the
 * intended behaviour and discloses only the equality the handle already means.
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
/** The synthetic IV: the authentication tag and the AES-CTR counter block. */
const SIV_BYTES = 16;
const EID_BYTES = 8;

/**
 * `version || keyId || siv || ciphertext` — a fixed 41 bytes.
 *
 * Byte 0 is the codec version and bytes 1..17 are the key id in *every*
 * version of this envelope; a future version may move nothing else. That is
 * what lets an older build classify a newer token as `update-required`
 * instead of denying it.
 */
const ENVELOPE_BYTES = 1 + KEY_ID_BYTES + SIV_BYTES + EID_BYTES;
const SIV_AT = 1 + KEY_ID_BYTES;
const SEALED_AT = SIV_AT + SIV_BYTES;

/** The frozen `version || keyId` preamble every envelope version begins with. */
const PREAMBLE_BYTES = SIV_AT;

/**
 * The shortest string any envelope version can be, in canonical base64url
 * characters.
 *
 * The preamble is frozen at seventeen bytes, and seventeen bytes encode to
 * twenty-three characters. Anything shorter is no version's envelope, so
 * {@link openEntityId} denies it rather than quarantining it: a quarantine
 * there would claim a codec exists that spends fewer bytes than every version
 * is required to.
 *
 * Callers that must decide, without a key, whether a string could be a handle
 * at all use this. The authoritative edge's provisioning predicate is one
 * (#475), and it is exact only because this bound and the resolver's agree —
 * so it is derived from the same constant the resolver compares against rather
 * than written out beside it.
 */
export const SEALED_ENTITY_ID_MIN_LENGTH = Math.ceil(PREAMBLE_BYTES * 4 / 3);

/**
 * Canonical unpadded base64url of exactly {@link ENVELOPE_BYTES} bytes.
 *
 * The final character's low two bits are padding over 41 bytes, so only the
 * sixteen alphabet positions divisible by four appear there. `openEntityId`
 * enforces this anyway by re-encoding, but the pattern is the shape callers
 * check *before* they persist a handle, so it states the same rule.
 */
export const SEALED_ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{54}[AEIMQUYcgkosw048]$/;

/** Fixed, non-secret HKDF salt. Domain separation lives in the info strings. */
const HKDF_SALT = utf8.encode("ramose:entity-id:v1");
const CIPHER_INFO = "ramose:entity-id:aes-256-ctr:v1";
const SIV_INFO = "ramose:entity-id:siv:v1";
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

type EntityIdKeys = { readonly cipher: CryptoKey; readonly mac: CryptoKey };

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
  const [cipherBits, macBits] = await Promise.all([
    bits(CIPHER_INFO),
    bits(SIV_INFO),
  ]);
  const [cipher, mac] = await Promise.all([
    crypto.subtle.importKey("raw", cipherBits, { name: "AES-CTR" }, false, [
      "encrypt",
      "decrypt",
    ]),
    crypto.subtle.importKey(
      "raw",
      macBits,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  ]);
  return Object.freeze({ cipher, mac });
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

/**
 * The synthetic IV: HMAC-SHA-256 over the additional data followed by the eid
 * bytes, truncated to 128 bits. The eid is always the trailing eight bytes, so
 * the concatenation has exactly one reading and needs no length prefix.
 */
const syntheticIv = async (
  keys: EntityIdKeys,
  aad: Bytes,
  eidBytes: Bytes,
): Promise<Bytes> => {
  const signed = new Uint8Array(aad.length + eidBytes.length);
  signed.set(aad);
  signed.set(eidBytes, aad.length);
  return new Uint8Array(await crypto.subtle.sign("HMAC", keys.mac, signed))
    .slice(0, SIV_BYTES);
};

/**
 * AES-256-CTR over exactly one block's worth of plaintext, so the counter
 * never increments and encryption is its own inverse.
 */
const keystream = async (
  keys: EntityIdKeys,
  siv: Bytes,
  bytes: Bytes,
): Promise<Bytes> =>
  new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CTR", counter: siv, length: 64 },
      keys.cipher,
      bytes,
    ),
  );

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
): Promise<SealedEntityId> => {
  const keyId = keyIdBytes(sealing);
  const siv = await syntheticIv(
    keys,
    additionalData(keyId, scopeText),
    eidBytes,
  );
  const sealed = await keystream(keys, siv, eidBytes);
  const envelope = new Uint8Array(ENVELOPE_BYTES);
  envelope[0] = ENTITY_ID_CODEC_VERSION;
  envelope.set(keyId, 1);
  envelope.set(siv, SIV_AT);
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
  return sealWith(
    sealing,
    scopeText,
    await keysFor(sealing, scopeText),
    eidBytes,
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
  // Too short to carry the frozen `version || keyId` preamble, so it is no
  // version's envelope and a quarantine would be a lie about it. This is the
  // one length the resolver may judge before the version byte, and it is what
  // lets a caller decide *without a key* whether a string could be a handle at
  // all — see {@link SEALED_ENTITY_ID_MIN_LENGTH}.
  if (envelope.length < PREAMBLE_BYTES) return DENIED;
  // Decided from the preamble alone, before a key exists: never an oracle.
  if (envelope[0] !== ENTITY_ID_CODEC_VERSION) return quarantine("codec-version");
  if (envelope.length !== ENVELOPE_BYTES) return DENIED;
  const keyId = keyIdBytes(sealing);
  if (!equalBytes(envelope.subarray(1, SIV_AT), keyId)) {
    return quarantine("key-epoch");
  }
  const siv = envelope.slice(SIV_AT, SEALED_AT);
  const scopeText = canonicalScope(scope);
  const keys = await keysFor(sealing, scopeText);
  const eidBytes = await keystream(keys, siv, envelope.slice(SEALED_AT));
  // The synthetic IV is the tag: recomputing it over the recovered plaintext
  // and the additional data is what authenticates the handle, and it is
  // compared without an early exit.
  if (
    !equalBytes(
      await syntheticIv(keys, additionalData(keyId, scopeText), eidBytes),
      siv,
    )
  ) {
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
