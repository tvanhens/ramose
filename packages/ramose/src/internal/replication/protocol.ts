/**
 * Versioned database-replication wire contract (#473).
 *
 * The public transport is newline-delimited JSON. Every decoder is strict and
 * bounded, and every data-bearing frame carries the authenticated opaque
 * partition selected by the server. Physical eids, attribute ids, transaction
 * positions, catalog proofs, and rule metadata are intentionally absent.
 */

import * as Data from "effect/Data";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ReadCompatibilityHash } from "../authorization/identities.ts";

export const REPLICATION_PROTOCOL_VERSION = 1 as const;

/**
 * Local layers own these independently; neither value is sent on the wire.
 * Version 2 is the documentation-free replica schema with stable route slots;
 * every version-1 record is dropped by one atomic pre-public migration.
 */
export const REPLICA_STORAGE_VERSION = 2 as const;
export const INITIAL_REPLICA_BUILD_ID = "ramose-client-v1" as const;

export const MAX_REPLICATION_REQUEST_BYTES = 65_536;
export const MAX_REPLICATION_FRAME_BYTES = 1_100_000;
export const MAX_REPLICATION_PATH_SEGMENTS = 1_024;
/** Maximum text carried by one scalar value or one large-value part. */
export const MAX_REPLICATION_STRING_BYTES = 131_072;
/** A non-final raw byte part is divisible by three, so base64 parts concatenate. */
export const MAX_REPLICATION_RAW_VALUE_PART_BYTES = 98_304;
export const MAX_REPLICATION_DATOMS_PER_SNAPSHOT_CHUNK = 16;
export const MAX_REPLICATION_DATOMS_PER_CHANGE = 256;
export const MAX_REPLICATION_CHANGE_BYTES = 1_048_576;
/** Silence is the v1 transport liveness policy; this pins a future fixed frame. */
export const REPLICATION_KEEPALIVE_INTERVAL_MS = 15_000;

const utf8 = new TextEncoder();
const strict = { onExcessProperty: "error" as const };

const boundedString = (maximum: number) =>
  Schema.String.check(Schema.makeFilter(
    (value: string) => utf8.encode(value).byteLength <= maximum,
    { expected: `a UTF-8 string no larger than ${maximum} bytes` },
  ));

const nonEmptyBoundedString = (maximum: number) =>
  boundedString(maximum).check(
    Schema.isMinLength(1),
  );

const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const canonicalBase64 = Schema.makeFilter(
  (value: string) => {
    try {
      return btoa(atob(value)) === value;
    } catch {
      return false;
    }
  },
  { expected: "canonical padded base64" },
);

export const OpaqueReplicationId = Schema.String.check(
  Schema.isPattern(OPAQUE_PATTERN),
);
export type OpaqueReplicationId = typeof OpaqueReplicationId.Type;

export const ReplicationScope = Schema.Struct({
  type: Schema.Literal("database"),
});
export type ReplicationScope = typeof ReplicationScope.Type;

const GraphPath = Schema.Array(nonEmptyBoundedString(4_096)).check(
  Schema.isMaxLength(MAX_REPLICATION_PATH_SEGMENTS),
);

/** The client selects only a root-relative path, scope, and optional revision. */
export const ActivationRequest = Schema.Struct({
  type: Schema.Literal("Activate"),
  protocol: Schema.Natural,
  graphPath: GraphPath,
  scope: ReplicationScope,
  readCompatibilityHash: ReadCompatibilityHash,
  resumeRevision: Schema.optionalKey(OpaqueReplicationId),
});
export type ActivationRequest = typeof ActivationRequest.Type;

/**
 * Ordered, opaque, server-authenticated identity of every authorized Graph
 * segment between the configured root and the target, root-child first. The
 * root activation carries an empty lineage. Values are domain-separated HMACs
 * over already-authorized server state: they expose no eid and no name, and the
 * server emits them only after authorizing the complete path they describe.
 * The client uses them solely to key local storage slots stably across renames.
 */
const GraphLineage = Schema.Array(OpaqueReplicationId).check(
  Schema.isMaxLength(MAX_REPLICATION_PATH_SEGMENTS),
);

