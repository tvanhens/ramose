# Versioned Opaque Database Replication Contract

This is the normative version-1 contract for issues #473 and #533. It refines
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
  readCompatibilityHash: ReadCompatibilityHash
  resumeRevision?: OpaqueId
}
```

The path is relative to the configured root selected by the URL. The client
cannot provide a database id, catalog key, catalog hash, policy identity,
principal cache key, or response identity. Unknown properties are rejected.
The server authenticates first, resolves and authorizes the complete path
against its deployed database registry, and provisions an already-authorized
dynamic child through the normal Graph path machinery.

`readCompatibilityHash` is a full untruncated SHA-256 encoded as 43 canonical
unpadded base64url characters. Its domain-separated canonical descriptor
contains only normalized fields, entities, traits, trait composition, and the
versioned Graph-read interpretation needed to construct/query the local `Db`.
Catalog scoping is stripped from those local names because permanent catalog
identity is authenticated separately.
Operations, executable codecs, projections, deployment identity,
documentation, defaults/callbacks, and client build identity are absent. The
server authenticates and resolves the complete authorized path before
comparing this value with the target catalog. A mismatch is HTTP 409 with
exactly one `TerminalError` whose code is `update-required`, and no
data-bearing frames. It is not a `Reset`; `ResumeReady` is possible only after
agreement.

A compatible successful response is newline-delimited JSON with content type
`application/x-ndjson` and `cache-control: no-store`. One encoded frame plus
one newline is enqueued per stream pull. The response stream has a zero-byte
high-water mark, so the next frame is not constructed until downstream asks
for it. Cancellation aborts authorization work and closes the real Replica
watch.

Protocol incompatibility is HTTP 409 with exactly one version-1
`TerminalError` whose code is `incompatible-version`. Malformed or oversized
activation is the ordinary opaque invalid-request response. Version 1 emits no
heartbeat; transport silence after the one-shot activation result is its
liveness behavior.

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
  readCompatibilityHash: ReadCompatibilityHash
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
- `readCompatibilityHash` is the server-confirmed target descriptor above.
- `readView` covers only authorized-read semantics: each ordered stable route
  database, its read compatibility, the installed read-only policy subset,
  versioned Graph-read semantics, and every ordered stable ancestor
  database/entity dependency. Configured-root spelling, mutable Graph path
  text, deployment/version identity, operation bodies/hashes and
  operation-only codecs/rules, documentation/default metadata, projections,
  and client build identity are excluded.

Consequently an operation-only or deployment-only change preserves
`readView`, entity identities, revisions, and replica eligibility. Stored
schema, entity/trait composition, read-policy, or Graph-read semantic changes
rotate compatibility. Principal, stable database, and permanent catalog
remain separate authenticated identity dimensions.

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
| `ResumeReady` | identity, revision | One-shot proof that a supplied, resolved committed revision is still the complete current authorized value. |
| `Reset` | identity | The old resume basis or partition cannot be reused; a snapshot follows. |
| `KeepAlive` | identity | Reserved fixed-shape liveness frame. Version 1 does not emit it. |
| `TerminalError` | fixed code, optional identity | Close opaquely, report wire incompatibility, or require a compatible client. |

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

A supplied resume revision that resolves in that authenticated binding always
takes the complete logical reconstruction, authorization, projection, digest,
and final current-revision validation path. If the resulting authorized
revision is unchanged, the server emits exactly one `ResumeReady`, after the
real watch is ready and immediately before entering the steady-state cycle.
A visible difference emits only `Change`; an unavailable or incompatible base
emits only `Reset` followed by a snapshot. Neither path also emits
`ResumeReady`. It is an activation result, never a periodic heartbeat.

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
That failure signal is an active abort source from the moment the watch is
attached, including initial authorization, snapshot projection and chunk
checks, resume reconstruction, checkpoints, and fixed-cycle waits. A watch
failure can therefore emit only the opaque `closed` terminal after any
uncommitted staging frames; it cannot emit another state-bearing frame or a
snapshot commit. The same fence applies before `ResumeReady`. Client
cancellation remains distinct and closes silently.
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
| `ResumeReady` with matching identity and committed revision | Accept idempotently; install no data and change no revision. | Existing complete value. |
| `ResumeReady` with missing/wrong committed revision | Fail the transition; never mark the retained value current. | Unchanged. |
| Mismatched frame identity | Fail the transition. | Unchanged. |
| `TerminalError` | Discard staging, close, and retain data only when the identity still matches. | Prior complete value or empty. |

Ordered transport is expected, but duplicate, interruption, reordering, and
stale input can therefore expose only the preceding complete value or one
newly committed complete value.

## Durable compatibility agreement

The confirmed compatibility hash is part of the authenticated identity, the
physical replica partition key, and every committed manifest. It is therefore
covered by the identity authenticator; restore also requires the manifest's
copy and identity copy to agree before following its content-addressed roots.
Restore and credential-bound restore require the
currently installed client hash and compare it before `dbFromRecord` or any
other `Db` construction. A mismatch removes only that committed replica,
its committed head and local candidate bindings, staging/chunks, its
partitioned content-addressed nodes, and its exact local credential binding.
It never deletes the IndexedDB database or future outbox, receipt, client-ref,
or optimistic store families.

IndexedDB schema version 4 upgrades the landed replica stores conditionally.
Compatible version-2/3 manifests carrying the confirmed hash survive. Legacy
manifests and bindings without it are incompatible and are quarantined; they
are never interpreted as local schema metadata. Incomplete pre-agreement
staging is discarded. Online activation must establish a fresh compatible
snapshot after quarantine.

## Local token-refresh candidate

The internal browser session accepts an optional local `cacheKey` foundation
for the public refreshable auth provider owned by #477. It has no protocol
field and grants no authority. The client persists only a domain-separated
full SHA-256 selector over the canonical server origin, configured root, and
raw key. A separate domain-separated route-slot digest addresses the current
root-relative Graph path for lookup only. Neither digest participates in
`ReplicationIdentity`, `readView`, the committed partition key, or server
authorization.

An exact previously authenticated bearer fingerprint retains its existing
behavior: a compatible committed value may be constructed and published stale
before the network opens. A changed bearer can use the stable selector only to
read an authenticated identity, revision, and manifest existence from a small
committed-head sidecar. The sidecar is installed or deleted atomically with its
committed manifest and is backfilled during the version-4 upgrade. That
metadata path never reads the heavy committed record, follows content nodes, or
constructs a `Db`; its revision may be sent as `resumeRevision` while the
candidate remains unobservable.

The first complete, strictly decoded identity-bearing response frame must
confirm the installed `readCompatibilityHash`. A candidate becomes usable only
through one of these valid initial transitions:

- matching `ResumeReady` constructs and publishes the confirmed revision as
  current;
- matching `Change` applies the authoritative change first and publishes only
  the new value;
- authenticated `Reset` or `SnapshotStart` may locate the confirmed identity's
  already committed partition and publish it stale while replacement staging
  proceeds;
- a matching reserved `KeepAlive` may expose only a stale value; an
  identity-bearing terminal may update bindings but exposes no rotated-token
  candidate.

An initial snapshot chunk/commit, change gap, mismatched resume, identity-free
terminal, schema mismatch, malformed/truncated first frame, or fetch failure
cannot confirm or publish a candidate. Exact credential and optional stable
selector records are rebound together only after a valid current authenticated
frame. A colliding selector is therefore just a nomination: wrong-principal
confirmation replaces its metadata without ever loading the nominated value.
Because committed partitions use stable authenticated identity rather than the
route slot, a renamed Graph path can recover the same partition after current
authorization and then bind its new opaque slot even when it supplied no resume
revision.

The `replica-cache-candidates-v1` and `replica-committed-heads-v1` object stores
are separate from heavy committed manifests, exact credential bindings,
staging, and content nodes. Candidate selection reads only those two bounded
stores. Future outbox, receipt, ClientRef, and optimistic-layer stores remain
independently clearable and are never part of candidate lookup or rebinding.

## Authorization and noninterference

Initial admission and every fixed lease renewal rerun the complete ordered Graph
path through the one deployed authorization evaluator. A stream is fixed to
the admitted path identity and may not migrate when a mutable Graph name,
ancestor entity, child database, read compatibility, or principal
changes. The next authorization fence occurs no later than five seconds after
the preceding admitted lease, including while idle.
Failure emits only the fixed `closed` terminal envelope; reconnect under a new
partition follows the opaque reset path.

Only the target's `filteredDb` reaches logical projection, hashing, snapshot,
or diff code. A hidden-only commit emits no data frame, revision, reset,
sequence gap, count, queue metadata, heartbeat, or diagnostic close reason.
Repeated hidden commits conflate without running an advance and cannot
accumulate memory or proportional visible-frame latency.

For activation resume specifically, equality of the private physical basis is
not a shortcut. A zero-physical-change world and a hidden-only-physical-change
world with the same complete authorized logical value execute the same
implementation-scheduled reconstruction, logical validation, and pre-emission
checkpoint path, then emit byte-identical `ResumeReady` frames in the same
position. No basis, hidden count, alternate scheduling signal, or timing
metadata crosses the boundary.

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
