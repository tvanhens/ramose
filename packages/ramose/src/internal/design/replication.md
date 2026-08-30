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
It never deletes the IndexedDB database or the mutation store families —
#475's outbox, queue cursors, receipts, ClientRefs and their mappings, or
#476's future optimistic layers.

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
stores. The mutation store families — outbox, queue cursors, receipts,
ClientRefs and their mappings, and #476's future optimistic layers — are keyed
by the stable server/principal/database triple rather than by the replica
partition, so a read-view change or a database eviction leaves them intact.
They are never part of candidate lookup or rebinding, and only an explicit
scoped clear removes them, in the same transaction as the replicas.

## Integrity validation and corruption recovery

Every restore path — cold restore, confirmed-candidate restore, and exact
credential-bound restore — validates the whole partition before any `Db` can
exist.

First the committed manifest. It must be this storage version, be filed under
the partition its own identity derives, state a complete identity (nothing may
be compared against a half-identity, which would throw before anything could
classify the record), agree with itself and the installed client about the
confirmed compatibility hash, carry four well-formed index roots whose counts
are consistent, and describe a value it can actually materialize: every stored
attribute well formed and numbered, every partition-local id in the user range
and below the allocator, no id claimed twice across the entity and attribute
maps, and every kept fact an assertion with a complete value whose entity,
field, and referent all have local ids. The journal is held to the same standard
as the value, because the next `Change` rebuilds the whole committed set from
it.

Then every node reachable from those four roots: it must exist in this
partition's node store, hash to the content address it is filed under, decode,
and sit in a position its own body agrees with — the index it was encoded for,
the referenced node kind, the referenced subtree count, the directory's
key/child arity, index order within a leaf and across a directory's keys, and
the separator its parent filed it under, which is always the smallest datom of
its own subtree. A bulk build gives every reachable node of one value a distinct
address, so a repeated address is itself a structural failure and also bounds
the walk.

Finally the conclusions only a completed walk can reach. A manifest keeps two
descriptions of one value — a logical journal of authorized facts, and four
physical index roots built from it — and the local id maps and stored schema sit
between them. The roots are the one part no content address covers, so a damaged
manifest can pair one index's current root with a superseded root of the same
size, and a drifted journal is invisible to the first restore but rebuilds a
different value at the next `Change`. Restore therefore replays the shared
logical-to-physical projection the install used, folding a commutative digest
over the bootstrap datoms, the stored schema datoms, and every journal fact,
partitioned by each index's own membership rule. Each walked tree must equal the
tree the manifest describes. Comparing whole datom sets would need both sides
resident; the fold costs one hash per fact and holds four fixed-size digests.
It also carries the largest transaction number, which must equal the manifest's
claimed basis: that value becomes the restored `basisT`, and lowering it filters
intact facts out of every read.

The walk is depth-first, so it costs one read, one digest, and one decode per
reachable node, plus one comparison and one fold step per datom, and holds a
bounded batch of node bodies at a time. A walk that stops part-way yields no
value at all; a partial `Db` is never constructed.

Missing node, hash mismatch, structural invariant violation, and undecodable
record are classified separately for diagnosis and collapse to one caller
outcome: this partition must be replaced by a fresh snapshot. An intact replica
whose compatibility hash or replica schema disagrees with the installed client
is the other outcome: the client must update first. Both are returned as typed
outcomes rather than thrown, and wrong-generation interactions keep surfacing
the ordinary typed fence errors.

Quarantine withdraws exactly one
server/principal/database/read-view/compatibility partition from selection: its
committed manifest, its head, and the exact credential binding and cache
candidate that would nominate it again. Nothing can restore or resume it
afterwards. Its content nodes are deliberately left to reachability GC, and its
staging with them: a `Db` another session has already published holds its own
roots and node store and no longer depends on the manifest, so deleting the
nodes underneath it would turn a stale value into one that throws mid-query,
while leaving them costs only space until the sweep. They are inert in the
meantime — unreachable from any manifest — and re-installing the same value
rewrites each node under its own address, repairing a damaged body in passing.

Sibling read views, sibling databases, other principals, other servers, the
scope's durable confirmation and generation, its route observations, and the
future outbox, receipt, ClientRef, and optimistic families are all preserved — a
corrupt committed read value is never a reason to discard a durable operation
identity. Because withdrawal is still destructive it is generation-fenced like
clearing and eviction, and the whole quarantine is one IndexedDB transaction, so
a crash cut leaves the corrupt partition exactly as it was and a retry completes
it.

### The publish fence

Reading a partition and acting on it are never one atomic step. A walk takes as
long as reading the replica, and a staged snapshot outlives the connection that
began it. Destructive maintenance in another handle sees neither — a restore
holds no pin until its caller has a value, and staging is not a participant — so
rather than widen what maintenance can see, every path states one invariant:

> Nothing derived from an earlier read of a partition may become observable or
> durable until, in one IndexedDB transaction at the moment it becomes
> load-bearing, the derivation re-confirms both the durable generations guarding
> that partition and the committed state it assumed.