/** Server-selected cache partition. The authenticator covers the other fields. */
export const ReplicationIdentity = Schema.Struct({
  version: Schema.Literal(1),
  server: OpaqueReplicationId,
  principal: OpaqueReplicationId,
  database: OpaqueReplicationId,
  catalog: OpaqueReplicationId,
  readView: OpaqueReplicationId,
  readCompatibilityHash: ReadCompatibilityHash,
  graphLineage: GraphLineage,
  authenticator: OpaqueReplicationId,
});
export type ReplicationIdentity = typeof ReplicationIdentity.Type;

const LongValue = Schema.Struct({
  type: Schema.Literal("long"),
  value: Schema.Int,
});
const DoubleValue = Schema.Struct({
  type: Schema.Literal("double"),
  value: Schema.Union([
    Schema.Finite,
    Schema.Literals(["positive-infinity", "negative-infinity"]),
  ]),
});
const StringValue = Schema.Struct({
  type: Schema.Literal("string"),
  value: boundedString(MAX_REPLICATION_STRING_BYTES),
});
const BooleanValue = Schema.Struct({
  type: Schema.Literal("boolean"),
  value: Schema.Boolean,
});
const ReferenceValue = Schema.Struct({
  type: Schema.Literal("ref"),
  value: OpaqueReplicationId,
});
const UuidValue = Schema.Struct({
  type: Schema.Literal("uuid"),
  value: Schema.String.check(Schema.isPattern(UUID_PATTERN)),
});
const InstantValue = Schema.Struct({
  type: Schema.Literal("instant"),
  value: Schema.Int,
});
const BytesValue = Schema.Struct({
  type: Schema.Literal("bytes"),
  value: Schema.String.check(
    Schema.isPattern(BASE64_PATTERN),
    Schema.isMaxLength(MAX_REPLICATION_STRING_BYTES),
    canonicalBase64,
  ),
});

const positiveNatural = Schema.Natural.check(Schema.makeFilter(
  (value: number) => value > 0,
  { expected: "a positive safe integer" },
));

/**
 * Stored strings and byte arrays are not write-bounded by the database. A
 * snapshot therefore fragments a large logical value across independently
 * bounded frames. `identity` groups the parts without exposing a physical id.
 */
export const SnapshotStringValuePart = Schema.Struct({
  type: Schema.Literal("string-part"),
  identity: OpaqueReplicationId,
  index: Schema.Natural,
  chunks: positiveNatural,
  value: boundedString(MAX_REPLICATION_STRING_BYTES),
});
export type SnapshotStringValuePart = typeof SnapshotStringValuePart.Type;

export const SnapshotBytesValuePart = Schema.Struct({
  type: Schema.Literal("bytes-part"),
  identity: OpaqueReplicationId,
  index: Schema.Natural,
  chunks: positiveNatural,
  value: Schema.String.check(
    Schema.isPattern(BASE64_PATTERN),
    Schema.isMaxLength(MAX_REPLICATION_STRING_BYTES),
    canonicalBase64,
  ),
});
export type SnapshotBytesValuePart = typeof SnapshotBytesValuePart.Type;

export const LogicalValue = Schema.Union([
  LongValue,
  DoubleValue,
  StringValue,
  BooleanValue,
  ReferenceValue,
  UuidValue,
  InstantValue,
  BytesValue,
]);
export type LogicalValue = typeof LogicalValue.Type;

export const SnapshotLogicalValue = Schema.Union([
  LogicalValue,
  SnapshotStringValuePart,
  SnapshotBytesValuePart,
]);
export type SnapshotLogicalValue = typeof SnapshotLogicalValue.Type;

export const LogicalDatom = Schema.Struct({
  entity: OpaqueReplicationId,
  field: nonEmptyBoundedString(4_096),
  value: LogicalValue,
  op: Schema.Literals(["add", "retract"]),
});
export type LogicalDatom = typeof LogicalDatom.Type;

export const SnapshotDatom = Schema.Struct({
  entity: OpaqueReplicationId,
  field: nonEmptyBoundedString(4_096),
  value: SnapshotLogicalValue,
  op: Schema.Literal("add"),
});
export type SnapshotDatom = typeof SnapshotDatom.Type;

