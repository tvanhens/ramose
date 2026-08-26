# Authorization and Noninterference Contract

Normative security contract for the Ramose engine. This is the ideal final
state. Later authorization work implements these invariants; it does not
negotiate them. Public website docs, guides, and examples are not a source
of truth for this contract.

Invariants are labeled `NI-1`, `TCB-2`, … so conformance tests and later
design work can cite them. Ambiguous cases default to deny and MUST NOT
reveal whether protected data exists.

This document is the contract only. It does not schedule remaining work.

Terms used below:

- **Principal** — verified JWT caller bound to one database, with classes and claims from the active catalog policy.
- **Ordinary principal** — a principal without an explicit grant to observe control-plane or operational metadata.
- **Datom** — one `[e, a, v, t, op]` fact.
- **Basis** — the root + novelty + `t` from which a snapshot is built.
- **Authorization epoch** — the lease generation that increments on reauthorization or revocation.
- **Application consumer** — any path that shapes an external result, error, live delta, or API-visible metadata.

## 1. Noninterference

**NI-1.** Unauthorized datoms MUST NOT affect any application-visible
behavior. That includes query results, pull results, live-query updates,
session replication, operation read-after-write, errors, empty vs missing
distinctions, counts, estimates, cardinality oracles, API-exposed timing
or explain metadata, transaction identifiers, planner details, storage
statistics, and silence vs delivery decisions.

**NI-2.** Two databases that differ only in unauthorized facts MUST be
observationally identical to a given principal. This is the paired-world
statement of **NI-1**.

**NI-3.** Observation includes indirect channels: refs, reverse refs,
graph paths, nested pull, trait roots, as-of and history views, live
deltas, error codes and bodies, and any metadata the API returns.

**NI-4.** Query shape, plan, index choice, cache hit, and whether
pushdown ran MUST NOT change the authorized result or any disclosure
covered by **NI-1**.

## 2. Trusted computing boundary

Three snapshot capabilities exist. They are distinct types, composed,
never subtypes of one another. Inheritance, casts, public constructors,
and generic `Db` passing MUST NOT recover a more privileged capability.

| Capability | Who holds it | What it sees |
|---|---|---|
| Raw snapshot | Storage, transactor, indexer | Privileged facts at a named basis |
| Rule snapshot | Policy evaluator only | Trusted current rule basis for grant and traversal lookup |
| Application snapshot | Query, pull, live, session, operation results | Principal-filtered facts only |

**TCB-1.** Storage produces a raw snapshot. Application-facing code MUST
NOT obtain a raw or rule snapshot, pass one to query or pull, or stream
one to a client.

**TCB-2.** The policy evaluator receives a rule snapshot over a trusted
current rule basis. It MAY follow grant edges and fixed-depth refs that
the principal cannot read. Those lookups MUST NOT appear in the
application snapshot.

**TCB-3.** Every external read consumes only an application snapshot
produced by the authorized datom cursor (**CUR-1**).

**TCB-4.** Constructing an application snapshot REQUIRES a verified JWT
principal, compiled authorization IR for the active catalog, that
catalog's identity and version, and explicit application and rule bases.
If any of those are missing, invalid, incomplete, or mismatched, construction
MUST fail closed (**FC-1**).

**TCB-5.** Internal Cloudflare and service bindings are a separate
non-public trust capability. Request headers, bodies, query strings, and
WebSocket frames MUST NOT supply or impersonate them.

**TCB-6.** Control-plane actions (raw access, catalog or policy install,
administration) require either unreachable internal capability injection
or a verified service JWT with an explicit grant. Obscure routes are not
a security boundary.

## 3. Mandatory enforcement boundary

Reads physically merge segment trees with novelty, then collapse to the
current, as-of, or history view (`packages/ramose/src/internal/core/db.ts`,
`novelty.ts`). That physical `Db` is not an application snapshot.

**CUR-1.** The lowest mandatory enforcement boundary is the authorized
datom cursor: after segment and novelty merge and current / as-of /
history collapse, before any application consumer.

Application consumers include the query planner and executor (caller
clauses), pull and nested pull, entity reads, reverse refs, aggregation,
count, estimate, error classification, live initial results and deltas,
session snapshot / `tx` / `resync`, operation return values, and any
API-exposed metadata.

**CUR-2.** There is exactly one mandatory visibility evaluator for all
external read shapes. No query, pull, live, or session entry point may
bypass it or accept a raw or rule snapshot.

**CUR-3.** The cursor filters datoms. A datom the principal cannot read
MUST NOT be yielded, counted, estimated, hashed into a cache key that
escapes the trusted boundary, or used to choose an error.

