import type {
  Change,
  EntityHandleBinding,
  SnapshotChunk,
} from "../src/internal/replication/protocol.ts";

const ENVELOPE_BYTES = 41;

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const sealedHandle = (identity: string): string => {
  let state = 0x811c9dc5;
  for (let index = 0; index < identity.length; index++) {
    state = Math.imul(state ^ identity.charCodeAt(index), 0x01000193) >>> 0;
  }
  const bytes = new Uint8Array(ENVELOPE_BYTES);

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

export const snapshotChunk = (
  frame: Omit<SnapshotChunk, "handles">,
): SnapshotChunk => ({ ...frame, handles: frameHandles(frame.datoms) });

export const changeFrame = (frame: Omit<Change, "handles">): Change => ({
  ...frame,
  handles: frameHandles(frame.datoms),
});