export const SnapshotStart = Schema.Struct({
  type: Schema.Literal("SnapshotStart"),
  protocol: Schema.Literal(REPLICATION_PROTOCOL_VERSION),
  identity: ReplicationIdentity,
  snapshot: OpaqueReplicationId,
  revision: OpaqueReplicationId,
});
export type SnapshotStart = typeof SnapshotStart.Type;

export const SnapshotChunk = Schema.Struct({
  type: Schema.Literal("SnapshotChunk"),
  protocol: Schema.Literal(REPLICATION_PROTOCOL_VERSION),
  identity: ReplicationIdentity,
  snapshot: OpaqueReplicationId,
  index: Schema.Natural,
  datoms: Schema.Array(SnapshotDatom).check(
    Schema.isMaxLength(MAX_REPLICATION_DATOMS_PER_SNAPSHOT_CHUNK),
  ),
});
export type SnapshotChunk = typeof SnapshotChunk.Type;

export const SnapshotCommit = Schema.Struct({
  type: Schema.Literal("SnapshotCommit"),
  protocol: Schema.Literal(REPLICATION_PROTOCOL_VERSION),
  identity: ReplicationIdentity,
  snapshot: OpaqueReplicationId,
  revision: OpaqueReplicationId,
  chunks: Schema.Natural,
});
export type SnapshotCommit = typeof SnapshotCommit.Type;

export const Change = Schema.Struct({
  type: Schema.Literal("Change"),
  protocol: Schema.Literal(REPLICATION_PROTOCOL_VERSION),
  identity: ReplicationIdentity,
  from: OpaqueReplicationId,
  revision: OpaqueReplicationId,
  datoms: Schema.Array(LogicalDatom).check(
    Schema.isMaxLength(MAX_REPLICATION_DATOMS_PER_CHANGE),
  ),
});
export type Change = typeof Change.Type;

/** One-shot proof that a supplied committed revision is still current. */
export const ResumeReady = Schema.Struct({
  type: Schema.Literal("ResumeReady"),
  protocol: Schema.Literal(REPLICATION_PROTOCOL_VERSION),
  identity: ReplicationIdentity,
  revision: OpaqueReplicationId,
});
export type ResumeReady = typeof ResumeReady.Type;

/** One opaque reset shape for unavailable bases and partition transitions. */
export const Reset = Schema.Struct({
  type: Schema.Literal("Reset"),
  protocol: Schema.Literal(REPLICATION_PROTOCOL_VERSION),
  identity: ReplicationIdentity,
});
export type Reset = typeof Reset.Type;

/** Fixed shape, fixed cadence if ever enabled. V1 servers choose silence. */
export const KeepAlive = Schema.Struct({
  type: Schema.Literal("KeepAlive"),
  protocol: Schema.Literal(REPLICATION_PROTOCOL_VERSION),
  identity: ReplicationIdentity,
});
export type KeepAlive = typeof KeepAlive.Type;

export const TerminalError = Schema.Struct({
  type: Schema.Literal("TerminalError"),
  protocol: Schema.Literal(REPLICATION_PROTOCOL_VERSION),
  code: Schema.Literals(["incompatible-version", "update-required", "closed"]),
  identity: Schema.optionalKey(ReplicationIdentity),
});
export type TerminalError = typeof TerminalError.Type;

export const ReplicationFrame = Schema.Union([
  SnapshotStart,
  SnapshotChunk,
  SnapshotCommit,
  Change,
  ResumeReady,
  Reset,
  KeepAlive,
  TerminalError,
]);
export type ReplicationFrame = typeof ReplicationFrame.Type;

export class ReplicationProtocolError extends Data.TaggedError(
  "ReplicationProtocolError",
)<{
  readonly reason: "malformed" | "oversized" | "incompatible-version";
}> {}

