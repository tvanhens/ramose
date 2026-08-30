/**
 * Frame fixtures for the two lanes that build replication frames by hand.
 *
 * Every data-bearing frame binds the sealed `EntityId` of each entity its
 * datoms name (#477). A client never verifies that seal — it cannot: the
 * ciphertext only opens under the server's durable sealing root — so what a
 * fixture needs is a *well-formed* handle, one per entity, distinct across
 * entities and stable for one entity. That is exactly what this produces.
 *
 * It is not a stand-in for the codec. The real seal is exercised where it is
 * real: `sealEntityId`/`openEntityId` in the unit lane, and the whole
 * server-to-client carriage against the actual Worker in the local lane.
 */

import type {
  Change,
  EntityHandleBinding,
  SnapshotChunk,
} from "../src/internal/replication/protocol.ts";

/** The envelope's fixed width: `version ‖ keyId(16) ‖ siv(16) ‖ ciphertext(8)`. */
const ENVELOPE_BYTES = 41;

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/**
 * A well-formed sealed handle for one fixture wire identity.
 *
 * Deterministic, so a fixture that installs a snapshot and later applies a
 * change binds the same entity to the same handle without threading a table
 * through every helper — which is the property a real stream has too. And
 * distinct per identity with real margin: a manifest refuses two entities that
 * share a handle, so a fixture whose expansion collapsed would fail as damage
 * rather than as the collision it is. The bytes are an xorshift stream seeded
 * by an FNV-1a fold of the identity, base64url'd exactly as the envelope is —
 * which is what makes the result canonical by construction rather than by a
 * hand-picked final character.
 */
export const sealedHandle = (identity: string): string => {
  let state = 0x811c9dc5;
  for (let index = 0; index < identity.length; index++) {
    state = Math.imul(state ^ identity.charCodeAt(index), 0x01000193) >>> 0;
  }
  const bytes = new Uint8Array(ENVELOPE_BYTES);
  // Byte 0 is the codec version in every envelope version, so a fixture handle
  // reads as this build's codec rather than as a quarantine.
  bytes[0] = 1;
  for (let index = 1; index < ENVELOPE_BYTES; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return base64Url(bytes);
};

type EntityNaming = {
  readonly entity: string;
  readonly value: { readonly type: string; readonly value: unknown };
};

/**
 * The bindings a frame carrying these datoms must arrive with: one per distinct
 * entity they name, as a subject or as a reference value.
 */
export const frameHandles = (
  datoms: readonly EntityNaming[],
): readonly EntityHandleBinding[] => {
  const entities = new Set<string>();
  for (const datom of datoms) {
    entities.add(datom.entity);
    if (datom.value.type === "ref" && typeof datom.value.value === "string") {
      entities.add(datom.value.value);
    }
  }
  return [...entities].map((entity) => ({
    entity,
    handle: sealedHandle(entity),
  }));
};

/**
 * One snapshot chunk, with the bindings its own datoms imply.
 *
 * Derived rather than supplied so a fixture cannot drift from the frame it is
 * describing: a real server binds exactly the entities the chunk names, and a
 * test that listed them separately would be free to disagree.
 */
export const snapshotChunk = (
  frame: Omit<SnapshotChunk, "handles">,
): SnapshotChunk => ({ ...frame, handles: frameHandles(frame.datoms) });

/** One change, with the bindings its own datoms imply. */
export const changeFrame = (frame: Omit<Change, "handles">): Change => ({
  ...frame,
  handles: frameHandles(frame.datoms),
});