**CUR-4.** Policy evaluation and transactor internals are not application
consumers. They use rule and raw snapshots respectively and stay inside
the trusted computing boundary.

## 4. Pushdown is an optimization

**OPT-1.** Pushdown (access-plan hints, candidate narrowing at index or
segment retrieval, clause rewrite) is optional defense in depth. It MUST
NEVER disable, skip, or replace the authorized datom cursor.

**OPT-2.** A pushdown result is a conservative hint: it MAY include extra
candidates and MUST NEVER exclude an authorized datom. False-negative
pushdown is forbidden by construction.

**OPT-3.** Policies that cannot be pushed (including traversal-dependent
rules) fall back to cursor-only evaluation. That fallback changes
performance only.

**OPT-4.** Covered-query flags, enter/exit pushdown modes, and any state
that skips enforcement are forbidden. Disabling pushdown MUST leave
results and disclosure unchanged (**NI-4**).

## 5. Identity

**ID-1.** Every application entity has exactly one engine-owned
entity-type stamp (`:ramose/type`) and all transitive trait stamps
(`:ramose/trait`).

**ID-2.** The engine and transactor own membership datoms. Clients and
operation bodies MUST NOT forge, omit, or mutate them. Attempts fail
atomically.

**ID-3.** Type and trait authorization consult only these canonical
stamps. Field-prefix, attribute-presence, and schema-shape inference
MUST NOT decide identity.

**ID-4.** Missing, stale, contradictory, or ambiguous membership fails
closed. Occupied type composition cannot change.

**ID-5.** The same entity has identical membership in reads, operations,
traversal, and policy evaluation.

## 6. Catalog locality

A catalog is the atomic installed unit of schema, operations, and compiled
policy. The public TypeScript value is `Schema`; architecturally it is a
catalog.

**CAT-1.** Entities, traits, fields, operations, and policies are
catalog-local. Lookup is by canonical identity (catalog / database + owner
+ local name), never by wire name alone.

**CAT-2.** Two catalogs MAY reuse local names. A handle from one catalog
MUST NOT invoke, authorize, or read another.

**CAT-3.** Policies MUST NOT reference schema or operations outside their
catalog. Cross-catalog handles, stale catalog versions, and identity
collisions fail closed.

**CAT-4.** Catalog data, compiled policy IR, operation tables, membership
constraints, and related metadata commit atomically against one
authoritative basis. A failed install leaves no partial state.

**CAT-5.** Policy and operation state MUST NOT be observed without the
exact catalog version they were validated against.

**CAT-6.** Client-side occupancy or install checks are diagnostic only.
The transactor repeats every security-relevant check.

## 7. Read authorization lattice

**POL-1.** Entity policies control rows. A datom of an entity is readable
only if that entity's row policy allows the principal.

**POL-2.** Trait policies control trait-owned fields. A trait-owned field
is readable only if the trait policy AND the composing entity's row policy
both allow. Two composers MUST NOT union grants.

**POL-3.** Field policies MAY only narrow. They cannot grant a field the
row or trait policy denied.

**POL-4.** `.allow(a, b)` is disjunction. An explicit deny wins over any
allow. Missing authorization is deny.

**POL-5.** A missing trait policy hides that trait's own fields even when
the composing row is readable.

**POL-6.** Trait rules gate fields, not rows. A trait-root id is visible
when the composing entity row policy allows; trait field cells still
require **POL-2**.

**POL-7.** Schema and catalog metadata that authorized clients need is
explicitly allowlisted and read through the application snapshot. Nothing
under `:db/*` or `:ramose/*` is automatically public.

**POL-8.** Engine-owned membership stamps on an entity are readable iff
that entity's row policy allows (**POL-1**). They identify an authorized
row; they are not globally public catalog metadata. A hidden entity's
stamps MUST NOT leak through type or trait scans.

## 8. Refs, paths, and errors

**REF-1.** A readable ref whose target is unreadable is hidden as a whole
datom. The attribute name MUST NOT appear with a redacted or empty value.

**REF-2.** Every graph path segment MUST be independently readable. There
is no separate `enter` permission.

**REF-3.** Hidden and nonexistent targets are externally indistinguishable:
same result shape, same error, same live silence.

**REF-4.** Wrong-type errors MAY be exposed only after the target is
readable. Existence and type checks on a hidden target MUST behave as
**REF-3**.

**REF-5.** Reverse refs, backlinks, nested pull, and trait refs obey
**REF-1**–**REF-4**. A mixed query MUST NOT leak a hidden composer's id
through another column or var.