const parseBoundedJson = (
  text: string,
  maximum: number,
): Result.Result<unknown, ReplicationProtocolError> => {
  if (utf8.encode(text).byteLength > maximum) {
    return Result.fail(new ReplicationProtocolError({ reason: "oversized" }));
  }
  try {
    return Result.succeed(JSON.parse(text));
  } catch {
    return Result.fail(new ReplicationProtocolError({ reason: "malformed" }));
  }
};

const hasIncompatibleProtocol = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const protocol = (value as { readonly protocol?: unknown }).protocol;
  return Number.isSafeInteger(protocol) && (protocol as number) >= 0 &&
    protocol !== REPLICATION_PROTOCOL_VERSION;
};

export const decodeActivationRequest = (
  text: string,
): Result.Result<ActivationRequest, ReplicationProtocolError> =>
  Result.gen(function* () {
    const json = yield* parseBoundedJson(text, MAX_REPLICATION_REQUEST_BYTES);
    if (hasIncompatibleProtocol(json)) {
      return yield* Result.fail(
        new ReplicationProtocolError({ reason: "incompatible-version" }),
      );
    }
    const decoded = Schema.decodeUnknownResult(ActivationRequest, strict)(json);
    if (Result.isFailure(decoded)) {
      return yield* Result.fail(
        new ReplicationProtocolError({ reason: "malformed" }),
      );
    }
    return decoded.success;
  });

export const decodeReplicationFrame = (
  text: string,
): Result.Result<ReplicationFrame, ReplicationProtocolError> =>
  Result.gen(function* () {
    const json = yield* parseBoundedJson(text, MAX_REPLICATION_FRAME_BYTES);
    if (hasIncompatibleProtocol(json)) {
      return yield* Result.fail(
        new ReplicationProtocolError({ reason: "incompatible-version" }),
      );
    }
    const decoded = Schema.decodeUnknownResult(ReplicationFrame, strict)(json);
    return yield* Result.mapError(
      decoded,
      () => new ReplicationProtocolError({ reason: "malformed" }),
    );
  });

export const encodeActivationRequest = (request: ActivationRequest): string => {
  const encoded = JSON.stringify(
    Schema.encodeUnknownSync(ActivationRequest)(request),
  );
  if (utf8.encode(encoded).byteLength > MAX_REPLICATION_REQUEST_BYTES) {
    throw new ReplicationProtocolError({ reason: "oversized" });
  }
  return encoded;
};

const encodeReplicationFrameUnchecked = (frame: ReplicationFrame): string =>
  JSON.stringify(Schema.encodeUnknownSync(ReplicationFrame)(frame));

/** Validate a frame and measure its complete JSON envelope against the wire bound. */
export const replicationFrameFitsBound = (frame: ReplicationFrame): boolean =>
  utf8.encode(encodeReplicationFrameUnchecked(frame)).byteLength <=
    MAX_REPLICATION_FRAME_BYTES;

export const encodeReplicationFrame = (frame: ReplicationFrame): string => {
  const encoded = encodeReplicationFrameUnchecked(frame);
  if (utf8.encode(encoded).byteLength > MAX_REPLICATION_FRAME_BYTES) {
    throw new ReplicationProtocolError({ reason: "oversized" });
  }
  return encoded;
};

export type ReplicaVersionMetadata = {
  readonly protocol: number;
  readonly build: string;
  readonly storage: number;
  readonly readCompatibilityHash: string;
  readonly readView: string;
};

export type ReplicaCompatibilityDecision =
  | "reuse"
  | "protocol-reset"
  | "build-reset"
  | "storage-migration"
  | "read-compatibility-reset"
  | "read-view-reset";

/** The layer that owns an incompatibility is selected before any wire resume. */
export const decideReplicaCompatibility = (
  stored: ReplicaVersionMetadata,
  current: ReplicaVersionMetadata,
): ReplicaCompatibilityDecision => {
  if (stored.protocol !== current.protocol) return "protocol-reset";
  if (stored.build !== current.build) return "build-reset";
  if (stored.storage !== current.storage) return "storage-migration";
  if (stored.readCompatibilityHash !== current.readCompatibilityHash) {
    return "read-compatibility-reset";
  }
  if (stored.readView !== current.readView) return "read-view-reset";
  return "reuse";
};
