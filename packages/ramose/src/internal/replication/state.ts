/** Pure client transition machine for the v1 replication contract. */

import * as Data from "effect/Data";
import * as Result from "effect/Result";
import type {
  EntityHandleBinding,
  LogicalDatom,
  ReplicationFrame,
  ReplicationIdentity,
  SnapshotDatom,
  SnapshotLogicalValue,
} from "./protocol.ts";

/**
 * The wire identity → sealed `EntityId` binding a committed value carries.
 *
 * One entry per entity the value names. The wire identity rotates with the
 * partition; the sealed handle does not, which is exactly why both are kept:
 * the first addresses the datoms, the second addresses a mutation.
 */
export type EntityHandles = ReadonlyMap<string, string>;

export const emptyEntityHandles: EntityHandles = new Map();

export type CommittedReplica = {
  readonly revision: string;
  readonly datoms: readonly LogicalDatom[];
  readonly handles: EntityHandles;
};

export type SnapshotStaging = {
  readonly snapshot: string;
  readonly revision: string;
  readonly chunks: ReadonlyMap<number, readonly SnapshotDatom[]>;
  /** Accumulated across chunks; a snapshot binds each entity exactly once. */
  readonly handles: EntityHandles;
};

export type ClientReplicationState = {
  readonly identity?: ReplicationIdentity;
  readonly committed?: CommittedReplica;
  readonly staging?: SnapshotStaging;
  readonly closed: boolean;
};

export class ReplicationTransitionError extends Data.TaggedError(
  "ReplicationTransitionError",
)<{ readonly reason: string }> {}

export const emptyClientReplicationState = (): ClientReplicationState => ({
  closed: false,
});

export const sameReplicationIdentity = (
  left: ReplicationIdentity,
  right: ReplicationIdentity,
): boolean =>
  left.version === right.version &&
  left.server === right.server &&
  left.principal === right.principal &&
  left.database === right.database &&
  left.catalog === right.catalog &&
  left.readView === right.readView &&
  left.readCompatibilityHash === right.readCompatibilityHash &&
  left.graphLineage.length === right.graphLineage.length &&
  left.graphLineage.every((entity, index) => entity === right.graphLineage[index]) &&
  left.authenticator === right.authenticator;

const factKey = (datom: LogicalDatom): string =>
  JSON.stringify([datom.entity, datom.field, datom.value]);

const sameDatomList = (
  left: readonly SnapshotDatom[],
  right: readonly SnapshotDatom[],
): boolean =>
  left.length === right.length &&
  left.every((datom, index) =>
    JSON.stringify(datom) === JSON.stringify(right[index])
  );

const fail = <A = never>(
  reason: string,
): Result.Result<A, ReplicationTransitionError> =>
  Result.fail(new ReplicationTransitionError({ reason }));

const requireIdentity = (
  state: ClientReplicationState,
  identity: ReplicationIdentity,
): Result.Result<void, ReplicationTransitionError> =>
  state.identity !== undefined &&
      sameReplicationIdentity(state.identity, identity)
    ? Result.succeed(undefined)
    : fail("frame identity does not match the active partition");

/**
 * Merge one frame's bindings into an accumulating set.
 *
 * The binding is a bijection within a partition, and both directions are
 * enforced. Sealing is deterministic per `(root, scope, eid)` and injective in
 * the eid within one scope, and the wire identity is a PRF of the same eid — so
 * one identity carries exactly one handle, and one handle names exactly one
 * identity.
 *
 * Violating either direction is a protocol error rather than a later truth: two
 * handles for one identity would mean two entities share a wire name, and one
 * handle for two identities would mean two rows share a mutation target. In
 * both cases the honest answer is to refuse the frame, because the persisted
 * manifest declares the same bijection and would refuse the value afterwards
 * anyway — better here, where the committed value is still untouched.
 */
