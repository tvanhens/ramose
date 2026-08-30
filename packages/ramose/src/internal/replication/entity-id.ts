import { canonicalizeJson } from "../authorization/canonical-json.ts";
import { base64Url, type ServerSealingKey } from "./server-identity.ts";

const utf8 = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;

export const ENTITY_ID_CODEC_VERSION = 1;

const KEY_ID_BYTES = 16;
const SIV_BYTES = 16;
const EID_BYTES = 8;

const ENVELOPE_BYTES = 1 + KEY_ID_BYTES + SIV_BYTES + EID_BYTES;
const SIV_AT = 1 + KEY_ID_BYTES;
const SEALED_AT = SIV_AT + SIV_BYTES;

const PREAMBLE_BYTES = SIV_AT;

export const SEALED_ENTITY_ID_MIN_LENGTH = Math.ceil(PREAMBLE_BYTES * 4 / 3);

export const SEALED_ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{54}[AEIMQUYcgkosw048]$/;

const HKDF_SALT = utf8.encode("ramose:entity-id:v1");
const CIPHER_INFO = "ramose:entity-id:aes-256-ctr:v1";
const SIV_INFO = "ramose:entity-id:siv:v1";
const AAD_DOMAIN = "ramose:entity-id:aad:v1";

export type SealedEntityId = string;

export type EntityIdScope = {
  readonly server: string;
  readonly principal: string;
  readonly database: string;
};

export type EntityIdResolution =
  | {
    readonly type: "resolved";
    readonly eid: number;
    readonly scope: EntityIdScope;
  }
  | {
    readonly type: "update-required";
    readonly reason: "codec-version" | "key-epoch";
  }
  | { readonly type: "denied" };

const DENIED = Object.freeze({ type: "denied" }) as EntityIdResolution;

const quarantine = (
  reason: "codec-version" | "key-epoch",
): EntityIdResolution => Object.freeze({ type: "update-required", reason });

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

const keyIdBytes = (sealing: ServerSealingKey): Bytes => {
  const bytes = decodeBase64Url(sealing.keyId);
  if (bytes === undefined || bytes.length !== KEY_ID_BYTES) {
    throw new TypeError(
      "ramose/replication: the sealing key id is not 16 base64url bytes",
    );
  }
  return bytes;
};

const additionalData = (
  keyId: Bytes,
  scopeText: string,
): Bytes =>
  utf8.encode(
    `${AAD_DOMAIN}\u0000${ENTITY_ID_CODEC_VERSION}\u0000${base64Url(keyId)}\u0000${scopeText}`,
  );

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

const decodeCanonicalBase64Url = (text: string): Bytes | undefined => {
  const bytes = decodeBase64Url(text);
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

export const openEntityId = async (
  sealing: ServerSealingKey,
  scope: EntityIdScope,
  token: string,
): Promise<EntityIdResolution> => {
  const envelope = decodeCanonicalBase64Url(token);
  if (envelope === undefined) return DENIED;
  if (envelope.length < PREAMBLE_BYTES) return DENIED;
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