## 9. History, as-of, and the rule basis

**HIST-1.** Application reads retain their requested current, as-of, or
history collapse. Authorization does not.

**HIST-2.** Policy always evaluates against the trusted current rule
snapshot. A retracted grant MUST NOT re-grant through history or as-of.
A current grant MAY reveal historical values of now-authorized facts.

**HIST-3.** History and as-of streams still pass the authorized datom
cursor. Unauthorized historical datoms MUST NOT appear or affect counts.

## 10. Operations and writes

**WR-1.** Catalog-bound operations are the only external application-write
mechanism. Public raw transact and attribute-level write bypasses are
forbidden.

**WR-2.** `run(Operation)` policy is evaluated inside the committing
transaction against the authoritative current basis. Prior reads are not
the correctness boundary.

**WR-3.** Targeted operations establish readability (**REF-3**, **REF-4**)
before type or trait validation.

**WR-4.** Targetless operations see claims, principal classes, catalog
facts, and typed input — not a target resource. Resource-dependent rules
on targetless operations are statically invalid. A targetless trait
operation is allowed only when that trait is reachable in the active
catalog.

**WR-5.** Operation bodies MUST NOT forge engine-owned membership or
control-plane datoms.

**WR-6.** Returned and read-after-write representations pass through the
resulting application snapshot. A write MUST NOT echo a datom the
principal cannot read.

**WR-7.** Cross-catalog and stale operation handles fail without executing
user operation code.

## 11. Live queries and session replication

**LIVE-1.** Initial live results and every subsequent delta are built from
application snapshots at the same basis as the equivalent one-shot read
(**NI-4**, **CUR-1**).

**LIVE-2.** External sessions receive only authorized application datoms.
Raw transaction-log entries and raw segment changes MUST NOT be streamed.

**LIVE-3.** A committed transaction that yields no authorized datoms for
the principal is silence. It MUST NOT leak the transaction id or
timestamp.

**LIVE-4.** Visibility loss is delivered as retraction of previously
visible facts, or as subscription close / restart. It MUST NOT reveal a
newly hidden value or distinguish "now hidden" from "now gone".

**LIVE-5.** Reconnect, resume, retry, and backpressure MUST NOT replay
unauthorized historical data.

**LIVE-6.** Caches and queued deltas MUST NOT cross principals, databases,
catalog versions, policy versions, rule bases, or authorization epochs.

## 12. Admission

**AUTH-1.** Verified JWT principals plus compiled policy are the only
external database access mechanism. Anonymous / open mode, `RAMOSE_TOKEN`,
shared secrets, seed-token bypasses, API-key principals, and public
raw-transact fallbacks are forbidden.

**AUTH-2.** Every external HTTP and WebSocket database request MUST
present a JWT whose signature, issuer, audience, expiration, not-before,
algorithm, and required subject / principal claims verify. Algorithms are
explicit; the token header MUST NOT choose them.

**AUTH-3.** Principal classes and claims are resolved through the active
catalog's policy configuration. Deployment, schema, and administrative
actors are ordinary service JWT principals with explicit classes or
grants — not bypass flags.

**AUTH-4.** Missing or invalid compiled policy denies all database access.

**AUTH-5.** Authentication and catalog authorization occur before database
existence, entity existence, operation existence, or control-plane
capability is revealed. Failures return a uniform response.

**AUTH-6.** The only unauthenticated public route permitted is a minimal
non-data health endpoint. It MUST NOT list databases, operations,
principals, policy, or other inventory.

**AUTH-7.** Tests authenticate with locally signed JWTs. Bypass flags are
forbidden.

## 13. Disclosure and side channels

**DISC-1.** Ordinary principals MUST NOT observe transaction ids or
timestamps, result counts that depend on unauthorized facts, planner
details, cache / storage / segment statistics, or other side-channel
metadata unless an explicit policy grant allows that observation.

**DISC-2.** API-exposed timing, explain, and estimate fields are
application-visible metadata. They MUST NOT depend on unauthorized
datoms (**NI-1**). Wall-clock variance is out of scope; returned numbers
and structured explain output are in scope.

**DISC-3.** Cardinality oracles (`estimate` and equivalents) are
application consumers (**CUR-1**). They MUST NOT report unfiltered size.

**DISC-4.** Error bodies, status distinctions, metrics or debug endpoints
returned to clients, and WebSocket control messages obey **NI-1**,
**REF-3**, **REF-4**, and **AUTH-5**.

## 14. Snapshot consistency and revocation

