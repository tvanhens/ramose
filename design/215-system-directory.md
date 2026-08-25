# Design: the system directory — databases, grants, and identity as Ramose data

- Issue: [#215](https://github.com/tvanhens/ramose/issues/215) (decision 5 of the pre-launch review, tracker #205)
- Status: **direction decided 2026-08-25** (see "Decisions" below); mechanics revisable
- Baseline: `b5ae5c9` (cleanup complete except #183 proceed-list and #196/SSR)

## Decisions (owner, 2026-08-25)

These supersede any compat-preserving language elsewhere in this doc and the
earlier hold notes they replace:

1. **The API is fully fungible pre-launch.** Breaking changes are tolerable
   now; optimize for the quickest path to the end state, not for
   compatibility. (Consistent with decision 6: break once, no deprecation
   windows.)
2. **The vocabulary is `role`, not `class`.** Policy head `roles:`,
   `P.role(...)`, `schemaRoles`; directory field `grant.role`. This amends
   #204's naming map; internal constants (`TOKEN_ONLY_CLASS` etc.) rename
   mechanically. The `classOfRole` mapping layer is deleted outright — there
   is only one concept, with one name. Bonus alignment: the peer-materialized
   `:user/role` datom already matches.
3. **The directory is always on.** Every deployment has `_dir`; there is no
   directory-less mode and no mode switch.
4. **No compatibility mode.** Identity-only tokens are the *only* JWT
   format. The legacy `ramose: { db, class }` claim is removed in the same
   change, not frozen for migration — mint, verifier, and client drop it
   together. (This resolves #183's direction hold; its proceed-list items
   are unaffected.)
5. **Identity data stays in Better Auth's D1 for now** (users, password
   hashes, sessions, verification). The directory owns databases and
   grants; identity storage migration (the old "stage 3") is deferred to
   avoid the erasure complexity, which makes the erasure question
   **non-gating** for this design (it remains a pre-1.0 question for app
   data generally — see §12).

## Summary

Every deployment gets a well-known system database, `_dir`, that reifies the
control plane as ordinary Ramose data guarded by an ordinary (package-defined)
`policy()`. Credentials are identity-only — a token carries `sub` and the
deployment audience, nothing else. On session open for database X, the peer
resolves `(sub, X) → role` with one index lookup against `_dir` in the same
isolate (no network hop, no extra token), and fills `Principal.roles` — the
seam #179 already cut (as `classes`; renamed with the sweep). Grants are
rows: granting is an operation, revocation is a retraction that is
authoritative on the next resolution, access audit is `history` on the grant
namespace, and the workspace list is a live query.

Scope after the 2026-08-25 decisions: this design replaces the
org/membership/invitation half of Reef's D1 and all token-carried
authorization, in one move, with no dual-path period. Identity (sign-in,
sessions) stays in Better Auth's D1. JWKS relocation remains recommended,
independent hygiene (§11).

## Goals

- One credential per principal, valid across every database the directory
  grants; no claim maps, no per-db mint loop, no provider remount on
  workspace switch.
- Revocation bounded by resolver staleness (seconds), not JWT TTL (15 min).
- Kill the bug classes the review found: token-carried authorization
  (#183's cross-user reuse), role held in two sources of truth (Reef reading
  the unverified JWT because the db can't answer).
- MCP discovery (#209): `learn()` is a policy-scoped query over `_dir`;
  deny-by-default does the scoping; the db list is live.
- Dogfooding: "permissions in the database" includes permissions *about*
  databases.

## Non-goals (this design)

- Cross-database atomicity (#167). Directory writes that touch a target db
  (install, mirror writes) are separate transactions with idempotent retry.
- A general per-database policy mechanism. `_dir` gets its own built-in
  policy via a special case; app databases keep sharing `RAMOSE_POLICY`.
- Identity storage migration and the erasure story (deferred by decision 5
  above; §12 keeps the sketch for when it's picked back up).

---

## 1. Names: the `_` system namespace

`DATABASE_NAME_RE` (`src/db/DatabaseName.ts`) requires a leading
alphanumeric, so **no user database can ever be named `_dir`** — the system
prefix is already unsquatted on every existing deployment. We keep the user
rule exactly as is and add a closed set of system names beside it:

```ts
// DatabaseName.ts
export const SYSTEM_DATABASES = ["_dir"] as const;
export const isSystemDatabaseName = (s: string) =>
  (SYSTEM_DATABASES as readonly string[]).includes(s);
```

- The worker route (`worker/index.ts`) and client `makeDb` accept
  `isDatabaseName(name) || isSystemDatabaseName(name)` — clients must be able
  to open policy-scoped sessions on `_dir` (workspace list, invites).
- Identity tokens don't name databases, so mint validation has nothing to
  carve out.
- DO ids derive from the name as today (`idFromName("_dir")`); `_dir` is an
  ordinary database in every mechanical respect — R2 segments, transactor,
  replicas, live sessions, `asOf`/`history`.
- Always-on (decision 3): the peer installs/evolves the `Directory` catalog
  into `_dir` at deploy unconditionally; a deployment that never seeds a
  grant simply has an empty directory.

## 2. The directory catalog

Ships in the package (working name `Ramose.Directory`), versioned with the
engine, installed/evolved by the peer — never user-authored.

```ts
const Principal = Ramose.Entity("principal", {
  // Policy principal attr; provisioned by the peer on first _dir session.
  sub: Field.unique(Ramose.string(), "upsert"),
  role: Ramose.string({ optional: true }),        // peer-materialized (mirror)
  kind: Ramose.Enum(["user", "agent"], { optional: true }), // absent = user
  name: Ramose.string({ optional: true }),
  email: Ramose.string({ optional: true, index: true }),
});

const Db = Ramose.Entity("db", {
  name: Field.unique(Ramose.string(), "upsert"),  // the database name
  doc: Ramose.string({ optional: true }),          // seeded from databases: doc
  status: Ramose.Enum(["active", "suspended"]),
});

const Grant = Ramose.Entity("grant", {
  // Composite-unique workaround: no compound keys exist, so the (sub, db)
  // identity is a synthesized attribute. Written only by grant operations,
  // never by clients, so the invariant key === `${sub}|${db}` holds.
  // Bonus: the resolver is one entid() lookup on this attribute.
  key: Field.unique(Ramose.string(), "upsert"),
  principal: Ramose.Ref(Principal),
  db: Ramose.Ref(Db),
  role: Ramose.string(),    // interpreted by the TARGET db's policy
  admin: Ramose.boolean(),  // interpreted by the DIRECTORY: may manage
                            // grants/invites on this db
});

const Invite = Ramose.Entity("invite", {
  email: Ramose.string({ index: true }),
  db: Ramose.Ref(Db),
  role: Ramose.string(),
  admin: Ramose.boolean(),
  status: Ramose.Enum(["pending", "accepted", "revoked"]),
  invitedBy: Ramose.Ref(Principal),
});

const ApiKey = Ramose.Entity("apiKey", {
  keyHash: Field.unique(Ramose.string(), "strict"), // SHA-256 of the secret
  principal: Ramose.Ref(Principal),
  doc: Ramose.string({ optional: true }),
  status: Ramose.Enum(["active", "revoked"]),
});

export const Directory = Ramose.Schema({
  principal: Principal, db: Db, grant: Grant, invite: Invite, apiKey: ApiKey,
});
```

Design notes:

- **`grant.role` vs `grant.admin`.** Role names are per-app policy
  vocabulary (`owner`/`member`/`viewer` in Reef, anything elsewhere), so the
  directory cannot know which string means "may invite". Directory-level
  administration is therefore its own boolean on the grant, checked by the
  directory's own policy rules. A deployment where "owner" implies admin is a
  convention its grant operations encode, not something `_dir` assumes.
- **Grants reference principals by ref; invites carry email.** A grant
  requires the principal row to exist (refs keep integrity); inviting someone
  who has never signed in goes through `invite`, converted to a grant by
  `invite/accept` on their first session.
- **One grant per (sub, db), one role.** `Principal.roles` (plural) is
  the seam; if multi-role grants are ever wanted, `role` becomes card-many
  without changing the resolver contract (`rolesOf` already handles it).
- **`principal` satisfies the provisioning constraint** (unique-upsert
  principal attr; every other field optional; string `role` sibling), so the
  existing peer provisioning path works on `_dir` unchanged.

## 3. The directory policy

Package-defined, compiled at build time into the worker (no `RAMOSE_POLICY`
binding cost, no 5.1 kB pressure). The peer applies it whenever the routed
database is a system name; app databases keep the deployment policy:

```ts
const policyFor = (db: string) =>
  isSystemDatabaseName(db) ? DIR_POLICY : compiledPolicy(env.RAMOSE_POLICY);
```

Sketch (illustrative — combinator spellings to be settled against `Q`):

```ts
const mine       = (me) => Q.is(Grant.principal, me);
const grantedDb  = (me) => (db) => Q.some(Grant.db.reverse, Q.is(Grant.principal, me))(db);
const adminOfDb  = (me) => (db) =>
  Q.some(Grant.db.reverse, Q.and(Q.is(Grant.principal, me), Q.eq(Grant.admin, true)))(db);
const adminOfGrantsDb = (me) => (g) => /* follow Grant.db, then adminOfDb */;
const myInvite   = (me) => (inv) => /* Invite.email == me.email */;

export const DIR_POLICY = policy({
  schema: Directory,
  principal: Principal.sub,
  roles: ["admin", "principal"],
  superuser: "admin",
  operations: dirOperations,
}, {
  principal: { read: [self, /* admins of a shared db see co-members */ sharesDb] },
  db:        { read: grantedDb },
  grant:     { read: [mine, adminOfGrantsDb] },
  invite:    { read: [myInvite, adminOfInvitesDb] },
  apiKey:    { read: mineByPrincipal },
  operations: {
    createDbOp:     P.role("principal"),                    // any signed-in user
    grantOp:        { role: "principal", rule: adminOfDb }, // on: Db
    revokeGrantOp:  { role: "principal", rule: [ownGrant, adminOfGrantsDb] }, // on: Grant
    inviteOp:       { role: "principal", rule: adminOfDb }, // on: Db
    acceptInviteOp: { role: "principal", rule: myInvite },  // on: Invite
    revokeInviteOp: { role: "principal", rule: adminOfInvitesDb }, // on: Invite
    createApiKeyOp: P.role("principal"),  // effect binds principal = me
    revokeApiKeyOp: { role: "principal", rule: mineByPrincipal }, // on: ApiKey
    setDbStatusOp:  { role: "principal", rule: adminOfDb }, // on: Db
  },
});
```

- **Every verified principal holds role `principal` in `_dir`** — resolution
  for `_dir` itself is: grant row if present (which is how `admin` is held),
  else the implicit `principal` role for any verified `sub`. Deny-by-default
  read arms scope what that role sees to "my slice": my grants, my dbs, my
  invites, co-members of my databases. This *is* the #209 discovery scoping.
- "Owners can invite" is the `grantOp`/`inviteOp` arm: `on: Db`, rule =
  caller holds an `admin: true` grant on that db row. Grant creation targets
  the **db row** (which exists), not the grant row (which doesn't yet) —
  matching the post-#296 rule that arms evaluate against a resolved `on:`
  target.
- `createDbOp`'s effect installs the app catalog into the new database
  (`databases.install`, Reef's existing provisioning pattern), then writes the
  `db` row and the creator's `{role: <app owner role>, admin: true}` grant
  in one `_dir` transaction. Install-then-record with idempotent retry; no
  cross-db atomicity claimed (#167).
- Access audit = `db("_dir").history` over the grant namespace, read under
  these same arms. Rules always evaluate on the current basis, so history
  cannot re-grant (already true engine-wide).

## 4. Identity-only tokens — the only token format

Per decisions 1/3/4 there is no compat mode and no static-claims mode: the
`ramose: { db, class }` claim is deleted from mint, verifier, and client in
the same change that ships the resolver. The token is:

```
{ iss, aud, sub, iat, exp }
```

The credential kinds after the change:

| Credential | Path | Notes |
| --- | --- | --- |
| Identity JWT (`ramose` claim gone) | resolve `(sub, X)` via `_dir` (§5) | the only JWT format; no grant → 401 |
| `RAMOSE_TOKEN` / `$token` | unchanged, plus the seed route (§6) | deploy/seed credential |
| API key (`rk_…` prefix) | hash → `_dir` `apiKey` row → `sub` → resolver | agents (§8); no JWT involved |
| No policy configured (dev/open mode) | short-circuits to service admin, as today | the directory exists but resolution is moot |

- Everything the verifier did with the claim moves to the resolver: the
  per-db pinning (`allows()`) now pins to the *resolved* principal's db, and
  "undeclared role" is rejected at resolve time (§5).
- The Better Auth mint route simplifies to identity-only: `POST
  /ramose/token` takes no `db`, does zero D1 org reads, responds
  `{ token, exp }`. `classOfRole` and `orgClassOf` are deleted.
- **Reef migration is a one-shot seed, not a mode**: a deploy-time import
  reads the D1 org tables once (org slug → db row, `member.role` → grant
  `role` via the same owner/admin → owner collapse, owner/admin →
  `admin: true`), seeds `_dir`, and the same PR deletes the org plugin,
  the claim mint, and the UI's claims fallback. Decision-6 style: the old
  surface goes in the PR that lands the new one.
- `ramose.attrs` dies with the claim: profile (name/email) lives on the
  `_dir` principal row (propagation mechanism = open question 5, §Open
  questions). Workspace-db provisioning that today copies `attrs` into
  sibling datoms instead reads the directory principal row at provision
  time.
- **The token-shape decision is itself an unblock for offline-first.** The
  offline program's persisted-credential work (W6) is sequenced on this
  design precisely because an identity-only token is a far smaller liability
  to persist in browser storage than an authorization-bearing one. The shape
  is now settled (this section); W6 is unblocked regardless of resolver
  timing.

## 5. The resolver

On session open (and on every principal-verifying request) for database X:

1. Verify the JWT as today (issuer, audience, alg pinning, TTL cap, `sub`).
2. Resolve the grant with **one index lookup, same isolate, no network**:
   basis via the existing per-isolate basis cache
   (`fetchBasisWithStats(env, "_dir", request)` — one DO subrequest on miss,
   zero on hit), then
   `db.entid([":grant/key", `${sub}|${X}`])` and pull `role` off the row.
   This read is a system read (unfiltered) — the resolver is the engine, not
   a session.
3. No grant, or `db.status !== "active"` → 401 "token is not valid for this
   database" (same message as today).
4. Grant role not declared by X's policy → 401 (the undeclared-role
   rejection, moved from verify time to resolve time).
5. Build the principal with the seam filled:
   `{ kind, sub, db: X, role: grantRole, roles: [grantRole], claims }`.
   Everything downstream (`rolesOf`, `holdsRole`, `isSuperuser`,
   `canChangeSchema`, arms, provisioning of `:ns/role`) already consults the
   seam — **no policy-engine changes** beyond the rename.

For X = `_dir` itself: step 2 falls back to the implicit `principal` role
when no grant row exists (§3). The recursion bottoms out because the resolver
reads `_dir` with system access, not through a policy-gated session.

### Caching and invalidation

Add a `grants` memo beside the existing per-isolate memos
(`principals`, `eids`, `provisioned` in `worker/auth.ts`): key
`${sub}|${db}`, TTL 60 s, cleared by `clearAuthCache()`, and negative results
cached briefly too (deny storms are cheap to absorb). Writes to `_dir`
through an isolate already call `invalidateBasis("_dir")`, so same-isolate
revocation is immediate; cross-isolate worst case is the 60 s TTL.

Effective revocation latency:

- **HTTP reads/writes**: ≤ 60 s (vs ≥ token TTL today). Every request
  re-resolves through the memo.
- **Live sockets**: the session principal is pinned at open (session
  generation). Re-resolution happens on every in-band `{op:"auth"}` frame
  and reconnect — i.e. at the client's mint cadence (≤ 15 min) without
  further work.

The issue's open question — *per session generation vs live-query push* —
resolved as: **ship session-generation semantics first** (simple, honest,
already better than JWT expiry for everything non-socket), and specify push
as the follow-on: because `_dir` writes are peer-executed operations, the
revoke op's effect can notify the target database's transactor
(`idFromName(X)`, internal-gated `POST /reauth {sub}`), which stamps a
revocation watermark replicas check when they next touch a session for that
`sub`, forcing an `auth` round-trip or close. That path needs a
transactor→replica signal that doesn't exist yet, which is exactly why it's
staged, not assumed. Offline-first raises the stakes on this choice: a
rule-view resync becomes a full re-dump plus a disk-store rebuild (§10), so
the push design should prefer targeted per-`sub` session kicks over anything
that widens resync triggers.

## 6. Bootstrap and seeding

**The recursion's base case is the deploy-time credential, and the one new
power it gains is enumerable.** Under a policy, `$token` can push schema but
not data — correct, and we keep it that way for app databases. Seeding
`_dir` gets a dedicated route:

```
POST /db/_dir/seed        (allowed: $token, directory admins)
{ dbs: [{ name, doc?, status? }...],
  grants: [{ sub, db, role, admin }...],
  admins: [sub...] }                       // grants on _dir itself
```

Executed by the peer as a **system write** — the same trust shape as the
existing `/provision` path (`{system: true}`, bypasses the tx check,
peer-owned, never client-reachable). It is declarative and idempotent:
upsert by `db.name` / `grant.key`, never delete (removing an entry from
`databases:` does not revoke; revocation is an explicit act in the
directory, matching "seed, don't own").

Deploy-time flow (`Server`):

1. Install the `Directory` catalog into `_dir` unconditionally (decision 3;
   idempotent; schema evolution guarded as usual — the catalog is
   package-versioned, so upgrades ride engine releases).
2. `seedDatabases` runs as today for app catalogs, then posts the seed doc:
   every `databases:` entry becomes a `db` row (name + `doc` — finally
   landing where the #203 amendment said it was destined; `status` defaults
   `"active"`), plus any declared default grants.

```ts
Server("Ramose", {
  directory: { admins: [env.OPERATOR_SUB] },   // seed config, not a switch
  databases: {
    app: { schema: App, doc: "The app database",
           grants: { [env.OPERATOR_SUB]: { role: "owner", admin: true } } },
  },
})
```

- `DatabaseSeed` grows an optional `grants` field; the resource stores
  nothing (it already deliberately doesn't) — `_dir` is authoritative the
  moment the seed lands.
- The auth service needs no directory access at all for minting (§4); its
  only remaining coupling is publishing JWKS. "The auth service reaches the
  system db via the internal credential" from the issue sketch turns out to
  be unnecessary in this shape — a simplification, not a loss.
- The policy-head `superuser` role stays what #179 made it: standing within
  a database's policy. `_dir`'s policy names `admin` as its superuser; a
  deployment operator is "root" by holding an `admin` grant on `_dir`, and
  their standing in app databases is whatever grants say — cross-database
  omnipotence is a set of rows you can read, not an ambient property.

## 7. Client surface

Resolves the #183 questions deliberately deferred to this design:

- **The credential attaches to the client, not the database handle.**
  `connect({ url, token })` with an identity token; `client.db(name,
  catalog)` takes no token. The per-db `{ token }` spelling is removed in
  the same change (decision 4 — no compat spelling survives).
- **Workspace switching is just another `db()` call.** One client, one
  socket credential story, no provider remount, no mint loop:
  the #183 cross-user-reuse shape (stale per-db token source surviving a
  principal swap) has nothing left to go stale.
- **The workspace list is a live query**, replacing Better Auth's
  `listWorkspaces`:

  ```ts
  const dir = client.db("_dir", Ramose.Directory);
  dir.live({ find: [Db.name, Db.doc], where: ... })   // policy-scoped: my dbs
  ```

  Invites, member lists, and "leave workspace" are `_dir` reads and
  operations under §3's arms. Reef's workspace screen becomes a Ramose
  consumer instead of an auth-API consumer — the dogfooding headline.
- `usePrincipal(db)` already answers "who am I here" from the server; with
  the JWT no longer carrying a role, the unverified-claims fallback
  (`claims?.ramose?.class` in Reef's screens) is deleted rather than fixed —
  one source of truth remains. (Ordering note: that fallback currently masks
  offline identity degradation, so the offline program's durable cached
  principal must land before the fallback is removed — see §10.)
- **The resolved principal is a client-visible contract, defined once.**
  With the role off the token, the session auth-ack and `GET /db/:name/info`
  (`{ eid, role }`) become the *only* client-side source of "who am I in
  this database". Three consumers key durable state on it — #183's
  principal-swap cache keying, offline-first's cached principal per
  `(db, sub)` (W2), and its persisted-store partitioning (W3) — so this
  design fixes the contract rather than leaving it implicit: `sub` is the
  canonical identity/partition key; the per-db resolved `{ eid, role }` is
  surfaced on the auth ack and `/info`; and any client-cached copy is
  **UX-only, never authorization** (the same rule the Better Auth plugin
  already stated for its `class` field), because the server re-resolves on
  every request and every replay.

## 8. Agent principals and API keys (#209)

Agents are ordinary principals — same rows, same deny-by-default policy,
same audit surface:

- A `principal` row with `kind: "agent"` and a synthetic sub
  (`agent:<uuid>`), plus `apiKey` rows referencing it.
- `createApiKeyOp` (a `_dir` operation) generates a high-entropy secret
  server-side, returns it **once** in the operation output, and stores only
  its SHA-256 in `keyHash` (`unique strict`). A hash of a 256-bit random
  secret is not sensitive data, so keys don't gate on any erasure story.
- The peer accepts `Authorization: Bearer rk_<secret>`: hash, look up the
  `apiKey` row (one entid on `keyHash`), check `status: "active"`, then
  enter the resolver (§5) with the key's principal `sub`. Revocation
  is `revokeApiKeyOp` — effective at resolver latency, no TTL involved.
- Grants for agents are ordinary grant rows; "what did the agent do" is
  provenance + `history`, as #209 frames it.
- **The "agent role" half of #209's recipe needs no directory support.**
  An app that wants narrower agent arms declares an `agent` role in its
  policy and grants it like any other — the directory grants whatever role
  string the target policy declares (the same decoupling that motivates
  `grant.admin`). Recipe: `roles: [..., "agent"]`; op arms
  `{ role: ["member", "agent"], rule }`; grant row
  `{ principal: <agent>, db, role: "agent" }`.

## 9. `learn()` alignment (#209)

`learn()` with no argument = a query over `_dir` under the caller's own
session: db rows visible to me (deny-by-default already scoped them), each
joined with my grant's `role`, plus `doc` — precisely the "name,
description, the caller's class there" card (#209's wording predates the
rename). Live by construction. With the directory always on (decision 3),
#209's token-claims fallback path is **dropped**: there is one discovery
source, which is the thinner of the two shapes #209 asked for — record this
on #209 when it's picked up.

Scope boundary: only the top-level card query is directory data. Drill-down
(`learn("acme")` → namespaces and operations, `learn("acme/op:…")`) reads
the operations registry and the compiled policy — deployment-wide worker
state that #209 assigns to the compiled policy, not to this design. A
consequence worth naming: a deployment has one registry and one app policy,
so in a multi-db deployment drill-down returns the same operations for every
database; only the caller's role (and so which arms admit them) differs per
db, via the grant. Also a transport note in the directory's favor: MCP is
streamable HTTP, so every `query`/`pull`/`run` re-resolves through the
resolver memo — MCP agents see revocation at ≤60 s, tighter than any
long-lived socket.

## 10. Offline-first interactions

The offline-first program (design note, 2026-08-25) is sequenced shortly
after this design and builds directly on it. The relationship is mostly
synergy; these are the binding points:

- **Token shape unblocks W6** (§4): persisted identity tokens are the
  smaller liability; that work waits on the shape decision, not the
  resolver. The shape is now settled.
- **One resolved-principal contract** (§7): #183's cache keying, W2's
  durable cached principal, and W3's store partitioning all consume the same
  ack/`info` contract and key on `sub`. Build it once.
- **Sequencing: the directory core before offline phase 3.** Offline cold
  start fails today on three auth-Worker dependencies — session fetch,
  workspace list, JWT mint. The directory removes the workspace list from
  that list structurally: it becomes a `_dir` live query, and since `_dir`
  is an ordinary database with a tiny per-principal projection, the offline
  program's persisted store (W3) makes the workspace list work offline for
  free. Corollary: build no offline cache for the Better Auth REST
  workspace list — it is throwaway the day the directory lands. Offline
  phases 1–2 are independent of this design and can interleave freely.
- **"Grant revoked" is a stable, classifiable failure.** Offline stretches
  the write path to days, so two contracts are fixed here: (1) queued-write
  replay re-resolves grants per operation (the resolver runs per request),
  so offline revocation is enforced at replay with no extra machinery — the
  rejection is a terminal `Unauthorized` (server rejection: drop the layer,
  surface via the error channel), never a retryable transport error;
  (2) session open on a formerly-granted database (401) is a first-class
  client state — the db also disappears from the `_dir` live list, and the
  defined client behavior is: wipe that db's persisted store, drop its
  outbox, surface it. This adds a third trigger to offline's "wipe on
  identity change / rule-view resync" rule.
- **Reef cleanup ordering** (§7): W2's durable cached principal lands
  first; the unverified JWT-role UI fallback is deleted second.
- **Directory operations compose with offline as-is**: `grantOp`/`inviteOp`
  queue like any operation; `createDbOp` is effect-first, so it correctly
  has an empty optimistic prefix — exactly the documented "everything
  before your first effect works offline; the effect waits for the network"
  boundary.
- **Resync cost pressures the push-invalidation design** (§5): offline
  turns a rule-view resync into a full re-dump plus disk-store rebuild, and
  grant changes trigger exactly those resyncs. Acceptable at realistic
  grant-change frequency, but it commits the v2 push design to targeted
  per-`sub` session kicks rather than broader resync triggers.

## 11. What moves, what stays (D1 after this design)

Revised per decision 5 (identity stays in D1 for now):

| D1 contents | Disposition |
| --- | --- |
| `organization`, `member`, `invitation` | **Move now, as part of the core** — one-shot deploy-time import into `_dir` (`db`/`grant`/`invite` rows), org plugin + `classOfRole` + claim mint deleted in the same PR (§4) |
| `jwks` | **Move when convenient, independent hygiene** — to Durable Object storage (or Workers secrets). Wanted regardless of this design: the pinning ritual exists because `BetterAuthSecret` (encrypting `jwks.privateKey`) lives only in Alchemy state, so a cache miss remints it and orphans the keys. Keys in DO storage, rotated in place, published unchanged at `/api/auth/jwks` |
| `user`, `account`, `session`, `verification` | **Stay in D1** (decision 5) — Better Auth continues to own sign-in, sessions, and credentials. Revisit with the erasure story (§12); the old stage-3 adapter analysis is preserved in this doc's history |

Bootstrap circularity is dissolved rather than solved: minting never reads
the directory, the peer never calls the auth service, deploy seeds via
`$token` — the resource graph stays a DAG.

End state for this design: D1 holds **identity only**; databases, grants,
invites, and API keys are policy-guarded, live-queryable, auditable Ramose
data.

## 12. Erasure (deferred — kept as reference)

Decision 5 removes the erasure gate from this design: with identity staying
in D1, no password hashes, session tokens, or refresh tokens enter the
append-only store. What remains, deliberately non-gating:

- **Profile PII in `_dir`** (name/email on principal rows, invite emails)
  and app-data PII generally still need a pre-1.0 erasure answer — that is
  its own issue, not this design's.
- The **crypto-shredding sketch** stays the leading candidate for when it's
  picked up: fields marked secret store `Bytes` ciphertext under a
  per-principal AES-256-GCM key held in mutable transactor-DO storage
  (colocated, deletable, no new DO namespace); deleting the key makes all
  historical ciphertext unreadable, including via `asOf`/`history`. True
  excision (rewriting segments) is the heavier alternative.
- Client-persisted projections (offline-first W3) are an
  eventual-consistency boundary: shredding makes server-side history
  unreadable immediately, but a device's disk cache only converges on its
  next sync — the same property as any client cache; a device that never
  reconnects keeps its stale bytes. State this in the erasure docs rather
  than implying stronger reach.

## Open questions (remaining)

**Decided 2026-08-25** (see "Decisions" at the top): fungible API /
quickest path; `role` not `class`; directory always on; no compat mode;
identity stays in D1; erasure non-gating.

**Decisions still needed from the owner** (recommendation listed first):

1. **Profile propagation** — peer copies standard OIDC top-level claims
   (`name`, `email`) from the identity token into the `_dir` principal row
   at provision (recommended: zero new plumbing, quickest path) vs the auth
   service writes profile via a mint-side provision call (one writer, no
   PII on tokens) vs no built-in plumbing (apps do it themselves).
2. **Directory admin vocabulary** — `grant.admin` boolean (recommended, §2)
   vs per-db directory roles.
3. **Multi-role grants** — single role per grant now (recommended; the
   seam supports widening later) vs card-many now.
4. **Revocation latency at launch** — v1 bounded staleness (recommended,
   §5) vs designing push invalidation before shipping.

**Deferred design work** (not owner decisions):

- Exact combinator spellings for the directory policy arms (§3 sketch), and
  whether directory operations are hand-written or lean on #302's generated
  CRUD + arms.
- Push-invalidation mechanism detail (§5, §10): transactor revocation
  watermark vs replica-side epoch check — needs a small transactor→replica
  signal design, constrained to targeted per-`sub` kicks by offline-first.
- `_dir` catalog/policy versioning across engine upgrades: evolution guard
  semantics for a package-owned schema (likely: additive-only, enforced in
  CI like the wire contract).
- The class → role rename sweep inventory (policy head, `P.role`,
  `schemaRoles`, internal constants, docs, error messages) — mechanical,
  rides the implementation PR.

## Constraints honored

Updated for the 2026-08-25 decisions — the compat-preserving constraints
(#183's "no new claim formats" hold, static-claims fallback) are superseded
by the owner's no-compat decision; the alignment constraints stand:

| Binding decision | How this design satisfies it |
| --- | --- |
| #183 (superseded hold; proceed-list stands) | The hold existed to protect this design's option space; the design now removes token-carried authorization entirely rather than versioning it. #183's proceed-list (socket auth frame, sign-out invalidation, principal-swap keying, `reauthenticate`) is unaffected and §7/§10 build on it |
| #179: superuser as directory bootstrap | `Principal.roles` seam (né `classes`) is the resolver's write target (§5); policy-head `superuser` semantics untouched; `_dir` admin = a grant row; the recursion's base case is the `$token` seed (§6) |
| #203: `databases:` is a seed, not the authority | Seeding posts declarative rows to `_dir` and stores nothing resource-side; `doc` lands in the directory; removal from the prop revokes nothing (§6) |
| #209: discovery as a directory query | §9; with always-on directories the claims-fallback path is dropped — one discovery source. Agent principals as ordinary rows + API keys (§8) |
| AGENTS.md (5): don't deepen Better Auth/D1 coupling | The mint route's D1 org reads are deleted; D1 keeps identity only (§11) |
| Decision 1/6/7 (operations-only writes, no deprecation windows, put/update semantics) | All directory writes are named operations under deny-by-default arms; the legacy claim format is removed in the same PR that ships the resolver; seed uses upsert-by-unique-key semantics |
| #204 naming map | Amended by the owner's rename decision: `role` replaces `class` across the policy surface |