The generations are what a clear or an eviction moves, and only those two delete
content nodes, so re-observing them is exactly what separates "the value I
validated is still mine to publish" from "its nodes were deleted while I was
reading them". An ordinary install moves the committed state instead, and leaves
a validated manifest and its nodes entirely intact — publishing it is the older
of the old-or-new complete values a caller is promised, not a mixture — so each
path re-confirms only the part of the committed state its own derivation
depended on. Every path derives from the one invariant:

- a **restored replica** re-confirms the generations in `validated`, the single
  place cold restore, bound restore, and confirmed-candidate restore all funnel
  through, after the walk and before the manifest can be handed back;
- a **quarantine** re-confirms the exact manifest it refused, by revision, root
  addresses, basis, allocator, and stored-map sizes;
- a **snapshot start** re-confirms that the base revision its staging recorded
  is still the committed one, and rebases the staging when it is not — a
  snapshot identity is a deterministic function of identity and revision, so a
  reconnect resumes the very same staging, and a base its commit can never
  satisfy again would strand the partition on every following attempt;
- a **snapshot commit** and a **change apply** re-confirm their base revision
  inside the very transaction that installs;
- a **restored replica** additionally re-confirms the partition's sweep
  generation, because reachability GC is a second writer that deletes nodes
  without touching a manifest (see below).

A failed generation re-check surfaces the ordinary typed fence error; a failed
committed-state re-check reports that nothing is selected, so the caller chooses
again from what is actually stored.

Validating a partition takes as long as reading it, so another session may
install a complete replacement while a walk is still running. Withdrawal is
therefore conditional on the refused manifest still being the stored one,
compared by revision, the four root addresses, the basis, the allocator, and the
size of every stored map, and the install identifier. A refusal that loses that
comparison withdraws nothing and reports that nothing is selected, rather than
acting on a value it never examined. For the same reason a restore that ran
after a snapshot had begun streaming would quarantine underneath the replacement
being received, so the session validates the committed value before it stages
that snapshot's first frame.

The install identifier is what makes that comparison complete. A re-install of
the *same* revision rebuilds identical roots and identical maps, so nothing the
record says about its own value can separate the manifest that was refused from
a repaired one written in its place — and a repair is exactly what a
re-install of the same revision is: it rewrites the damaged node under its own
address. Every install therefore stamps the manifest with an identifier unique
to the act of installing rather than to the value, which nothing authorizes
anything with and which never leaves the device. Manifests written before that
field existed carry none and compare as absent on both sides, so their behavior
is unchanged.

One `Db` construction is deliberately not preceded by a walk: the duplicate or
out-of-order `Change`, which installs nothing and hands back the value already
committed. A session reaches that path only after it restored the partition
through the walk or installed a snapshot into it, so the manifest it reads is
that one or a strictly later install some live client materialized — never a
cold unverified record. The only check worth making there is a full walk, a
partial one would pass over exactly the damage it skipped, and at 100k datoms
that walk costs a whole cold restore per duplicate frame. Damage appearing
afterwards is caught by the next restore's walk, with every other stored-node
failure.

## Reachability GC and bounded quota recovery

A committed replica is content-addressed and immutable, so every install writes
a new set of nodes and abandons the ones it superseded. At 100k datoms a whole
replica is 81 nodes and 430 KiB, and one changed datom orphans 62 of those 81
immediately. Quarantine leaves a partition's nodes and staging behind by design,
and a failed install leaves the nodes it had already written. Reclaiming that is
one sweep, and the only interesting part of it is what it may never delete.

### Retention

A node record is *retained* when it is reachable from a live root set of its own
partition. Reachability is partition-local by construction: node records are
keyed by `[partition, hash]`, so no partition can keep another's node alive. The
live root sets are exactly:

1. the four index roots of the partition's committed manifest, when one is
   stored;
2. every root set an in-process holder has retained — a replication session
   retains the roots of the value it currently publishes, including a stale
   value published over a partition that has since been quarantined;
3. nothing at all for a partition with an in-flight materialization: its fresh
   nodes have no roots yet, so that partition is excluded from the sweep
   entirely rather than described by a root set.

Everything else in the partition is unreachable from every value a live
participant can read, and is swept. One thing is deliberately *not* retained: a
`Db` older than the one its session currently publishes. Reclaiming superseded
roots is the entire point of the sweep — they are where the garbage comes from —
so a holder that needs an older value to stay readable must retain it. GC never
writes a manifest, a head, a binding, or a candidate, so no install identifier
can be dropped or invented by a sweep, and `writeCounts()` shows zero manifests
and zero heads for any GC pass.

### Sweep invariants

- **Fail closed on damage.** The live set is computed by walking each live root
  set. A walk that cannot complete — a missing, undecodable, or wrongly-kinded
  node — leaves the partition's live set unknown, and GC then sweeps nothing in
  that partition. Damage is never converted into deletion; the restore walk is
  what classifies and quarantines it.