**REV-1.** A read authorization lease lasts at most five seconds.
Revalidation covers JWT validity, principal claims and classes, catalog
version, policy version, and the relevant rule basis.

**REV-2.** Writes always reauthorize on the current transaction basis
(**WR-2**). A lease does not authorize a write.

**REV-3.** Live subscriptions close or explicitly reauthorize on
revocation or an incompatible policy / catalog / membership / grant
change. They MUST NOT continue with stale visibility.

**REV-4.** JWT expiry and policy, grant, or membership revocation take
effect within the lease bound.

## 15. Policy language safety

The authoring API compiles to a versioned, serializable, data-only
authorization IR. Runtime evaluates that IR. It does not execute
authoring callbacks.

**LANG-1.** Evaluation is pure, deterministic, and bounded.

**LANG-2.** Traversal through the rule snapshot is typed and fixed-depth
(for example `Taggable → Tag → TagGrant`). Unrestricted recursion is
forbidden in the initial language.

**LANG-3.** The initial language has stratified negation and MUST NOT
have effects, aggregates, ordering, limiting, or unrestricted recursion.

**LANG-4.** The compiler rejects illegal effects, unsupported recursion,
unbounded constructs, invalid trait composition, inaccessible
dependencies, and resource-dependent rules on targetless operations, at
catalog build or install time.

**LANG-5.** Missing rules and incomplete compiled state fail closed
(**FC-1**).

**LANG-6.** Trait-focused rules are reusable on any composing entity.
They do not require special runtime machinery beyond the rule snapshot
and **LANG-2**.

## 16. Fail closed

**FC-1.** Missing, invalid, incomplete, or mismatched policy, catalog,
principal, membership, or IR state denies the request. Deny MUST NOT
reveal whether the protected data exists.

**FC-2.** When any check required by this contract cannot be completed,
the answer is deny, hide, or close — not a fallback to open, raw, or
unfiltered access.

**FC-3.** There is one authorization path. Dual paths, compatibility
adapters, legacy policy versions, inferred membership, and migrations
are forbidden.

## 17. Caching

**CACHE-1.** Safe caches are keyed by every dimension that can change
visibility: catalog version, policy version, rule basis, principal
identity / classes / claims, application basis, and authorization epoch,
as applicable.

**CACHE-2.** A cache MUST NOT serve a hit across those keys (**LIVE-6**).

## Child-issue mapping

Each later authorization issue maps its acceptance tests to these
invariants. The mapping is a citation index, not a backlog.

| Issue | Invariants the issue must prove |
|---|---|
| 337 Policy authoring API and IR | **LANG-1**–**LANG-6**, **POL-1**–**POL-6**, **WR-4**, **FC-1**, **CAT-1** |
| 338 Remove the legacy pipeline | **TCB-1**, **CUR-2**, **OPT-1**, **OPT-4**, **AUTH-1**, **FC-3**, **ID-3** |
| 339 Raw / rule / application snapshots | **TCB-1**–**TCB-4**, **CUR-4**, **HIST-1**, **HIST-2**, **FC-1** |
| 340 Canonical membership | **ID-1**–**ID-5**, **POL-8**, **FC-1**, **WR-5** |
| 341 Catalog-local operations and policies | **CAT-1**–**CAT-3**, **CAT-5**, **WR-4**, **WR-7**, **LANG-4** |
| 342 Atomic catalog install | **CAT-4**–**CAT-6**, **ID-4**, **FC-1** |
| 343 Authorized datom cursor | **CUR-1**–**CUR-3**, **POL-1**–**POL-8**, **REF-1**–**REF-5**, **HIST-1**–**HIST-3**, **LANG-2**, **LANG-6**, **NI-1**–**NI-4**, **CACHE-1** |
| 344 Verified principals | **AUTH-1**–**AUTH-7**, **TCB-5**, **FC-1** |
| 345 Operation authorization | **WR-1**–**WR-7**, **REF-3**, **REF-4**, **REV-2**, **ID-2** |
| 346 Pushdown as optimization | **OPT-1**–**OPT-4**, **NI-4**, **CUR-1** |
| 347 Live queries and replication | **LIVE-1**–**LIVE-6**, **REV-1**, **REV-3**, **REV-4**, **DISC-1**, **NI-1** |
| 348 Privileged paths and metadata | **TCB-5**, **TCB-6**, **POL-7**, **DISC-1**–**DISC-4**, **AUTH-5**, **AUTH-6** |
| 349 Conformance suite | **NI-1**, **NI-2**, and every invariant this table assigns to 337–348 |
| 350 Reef rebuild | The completed model; no additional invariants |
