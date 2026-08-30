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

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The final character of a 41-byte envelope carries two padding bits, so only
 * the sixteen alphabet positions divisible by four are canonical there.
 */
const FINAL = "AEIMQUYcgkosw048";

/**
 * A well-formed sealed handle for one fixture wire identity.
 *
 * Deterministic, so a fixture that installs a snapshot and later applies a
 * change binds the same entity to the same handle without threading a table
 * through every helper — which is the property a real stream has too.
 */
export const sealedHandle = (identity: string): string => {
  let text = "";
  for (let index = 0; index < 54; index++) {
    const code = identity.charCodeAt(index % identity.length) + index;
    text += ALPHABET[code % ALPHABET.length];
  }
  return `${text}${FINAL[identity.charCodeAt(0) % FINAL.length]}`;
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
