# Versioned Opaque Database Replication Contract

This is the normative version-1 contract for issue #473. It refines
`LIVE-2`–`LIVE-7`, `NI-1`–`NI-3`, and `REV-1` in
[`authorization.md`](authorization.md). The codecs in
`internal/replication/protocol.ts` are the executable source of truth when a
shape or bound is in doubt.

The protocol synchronizes one complete current application snapshot for one
activated root-relative Graph path. It never transports the raw transaction
log, a physical basis, storage roots, server entity or attribute ids, catalog
proofs, rule inputs, or JWT payloads.

## Transport and activation

An authenticated client opens:

```text
POST /db/:configuredRoot/replicate
Content-Type: application/json
Accept: application/x-ndjson
```

The strict request is:

```ts
{
  type: "Activate"
  protocol: 1
  graphPath: readonly string[]
  scope: { type: "database" }
  resumeRevision?: OpaqueId
}
```

The path is relative to the configured root selected by the URL. The client
cannot provide a database id, catalog key, catalog hash, policy identity,
principal cache key, or response identity. Unknown properties are rejected.
The server authenticates first, resolves and authorizes the complete path
against its deployed database registry, and provisions an already-authorized
dynamic child through the normal Graph path machinery.

A compatible successful response is newline-delimited JSON with content type
`application/x-ndjson` and `cache-control: no-store`. One encoded frame plus
one newline is enqueued per stream pull. The response stream has a zero-byte
high-water mark, so the next frame is not constructed until downstream asks
for it. Cancellation aborts authorization work and closes the real Replica
watch.

Protocol incompatibility is HTTP 409 with exactly one version-1
`TerminalError` whose code is `incompatible-version`. Malformed or oversized
activation is the ordinary opaque invalid-request response. Version 1 emits no
heartbeat; transport silence is its liveness behavior.

## Opaque identity and revision

Every data-bearing frame carries one server-derived identity:

```ts
{
  version: 1
  server: OpaqueId
  principal: OpaqueId
  database: OpaqueId
  catalog: OpaqueId
  readView: OpaqueId
  authenticator: OpaqueId
}
```

Each `OpaqueId` is a 32-byte digest encoded as 43 unpadded base64url
characters. The fields are independent domain-separated HMACs under the
server's internal secret. `authenticator` covers the other fields.

- `server` partitions the public server namespace.
- `principal` covers verified claims and sorted classes, excluding token
  expiry and issued-at. Ordinary token refresh is therefore stable; subject,
  claim, or class replacement is not.
- `database` covers the server-resolved stable target database.
- `catalog` covers its permanent deployed catalog key.
- `readView` covers deployment identity, principal, configured root, complete
  path, every route database/catalog/unit, and every ancestor dependency.

Client-visible entity and reference identities are HMACs of their internal
entity ids inside this authenticated partition. They are stable for the same
partition and unlinkable across partition transitions. Logical state is
hashed from the complete authorized datom sequence. An authorized revision is
an HMAC of that state digest and the identity authenticator. Hidden-only
physical state therefore neither changes the revision nor changes snapshot
bytes.

The client treats every identity field and revision as opaque. Decoding a JWT
or an opaque id never grants cache authority.

## Logical datoms

A wire datom is:

```ts
{
  entity: OpaqueId
  field: string
  value:
    | { type: "long"; value: number }
    | { type: "double"; value: number | "positive-infinity" | "negative-infinity" }
    | { type: "string"; value: string }
    | { type: "boolean"; value: boolean }
    | { type: "ref"; value: OpaqueId }
    | { type: "uuid"; value: string }
    | { type: "instant"; value: number }
    | { type: "bytes"; value: string }
  op: "add" | "retract"
}
```

