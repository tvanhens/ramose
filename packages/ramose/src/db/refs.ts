import type { AnyEntity } from "./Entity.ts";

declare const EntityIdBrand: unique symbol;
declare const ClientRefBrand: unique symbol;
declare const InvocationIdBrand: unique symbol;

export type EntityId<Entity extends AnyEntity = AnyEntity> = string & {
  readonly [EntityIdBrand]: Entity;
};

/**
 * A globally unique client-minted identity for an entity this client intends
 * to create. It is durable: it survives restart, and dependent queued work
 * refers to it until the authoritative mapping arrives.
 */
export type ClientRef<Entity extends AnyEntity = AnyEntity> = string & {
  readonly [ClientRefBrand]: Entity;
};

/** The durable identity of one queued invocation. */
export type InvocationId = string & { readonly [InvocationIdBrand]: true };

/** What a durable queued mutation may name as its target. */
export type MutationRef<Entity extends AnyEntity = AnyEntity> =
  | EntityId<Entity>
  | ClientRef<Entity>;

export const ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{54}[AEIMQUYcgkosw048]$/;

export const ENTITY_ID_CODEC = 1;

const CLIENT_REF_PREFIX = "cr1_";
const INVOCATION_ID_PREFIX = "iv1_";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const CLIENT_REF_PATTERN = new RegExp(
  `^${CLIENT_REF_PREFIX}${UUID_PATTERN.source.slice(1, -1)}$`,
);
export const INVOCATION_ID_PATTERN = new RegExp(
  `^${INVOCATION_ID_PREFIX}${UUID_PATTERN.source.slice(1, -1)}$`,
);

const hex = (byte: number): string => byte.toString(16).padStart(2, "0");

const uuidV7 = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const millis = Date.now();
  bytes[0] = (millis / 2 ** 40) & 0xff;
  bytes[1] = (millis / 2 ** 32) & 0xff;
  bytes[2] = (millis / 2 ** 24) & 0xff;
  bytes[3] = (millis / 2 ** 16) & 0xff;
  bytes[4] = (millis / 2 ** 8) & 0xff;
  bytes[5] = millis & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const text = [...bytes].map(hex).join("");
  return [
    text.slice(0, 8),
    text.slice(8, 12),
    text.slice(12, 16),
    text.slice(16, 20),
    text.slice(20),
  ].join("-");
};

/** Mint one durable client ref for an entity that does not exist yet. */
export const clientRef = <Entity extends AnyEntity = AnyEntity>(): ClientRef<
  Entity
> => `${CLIENT_REF_PREFIX}${uuidV7()}` as ClientRef<Entity>;

/** Mint one durable invocation id. Assigned before anything is persisted. */
export const invocationId = (): InvocationId =>
  `${INVOCATION_ID_PREFIX}${uuidV7()}` as InvocationId;

export const isClientRef = (value: unknown): value is ClientRef =>
  typeof value === "string" && CLIENT_REF_PATTERN.test(value);

export const isInvocationId = (value: unknown): value is InvocationId =>
  typeof value === "string" && INVOCATION_ID_PATTERN.test(value);

/**
 * Shape check only. A well-formed handle is not an authorization claim and is
 * not proof that the ciphertext opens: only the authoritative resolver decides
 * that, and its failure is the ordinary sealed denial.
 */
export const isEntityId = (value: unknown): value is EntityId =>
  typeof value === "string" && ENTITY_ID_PATTERN.test(value);

export const isMutationRef = (value: unknown): value is MutationRef =>
  isEntityId(value) || isClientRef(value);

export const unsafeEntityId = <Entity extends AnyEntity = AnyEntity>(
  value: string,
): EntityId<Entity> => value as EntityId<Entity>;

export type EntityIdEnvelope = {
  readonly codecVersion: number;
  readonly keyId: string;
};

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const entityIdEnvelope = (
  value: string,
): EntityIdEnvelope | undefined => {
  if (!ENTITY_ID_PATTERN.test(value)) return undefined;
  const bytes = new Uint8Array(18);
  for (let group = 0; group < 6; group++) {
    let packed = 0;
    for (let offset = 0; offset < 4; offset++) {
      const index = BASE64URL.indexOf(value[group * 4 + offset]!);
      if (index < 0) return undefined;
      packed = (packed << 6) | index;
    }
    bytes[group * 3] = (packed >> 16) & 0xff;
    bytes[group * 3 + 1] = (packed >> 8) & 0xff;
    bytes[group * 3 + 2] = packed & 0xff;
  }
  let binary = "";
  for (const byte of bytes.subarray(1, 17)) binary += String.fromCharCode(byte);
  return Object.freeze({
    codecVersion: bytes[0]!,
    keyId: btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
  });
};