- **Materialization exclusion.** An install marks its partition in flight
  synchronously before materialization creates its first node transaction, and
  clears the mark only after the install transaction settles — closing the
  storage handle does not clear it, because a closed IndexedDB connection still
  runs the transactions it already created to completion. GC reads that mark and
  creates its sweep transaction in one synchronous block, with no `await`
  between them. Either GC saw the mark and skipped the partition, or the
  materialization had not yet created a node transaction — and every transaction
  it creates afterwards is created after the sweep transaction. IndexedDB
  serializes overlapping `readwrite` transactions in creation order, so a
  content-addressed re-put of a node the sweep is deleting always lands after
  the delete, never before it.
- **Sweep CAS.** The live set is computed from a committed manifest read outside
  the sweep transaction. The sweep transaction re-reads that manifest and
  requires its fingerprint — including the install identifier — to be unchanged.
  A sweep is therefore always consistent with the committed value as of the
  instant it commits, and a partition whose manifest moved is skipped rather
  than swept against a value nobody examined.
- **Retention re-check.** The manifest CAS does not cover retention, because a
  restore that validated an *older* manifest publishes without moving the
  manifest at all: the session retains those roots synchronously as it
  publishes, and the pass may have computed its live set before that happened.
  The same synchronous block that reads the materialization mark therefore
  re-reads the retained roots, and skips the partition when one has appeared
  that the live set does not already cover. A root that has gone since is
  harmless — the live set was simply more generous than it needed to be.
- **Only impossible staging.** Staging is swept only when its recorded base
  revision is no longer the committed one, which is exactly the condition under
  which its `SnapshotCommit` can never install again. A snapshot still streaming
  against a current base is never touched, and a reconnect rebases the stale
  case anyway.
- **One transaction.** The generation bump, the node deletes, and the staging
  deletes are one IndexedDB transaction with a boundary immediately before its
  commit, so a crash cut leaves either the complete pre-sweep state or the
  complete post-sweep state. Both are states a later walk accepts, because the
  swept set was provably unreachable from the committed manifest either way.

### The sweep generation

The publish fence rests on one premise: only a clear and an eviction delete
content nodes, and both bump a generation the fence re-observes. GC deletes
nodes without touching a manifest, so it must either take that same fence or
break it. Two mechanisms were available.

Bumping the guarded **database** generation was rejected. Every live session of
that database leases that record, so a sweep would refuse those sessions' next
install with the ordinary fence error — and sweeping superseded roots while a
session is running is the normal case, not the exception. GC would then be
unable to reclaim anything without disturbing exactly the sessions it must leave
alone.

Instead GC bumps a per-partition **sweep generation**: one more record in the
same `replica-generations-v1` store, under the same discipline of being readable
inside any transaction, with exactly one writer (a sweep that deleted at least
one node) and exactly one reader (the restore publish fence). `validated` reads
it in the same transaction that takes the walk's lifecycle lease, before the
walk, and re-reads it in the same transaction that re-confirms the scope and
database generations, after it. A changed value means nodes were deleted in this
partition while the walk was running, so the manifest it read is no longer safe
to publish.

That outcome says nothing about the partition — only about this attempt — and
commonly the partition is untouched, because a sweep reclaims superseded roots
while the current manifest stands. Reporting an absence there would strand an
offline restore that has no other way to obtain the value, so the restore reads
the stored record again and walks it again, up to a small bounded number of
attempts, and reports nothing selected only if sweeps keep landing in the same
window. A clear or an eviction keeps surfacing the ordinary typed fence error,
unchanged.

The install paths deliberately do not observe the sweep generation. They are
protected by materialization exclusion instead: GC cannot delete the nodes an
install is writing, so an install has nothing to re-confirm — and observing it
would fence the very sessions that exclusion exists to leave running.

### Bounded quota recovery

Native quota exhaustion is a typed outcome, not a corruption. `QuotaExceededError`
and the historical browser spellings — Firefox's `NS_ERROR_DOM_QUOTA_REACHED`
and legacy code 1014, Safari's `QUOTA_EXCEEDED_ERR` and legacy code 22 — are
classified together; everything else propagates unchanged.

An install that fails that way performs at most one GC pass and at most one
retry. The failed attempt's own nodes are unreachable, so the pass reclaims them
along with every superseded root, and the pass runs between the two attempts —
after the first attempt released its materialization mark, before the retry
takes it — so the partition that needs the space is not the one partition GC
skips. The pass is unscoped, because storage pressure is a property of the
origin rather than of one principal, and it can still only delete what is
provably unreachable.

If the retry also exhausts quota, the install throws a typed quota error
carrying what the pass reclaimed. Nothing was installed: materialization writes
only content nodes, and the install itself is one atomic transaction, so the
previously committed manifest is byte-identical to what it was and the
old-or-new guarantee holds. Active data is never evicted to make room.

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