The database places no smaller replication-specific limit on a stored string
or byte array. A value that does not fit the bounded scalar codec is carried
in snapshot datoms as ordered `string-part` or `bytes-part` values. Every part
contains an opaque logical-value identity, zero-based index, total part count,
and at most 131,072 bytes of text. Non-final byte parts encode exactly 98,304
raw bytes, so their canonical base64 text concatenates without padding. The
client validates a complete, nonconflicting part set and reassembles the
logical string/base64 value only when `SnapshotCommit` atomically installs the
snapshot. A delta involving a fragmented value uses `Reset` plus a chunked
snapshot; `Change` retains its separate 1 MiB bounded-delta policy.

`field` is the deployed logical field ident. Bytes are canonical base64, UUIDs
are canonical lowercase UUIDs, longs/instants are safe integers, and the two
JSON-inexpressible double infinities use the exact markers above. Snapshot
datoms always have `op: "add"`. A `Change` may contain additions and
retractions. No physical eid, attribute eid, value tag, transaction eid,
transaction time, basis, storage root, policy input, queue position, or count
exists in this representation.

## Frames and server transitions

Every frame has `protocol: 1` and is one of:

| Frame | Required payload | Meaning |
|---|---|---|
| `SnapshotStart` | identity, snapshot, revision | Begin staging one complete authorized value. |
| `SnapshotChunk` | identity, snapshot, zero-based index, add datoms | One bounded ordered part; never queryable by itself. |
| `SnapshotCommit` | identity, snapshot, revision, chunk count | Atomically install the staged value. |
| `Change` | identity, from revision, revision, datoms | Atomically move one complete authorized value to another. Multiple physical bases may be conflated. |
| `Reset` | identity | The old resume basis or partition cannot be reused; a snapshot follows. |
| `KeepAlive` | identity | Reserved fixed-shape liveness frame. Version 1 does not emit it. |
| `TerminalError` | fixed code, optional identity | Close opaquely or report wire incompatibility. |

First sync is `SnapshotStart`, zero or more `SnapshotChunk`, then
`SnapshotCommit`. The server hashes a complete authorized prepass, streams
bounded chunks packed against the actual complete frame envelope, renews
authorization for delayed chunks, checks every
remaining old-snapshot chunk against the newest authorized value after a
renewal, and rescans before commit. If the authorized revision changed, it
restarts without committing the abandoned snapshot.

Resume resolves the opaque revision through a private mapping in a
binding-addressed Replica Durable Object. Each authenticated partition owns an
independent fixed quota of eight revisions; there is no shared admission or
eviction pool. A new revision can evict only the oldest revision in that same
object. Distinct authenticated partitions allocate distinct bounded objects,
so pressure in one partition cannot change another partition's first snapshot
or later resume result. A hidden-only advance updates the private basis of its
unchanged revision without changing that record's age or eviction order. The
raw basis never leaves the internal route. Missing, evicted, mismatched, or
unreconstructable records all produce the same `Reset` followed by a snapshot.

At each fixed cycle, a changed target basis makes the server reconstruct the
prior authorized value at the private basis, diff it against the newest
complete authorized value, and recheck the final revision before emission. A
visible diff is one atomic `Change`. No diff means silence and the private
mapping advances without a public revision transition. More than 256 changed
datoms or 1 MiB of changed datoms produces opaque `Reset` plus a chunked
snapshot instead of an unbounded delta.

The real Replica wake queue has capacity one with sliding/latest semantics.
A conflated change is also a valid initial-ready handshake because ordered
WebSocket delivery proves readiness preceded it. Notifications only update
that latest slot. After the ready handshake, replication does not drain
notification values; a separate failure-only signal detects watch closure.
Notifications never schedule authorization, hashing, diffing, a heartbeat, a
timer, or a replication-loop iteration. One activity-independent cycle is
fixed to the settled complete-path lease cadence (no later than five seconds).
Every cycle reauthorizes the complete path. An unchanged target basis then
skips the logical scan; a changed basis advances once at that same fixed slot.
The next deadline retains the prior phase, skips missed slots without catch-up
work, and is shortened for an earlier token expiry. Thus zero hidden activity
and an arbitrary hidden burst have the same cycle/checkpoint ordering, hidden
work cannot queue extra cycles, and later visible work never waits behind a
hidden-scheduled cycle. Exactly one cycle timer is live and cancellation closes
it and the watch promptly.