const mergeHandles = (
  prior: EntityHandles,
  bindings: readonly EntityHandleBinding[],
): EntityHandles | undefined => {
  let merged: Map<string, string> | undefined;
  let claimed: Set<string> | undefined;
  const current = (): EntityHandles => merged ?? prior;
  for (const binding of bindings) {
    const existing = current().get(binding.entity);
    if (existing === binding.handle) continue;
    if (existing !== undefined) return undefined;
    // The reverse direction, built lazily: a frame that binds nothing new pays
    // nothing, and one that does pays it once for the whole merge.
    claimed ??= new Set(current().values());
    if (claimed.has(binding.handle)) return undefined;
    claimed.add(binding.handle);
    merged ??= new Map(prior);
    merged.set(binding.entity, binding.handle);
  }
  return merged ?? prior;
};

/**
 * The bindings a committed value keeps: exactly the entities its datoms name.
 *
 * Pruned rather than accumulated, for the same reason the overlay is recomputed
 * rather than patched — a binding that outlives the entity it names is a
 * mutation target for a row this replica no longer holds.
 */
const retainHandles = (
  handles: EntityHandles,
  datoms: readonly LogicalDatom[],
): EntityHandles => {
  const kept = new Map<string, string>();
  const keep = (entity: string): void => {
    const handle = handles.get(entity);
    if (handle !== undefined) kept.set(entity, handle);
  };
  for (const datom of datoms) {
    keep(datom.entity);
    if (datom.value.type === "ref") keep(datom.value.value);
  }
  return kept;
};

const isValuePart = (
  value: SnapshotLogicalValue,
): value is
  | Extract<SnapshotLogicalValue, { readonly type: "string-part" }>
  | Extract<SnapshotLogicalValue, { readonly type: "bytes-part" }> =>
  value.type === "string-part" || value.type === "bytes-part";

type MaterializedAt = {
  readonly order: number;
  readonly datom: LogicalDatom;
};

type PartGroup = {
  readonly order: number;
  readonly entity: string;
  readonly field: string;
  readonly type: "string-part" | "bytes-part";
  readonly chunks: number;
  readonly values: Map<number, string>;
};

const commitSnapshot = (
  state: ClientReplicationState,
  frame: Extract<ReplicationFrame, { readonly type: "SnapshotCommit" }>,
): Result.Result<ClientReplicationState, ReplicationTransitionError> => {
  if (state.committed?.revision === frame.revision) {
    const { staging: _, ...withoutStaging } = state;
    return Result.succeed({ ...withoutStaging, closed: false });
  }
  const staging = state.staging;
  if (
    staging === undefined ||
    staging.snapshot !== frame.snapshot ||
    staging.revision !== frame.revision
  ) {
    // A reordered commit cannot expose a partial value. Ordered transports
    // will resend through reconnect; retaining the previous complete value is
    // the conservative transition.
    return Result.succeed(state);
  }
  if (staging.chunks.size !== frame.chunks) return Result.succeed(state);
  const materialized: MaterializedAt[] = [];
  const groups = new Map<string, PartGroup>();
  let order = 0;
  for (let index = 0; index < frame.chunks; index++) {
    const chunk = staging.chunks.get(index);
    if (chunk === undefined) return Result.succeed(state);
    for (const datom of chunk) {
      if (!isValuePart(datom.value)) {
        materialized.push({
          order,
          datom: { ...datom, value: datom.value },
        });
        order++;
        continue;
      }
      const part = datom.value;
      if (part.index >= part.chunks) {
        return fail("snapshot value part index exceeds its chunk count");
      }
      if (
        part.type === "bytes-part" &&
        part.index + 1 < part.chunks &&
        part.value.endsWith("=")
      ) {
        return fail("non-final byte value part has base64 padding");
      }
      const key = JSON.stringify([
        datom.entity,
        datom.field,
        part.type,
        part.identity,
      ]);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          order,
          entity: datom.entity,
          field: datom.field,
          type: part.type,
          chunks: part.chunks,
          values: new Map(),
        };
        groups.set(key, group);
      } else if (group.chunks !== part.chunks) {
        return fail("snapshot value parts disagree on their chunk count");
      }
      const existing = group.values.get(part.index);
      if (existing !== undefined && existing !== part.value) {
        return fail("duplicate snapshot value part changed bytes");
      }
      group.values.set(part.index, part.value);
      order++;
    }
  }
  for (const group of groups.values()) {
    if (group.values.size !== group.chunks) return Result.succeed(state);
    const parts: string[] = [];
    for (let index = 0; index < group.chunks; index++) {
      const part = group.values.get(index);
      if (part === undefined) return Result.succeed(state);
      parts.push(part);
    }
    materialized.push({
      order: group.order,
      datom: {
        entity: group.entity,
        field: group.field,
        value: {
          type: group.type === "string-part" ? "string" : "bytes",
          value: parts.join(""),
        },
        op: "add",
      },
    });
  }
  materialized.sort((left, right) => left.order - right.order);
  const datoms = materialized.map((item) => item.datom);
  const facts = new Set<string>();
  for (const datom of datoms) {
    const key = factKey(datom);
    if (facts.has(key)) return fail("snapshot contains a duplicate fact");
    facts.add(key);
  }
  const missing = new Set<string>();
  for (const datom of datoms) {
    if (!staging.handles.has(datom.entity)) missing.add(datom.entity);
    if (datom.value.type === "ref" && !staging.handles.has(datom.value.value)) {
      missing.add(datom.value.value);
    }
  }
  // Every replicated entity arrives with its sealed handle, so a snapshot that
  // completes without one for some entity it names is an incomplete value — and
  // installing it would leave a row an application can read but cannot address.
  if (missing.size > 0) return fail("snapshot names an entity with no sealed handle");
  return Result.succeed({
    identity: frame.identity,
    committed: Object.freeze({
      revision: frame.revision,
      datoms: Object.freeze(datoms),
      handles: retainHandles(staging.handles, datoms),
    }),
    closed: false,
  });
};

