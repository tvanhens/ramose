/**
 * Durable public identities for offline mutation (#475 slice 1).
 *
 * Three opaque string vocabularies, all portable (`ramose/db`), all free of
 * anything an application must not observe:
 *
 * - {@link EntityId} — the authoritative, server-issued handle for one entity.
 *   Its wire form is the sealed envelope minted by the engine's entity-id
 *   codec: `version(1) ‖ keyId(16) ‖ siv(16) ‖ ciphertext(8)`, canonical
 *   unpadded base64url. A numeric eid never appears on this surface, and this
 *   module deliberately cannot mint one — only the authoritative server can.
 * - {@link ClientRef} — a globally unique identity the *client* mints for an
 *   entity that does not exist authoritatively yet. Durable queued targets and
 *   entity-reference inputs may hold one until a receipt supplies the exact
 *   `{ clientRef, entityId }` mapping.
 * - {@link InvocationId} — the durable identity of one queued invocation,
 *   assigned before the invocation is observable as queued.
 *
 * ## Why UUIDv7 behind a versioned prefix
 *
 * A client ref and an invocation id must be unique across every device and
 * every restart with no coordination, and they must stay unique when two tabs
 * mint them in the same millisecond. UUIDv7 (RFC 9562) carries a 48-bit
 * millisecond timestamp plus 74 bits from the platform CSPRNG, so uniqueness
 * rests on the random half alone; the timestamp is only a debugging courtesy.
 * FIFO ordering is *never* read out of it — the outbox persists an explicit
 * per-database sequence, so a clock adjustment cannot reorder a queue.
 *
 * The four-character prefix (`cr1_`, `iv1_`) is the same discipline the sealed
 * entity-id envelope uses for its version byte: a future format is a different
 * prefix, so a build that cannot read it rejects the value instead of
 * misreading it, and a client ref can never be mistaken for an invocation id
 * inside a durable record. Neither value is a secret and neither encodes a
 * principal, a database, or a server.
 */

import type { AnyEntity } from "./Entity.ts";

declare const EntityIdBrand: unique symbol;
declare const ClientRefBrand: unique symbol;
declare const InvocationIdBrand: unique symbol;

/**
 * The opaque authoritative handle for one entity, branded by the entity
 * definition it names. A `Todo` handle is not an `Issue` handle, and a bare
 * string is neither.
 *
 * Stable for the same server / authenticated principal / stable database
 * across bearer refresh and read-compatible redeploys. It excludes the
 * deployment, the operation, the revision, the catalog, the read-view/schema
 * hash, the graph path text, and the bearer, so a compatible schema change
 * preserves every queued target.
 */
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

/**
 * Canonical unpadded base64url of the 41-byte sealed envelope. Mirrors
 * `SEALED_ENTITY_ID_PATTERN` in the engine's entity-id codec; a unit test
 * asserts the two never drift apart.
 */
export const ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{55}$/;

/** Codec version this build can read. A newer one quarantines, never denies. */
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

/**
 * One UUIDv7, RFC 9562 §5.7 with the "fixed bit-length dedicated counter"
 * omitted: `rand_a` is random, which the specification permits and which is
 * what makes two tabs minting in the same millisecond safe without shared
 * state. `crypto.randomUUID` cannot be used — it is version 4.
 */
const uuidV7 = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const millis = Date.now();
  // 48-bit big-endian unix_ts_ms.
  bytes[0] = (millis / 2 ** 40) & 0xff;
  bytes[1] = (millis / 2 ** 32) & 0xff;
  bytes[2] = (millis / 2 ** 24) & 0xff;
  bytes[3] = (millis / 2 ** 16) & 0xff;
  bytes[4] = (millis / 2 ** 8) & 0xff;
  bytes[5] = millis & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant
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

/**
 * Adopt a server-issued handle as an `EntityId`. The engine and the durable
 * decoders use this after the wire form is checked; application code receives
 * handles already branded and never needs it.
 *
 * @internal
 */
export const unsafeEntityId = <Entity extends AnyEntity = AnyEntity>(
  value: string,
): EntityId<Entity> => value as EntityId<Entity>;

/** The non-secret preamble every envelope version carries in the same place. */
export type EntityIdEnvelope = {
  readonly codecVersion: number;
  /** 16 bytes, canonical unpadded base64url — the server sealing key epoch. */
  readonly keyId: string;
};

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Read the version byte and the key id out of a sealed handle without any key
 * material, exactly as the server decides `update-required` from the preamble
 * alone. This is what lets a durable queue record its sealing epoch and
 * quarantine — data-free — when the server's key epoch or codec version moves
 * beyond what the persisted records were minted under.
 *
 * The first 24 base64url characters are exactly the first 18 bytes, so the
 * version byte and the whole 16-byte key id are readable on a character
 * boundary without touching the synthetic IV or the ciphertext.
 */
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