## Client transition table

The pure reference transition machine never mutates its input. `committed` is
the only queryable value; `staging` is not.

| Current state and frame | Transition | Queryable result |
|---|---|---|
| Any, `Reset` with same identity | Discard staging; retain prior complete value until replacement commits. | Prior complete value. |
| Any, `Reset` with new identity | Discard staging and retained data; select new partition. | Empty. |
| Any, `SnapshotStart` | Create fresh staging; retain prior value only for the same identity. | Prior complete value or empty. |
| Matching staging, new `SnapshotChunk` | Store the immutable indexed chunk. | Unchanged. |
| Matching staging, identical duplicate chunk | Ignore. | Unchanged. |
| Matching staging, conflicting duplicate chunk | Fail the transition. | Unchanged. |
| Missing/wrong staging, chunk | Ignore, except identity mismatch fails. | Unchanged. |
| Commit with every index `0..chunks-1` exactly once | Validate no duplicate facts; atomically replace `committed`. | New complete value. |
| Incomplete, stale, or reordered commit | Ignore. | Unchanged. |
| `Change.from` equals committed revision | Apply all additions/retractions to a copy, then atomically replace. | New complete value. |
| Duplicate `Change.revision` | Ignore. | Unchanged. |
| Stale/unrelated `Change.from` | Ignore and reconnect/resume conservatively. | Unchanged. |
| Mismatched frame identity | Fail the transition. | Unchanged. |
| `TerminalError` | Discard staging, close, and retain data only when the identity still matches. | Prior complete value or empty. |

Ordered transport is expected, but duplicate, interruption, reordering, and
stale input can therefore expose only the preceding complete value or one
newly committed complete value.

## Authorization and noninterference

Initial admission and every fixed lease renewal rerun the complete ordered Graph
path through the one deployed authorization evaluator. A stream is fixed to
the admitted path identity and may not migrate when a mutable Graph name,
ancestor entity, child database, catalog unit, principal, or deployment
changes. The next authorization fence occurs no later than five seconds after
the preceding admitted lease, including while idle.
Failure emits only the fixed `closed` terminal envelope; reconnect under a new
partition follows the opaque reset path.

Only the target's `filteredDb` reaches logical projection, hashing, snapshot,
or diff code. A hidden-only commit emits no data frame, revision, reset,
sequence gap, count, queue metadata, heartbeat, or diagnostic close reason.
Repeated hidden commits conflate without running an advance and cannot
accumulate memory or proportional visible-frame latency.

The legacy `/session` `ClientFrame`/`TxPushFrame`/`ResyncFrame` wire remains
testing-only and publicly fail-closed. `/replicate` neither accepts nor emits
its raw `t` values and is not an alias for it.

## Bounds and version ownership

| Item | Version-1 bound |
|---|---:|
| Activation JSON | 65,536 UTF-8 bytes |
| One encoded frame | 1,100,000 UTF-8 bytes |
| Path segments | 1,024 |
| Path segment / field ident | 4,096 UTF-8 bytes |
| Scalar string / base64 value or snapshot value part | 131,072 UTF-8 bytes |
| Non-final raw byte value part | 98,304 bytes |
| Snapshot datoms per chunk | 16 |
| Change datoms | 256 and 1,048,576 encoded bytes |
| Private resume records per authenticated binding object | 8 revisions |

Protocol, client build, local storage, and read-view versions have separate
owners. Protocol mismatch resets at the wire layer. Client build mismatch
resets the derived client representation. Storage version mismatch invokes
the storage migration layer, which must reset if it cannot migrate atomically.
Read-view mismatch resets the authenticated data partition. These decisions
are made before a resume token can be reused.