const applyChange = (
  state: ClientReplicationState,
  frame: Extract<ReplicationFrame, { readonly type: "Change" }>,
): Result.Result<ClientReplicationState, ReplicationTransitionError> => {
  const committed = state.committed;
  if (committed === undefined) return fail("change arrived before a committed value");
  if (frame.revision === committed.revision) return Result.succeed(state);
  if (frame.from !== committed.revision) return Result.succeed(state);

  const operations = new Map<string, LogicalDatom["op"]>();
  for (const datom of frame.datoms) {
    const key = factKey(datom);
    const prior = operations.get(key);
    if (prior !== undefined && prior !== datom.op) {
      return fail("change both adds and retracts one fact");
    }
    operations.set(key, datom.op);
  }

  const handles = mergeHandles(committed.handles, frame.handles);
  if (handles === undefined) return fail("change rebinds an entity's sealed handle");

  const facts = new Map<string, LogicalDatom>();
  for (const datom of committed.datoms) {
    facts.set(factKey(datom), datom);
  }
  for (const datom of frame.datoms) {
    const key = factKey(datom);
    if (datom.op === "retract") facts.delete(key);
    else facts.set(key, datom);
  }
  const datoms = Object.freeze([...facts.values()]);
  // Subjects *and* reference targets, exactly as the snapshot commit checks
  // them. A reference is a way to reach an entity, so a target the value cannot
  // address is the same hole as an unaddressable subject — and the persisted
  // manifest requires a binding for both, so an asymmetric check here would
  // install a value the next restore refuses.
  for (const datom of datoms) {
    if (!handles.has(datom.entity)) {
      return fail("change leaves an entity with no sealed handle");
    }
    if (datom.value.type === "ref" && !handles.has(datom.value.value)) {
      return fail("change leaves a referenced entity with no sealed handle");
    }
  }
  return Result.succeed({
    identity: frame.identity,
    committed: Object.freeze({
      revision: frame.revision,
      datoms,
      handles: retainHandles(handles, datoms),
    }),
    closed: false,
  });
};

/**
 * Apply exactly one decoded frame. Failures and ignored stale/reordered frames
 * return without mutating the prior state, so only a complete snapshot commit
 * or one complete committed change can replace the queryable value.
 */
export const applyReplicationFrame = (
  state: ClientReplicationState,
  frame: ReplicationFrame,
): Result.Result<ClientReplicationState, ReplicationTransitionError> => {
  // Terminal means terminal for this transport instance. Reconnection creates
  // a new transition session (optionally seeded with the prior committed
  // value); trailing bytes can never reopen a closed stream.
  if (state.closed) return Result.succeed(state);
  switch (frame.type) {
    case "Reset": {
      const same = state.identity !== undefined &&
        sameReplicationIdentity(state.identity, frame.identity);
      return Result.succeed({
        identity: frame.identity,
        ...(same && state.committed !== undefined
          ? { committed: state.committed }
          : {}),
        closed: false,
      });
    }
    case "SnapshotStart": {
      const same = state.identity !== undefined &&
        sameReplicationIdentity(state.identity, frame.identity);
      if (
        same &&
        state.staging?.snapshot === frame.snapshot &&
        state.staging.revision === frame.revision
      ) {
        return Result.succeed({ ...state, closed: false });
      }
      return Result.succeed({
        identity: frame.identity,
        ...(same && state.committed !== undefined
          ? { committed: state.committed }
          : {}),
        staging: Object.freeze({
          snapshot: frame.snapshot,
          revision: frame.revision,
          chunks: new Map(),
          handles: emptyEntityHandles,
        }),
        closed: false,
      });
    }
    case "SnapshotChunk": {
      const identity = requireIdentity(state, frame.identity);
      if (Result.isFailure(identity)) return Result.fail(identity.failure);
      const staging = state.staging;
      if (staging === undefined || staging.snapshot !== frame.snapshot) {
        return Result.succeed(state);
      }
      // Merged before the duplicate check, so a resend that rebinds an entity's
      // handle is refused rather than quietly losing to the first copy.
      const handles = mergeHandles(staging.handles, frame.handles);
      if (handles === undefined) {
        return fail("snapshot chunks disagree on an entity's sealed handle");
      }
      const existing = staging.chunks.get(frame.index);
      if (existing !== undefined) {
        return sameDatomList(existing, frame.datoms)
          ? Result.succeed(state)
          : fail("duplicate snapshot chunk changed bytes");
      }
      const chunks = new Map(staging.chunks);
      chunks.set(frame.index, Object.freeze([...frame.datoms]));
      return Result.succeed({
        ...state,
        staging: Object.freeze({ ...staging, chunks, handles }),
      });
    }
    case "SnapshotCommit": {
      const identity = requireIdentity(state, frame.identity);
      return Result.isFailure(identity)
        ? Result.fail(identity.failure)
        : commitSnapshot(state, frame);
    }
    case "Change": {
      const identity = requireIdentity(state, frame.identity);
      return Result.isFailure(identity)
        ? Result.fail(identity.failure)
        : applyChange(state, frame);
    }
    case "ResumeReady": {
      const identity = requireIdentity(state, frame.identity);
      if (Result.isFailure(identity)) return Result.fail(identity.failure);
      if (state.committed?.revision !== frame.revision) {
        return fail("resume-ready revision does not match the committed value");
      }
      // The frame authenticates freshness for the transport consumer. It does
      // not install data, advance the committed revision, or disturb staging.
      return Result.succeed(state);
    }
    case "KeepAlive": {
      const identity = requireIdentity(state, frame.identity);
      return Result.isFailure(identity)
        ? Result.fail(identity.failure)
        : Result.succeed(state);
    }
    case "TerminalError": {
      const same = frame.identity === undefined || state.identity === undefined ||
        sameReplicationIdentity(state.identity, frame.identity);
      return Result.succeed({
        ...(same && state.identity !== undefined
          ? { identity: state.identity }
          : frame.identity === undefined
            ? {}
            : { identity: frame.identity }),
        ...(same && state.committed !== undefined
          ? { committed: state.committed }
          : {}),
        closed: true,
      });
    }
  }
};
