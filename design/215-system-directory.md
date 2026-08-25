# Design: the system directory — databases, grants, and identity as Ramose data

- Issue: [#215](https://github.com/tvanhens/ramose/issues/215) (decision 5 of the pre-launch review, tracker #205)
- Status: **proposal** — everything here is revisable; the "Constraints honored" table at the end is the only part that restates binding decisions
- Baseline: `b5ae5c9` (cleanup complete except #183 proceed-list and #196/SSR)

## Summary

Every deployment gets a well-known system database, `_dir`, that reifies the
control plane as ordinary Ramose data guarded by an ordinary (package-defined)
`policy()`. Credentials become identity-only — a token carries `sub` and the
deployment audience, nothing else. On session open for database X, the peer
resolves `(sub, X) → class` with one index lookup against `_dir` in the same
isolate (no network hop, no extra token), and fills `Principal.classes` — the
seam #179 already cut. Grants are rows: granting is an operation, revocation is
a retraction that is authoritative on the next resolution, access audit is
`history` on the grant namespace, and the workspace list is a live query.

The design divides into a **core** (directory schema + policy, identity-only
tokens, the resolver, bootstrap/seeding, client surface) that replaces the
org/membership half of Reef's D1, and **staged follow-ons** (JWKS relocation,
identity/sessions via a Better Auth adapter gated on an erasure story) that
finish the D1 removal.

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
- Solving erasure for app data. Stage 3 forces the question for identity
  data; the crypto-shredding sketch below is the leading candidate, but the
  general story is its own pre-1.0 issue.

---

## 1. Names: the `_` system namespace

`DATABASE_NAME_RE` (`src/db/DatabaseName.ts`) requires a leading
alphanumeric, so **no user database can ever be named `_dir`** — the system
prefix is already unsquatted on every existing deployment. We keep the user
rule exactly as is and add a closed set of system names beside it:

```ts
// DatabaseName.ts
export const SYSTEM_DATABASES = ["_dir"] as const; // later: "_auth"
export const isSystemDatabaseName = (s: string) =>
  (SYSTEM_DATABASES as readonly string[]).includes(s);
```

- The worker route (`worker/index.ts`) and client `makeDb` accept
  `isDatabaseName(name) || isSystemDatabaseName(name)` — clients must be able
  to open policy-scoped sessions on `_dir` (workspace list, invites).
- Token mint (`Auth.ts`) keeps rejecting `_`-prefixed names in `ramose.db`:
  a compat token can never target a system database. Identity-only tokens
  don't name databases at all, so nothing to do there.
- DO ids derive from the name as today (`idFromName("_dir")`); `_dir` is an
  ordinary database in every mechanical respect — R2 segments, transactor,
  replicas, live sessions, `asOf`/`history`.

## 2. The directory catalog

Ships in the package (working name `Ramose.Directory`), versioned with the
engine, installed/evolved by the peer — never user-authored.

```ts
const Principal = Ramose.Entity("principal", {
  // Policy principal attr; provisioned by the peer on first _dir session.
  sub: Field.unique(Ramose.string(), "upsert"),
  role: Ramose.string({ optional: true }),        // peer-materialized class
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
  class: Ramose.string(),   // interpreted by the TARGET db's policy
  admin: Ramose.boolean(),  // interpreted by the DIRECTORY: may manage
                            // grants/invites on this db
});

const Invite = Ramose.Entity("invite", {
  email: Ramose.string({ index: true }),
  db: Ramose.Ref(Db),
  class: Ramose.string(),
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

- **`grant.class` vs `grant.admin`.** Class names are per-app policy
  vocabulary (`owner`/`member`/`viewer` in Reef, anything elsewhere), so the
  directory cannot know which string means "may invite". Directory-level
  administration is therefore its own boolean on the grant, checked by the
  directory's own policy rules. A deployment where "owner" implies admin is a
  convention its grant operations encode, not something `_dir` assumes.
- **Grants reference principals by ref; invites carry email.** A grant
  requires the principal row to exist (refs keep integrity); inviting someone
  who has never signed in goes through `invite`, converted to a grant by
  `invite/accept` on their first session.
- **One grant per (sub, db), one class.** `Principal.classes` (plural) is
  the seam; if multi-class grants are ever wanted, `class` becomes card-many
  without changing the resolver contract (`classesOf` already handles it).
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
  classes: ["admin", "principal"],
  superuser: "admin",
  operations: dirOperations,
}, {
  principal: { read: [self, /* admins of a shared db see co-members */ sharesDb] },
  db:        { read: grantedDb },
  grant:     { read: [mine, adminOfGrantsDb] },
  invite:    { read: [myInvite, adminOfInvitesDb] },
  apiKey:    { read: mineByPrincipal },
  operations: {
    createDbOp:     P.class("principal"),                    // any signed-in user
    grantOp:        { class: "principal", rule: adminOfDb }, // on: Db
    revokeGrantOp:  { class: "principal", rule: [ownGrant, adminOfGrantsDb] }, // on: Grant
    inviteOp:       { class: "principal", rule: adminOfDb }, // on: Db
    acceptInviteOp: { class: "principal", rule: myInvite },  // on: Invite
    revokeInviteOp: { class: "principal", rule: adminOfInvitesDb }, // on: Invite
    createApiKeyOp: P.class("principal"),  // effect binds principal = me
    revokeApiKeyOp: { class: "principal", rule: mineByPrincipal }, // on: ApiKey
    setDbStatusOp:  { class: "principal", rule: adminOfDb }, // on: Db
  },
});
```

- **Every verified principal holds class `principal` in `_dir`** — resolution
  for `_dir` itself is: grant row if present (which is how `admin` is held),
  else the implicit `principal` class for any verified `sub`. Deny-by-default
  read arms scope what that class sees to "my slice": my grants, my dbs, my
  invites, co-members of my databases. This *is* the #209 discovery scoping.
- "Owners can invite" is the `grantOp`/`inviteOp` arm: `on: Db`, rule =
  caller holds an `admin: true` grant on that db row. Grant creation targets
  the **db row** (which exists), not the grant row (which doesn't yet) —
  matching the post-#296 rule that arms evaluate against a resolved `on:`
  target.
- `createDbOp`'s effect installs the app catalog into the new database
  (`databases.install`, Reef's existing provisioning pattern), then writes the
  `db` row and the creator's `{class: <app owner class>, admin: true}` grant
  in one `_dir` transaction. Install-then-record with idempotent retry; no
  cross-db atomicity claimed (#167).
- Access audit = `db("_dir").history` over the grant namespace, read under
  these same arms. Rules always evaluate on the current basis, so history
  cannot re-grant (already true engine-wide).

## 4. Identity-only tokens, and the compat matrix

The identity token is today's token **minus** the `ramose` claim:

```
{ iss, aud, sub, iat, exp }
```

No new claim, no new format — a strict reduction, which is what #183's hold
note demands. The verifier (`worker/auth.ts`) branches on presence:

| Token | Path | Notes |
| --- | --- | --- |
| `ramose: { db, class }` present | **static path** — exactly today's: class from the claim, `allows()` pins one db | remains the no-directory mode and the migration-compat mode |
| `ramose` absent | **directory path** — resolve `(sub, X)` via `_dir` (§5) | rejected with 401 when the deployment has no directory |
| `RAMOSE_TOKEN` / `$token` | unchanged, plus the seed route (§6) | |
| API key (`rk_…` prefix) | hash → `_dir` `apiKey` row → `sub` → directory path | agents; no JWT involved (§8) |

- `ramose.attrs` goes away with the claim: profile (name/email) lives on the
  `_dir` principal row, written at first `_dir` provision (the auth service
  can pass profile to the mint-side provision, or the peer copies standard
  OIDC top-level claims if present — open question, minor). Workspace-db
  provisioning that today copies `attrs` into sibling datoms instead reads
  the directory principal row at provision time.
- Directory mode is **opt-in per deployment**: `Server({ directory: true })`
  (or implied by `databases:`-with-grants, §6). Recommendation for the "does
  static-claims survive" open question: yes, as the permanent zero-ceremony
  mode for single-db deployments without an auth service — not merely compat.
  A deployment can run both simultaneously during migration (the branch is
  per-token, not per-deployment).
- The Better Auth mint route drops its two D1 reads: `POST /ramose/token`
  with no `db` argument mints the identity token straight from the session —
  no `classOf`, no org lookup, response `{ token, exp }`. The `{ db }` form
  keeps minting compat tokens until stage 1 completes.

## 5. The resolver

On session open (and on every principal-verifying request) for database X
under the directory path:

1. Verify the JWT as today (issuer, audience, alg pinning, TTL cap, `sub`).
2. Resolve the grant with **one index lookup, same isolate, no network**:
   basis via the existing per-isolate basis cache
   (`fetchBasisWithStats(env, "_dir", request)` — one DO subrequest on miss,
   zero on hit), then
   `db.entid([":grant/key", `${sub}|${X}`])` and pull `class` off the row.
   This read is a system read (unfiltered) — the resolver is the engine, not
   a session.
3. No grant, or `db.status !== "active"` → 401 "token is not valid for this
   database" (same message as today).
4. Grant class not declared by X's policy → 401 (mirror of today's
   undeclared-class rejection, now at resolve time).
5. Build the principal with the seam filled:
   `{ kind, sub, db: X, class: grantClass, classes: [grantClass], claims }`.
   Everything downstream (`classesOf`, `holdsClass`, `isSuperuser`,
   `canChangeSchema`, arms, provisioning of `:ns/role`) already consults the
   seam — **no policy-engine changes**.

For X = `_dir` itself: step 2 falls back to the implicit `principal` class
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
staged, not assumed.

## 6. Bootstrap and seeding

**The recursion's base case is the deploy-time credential, and the one new
power it gains is enumerable.** Under a policy, `$token` can push schema but
not data — correct, and we keep it that way for app databases. Seeding
`_dir` gets a dedicated route:

```
POST /db/_dir/seed        (allowed: $token, directory admins)
{ dbs: [{ name, doc?, status? }...],
  grants: [{ sub, db, class, admin }...],
  admins: [sub...] }                       // grants on _dir itself
```

Executed by the peer as a **system write** — the same trust shape as the
existing `/provision` path (`{system: true}`, bypasses `checkTx`, peer-owned,
never client-reachable). It is declarative and idempotent: upsert by
`db.name` / `grant.key`, never delete (removing an entry from `databases:`
does not revoke; revocation is an explicit act in the directory, matching
"seed, don't own").

Deploy-time flow (`Server`):

1. `directory: true` (or any seed input): install the `Directory` catalog
   into `_dir` (idempotent; schema evolution guarded as usual — the catalog
   is package-versioned, so upgrades ride engine releases).
2. `seedDatabases` runs as today for app catalogs, then posts the seed doc:
   every `databases:` entry becomes a `db` row (name + `doc` — finally
   landing where the #203 amendment said it was destined; `status` defaults
   `"active"`), plus any declared default grants.

```ts
Server("Ramose", {
  directory: { admins: [env.OPERATOR_SUB] },   // _dir admin grants
  databases: {
    app: { schema: App, doc: "The app database",
           grants: { [env.OPERATOR_SUB]: { class: "owner", admin: true } } },
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
- The policy-head `superuser` class stays what #179 made it: standing within
  a database's policy. `_dir`'s policy names `admin` as its superuser; a
  deployment operator is "root" by holding an `admin` grant on `_dir`, and
  their standing in app databases is whatever grants say — cross-database
  omnipotence is a set of rows you can read, not an ambient property.

## 7. Client surface

Resolves the #183 questions deliberately deferred to this design:

- **The credential attaches to the client, not the database handle.**
  `connect({ url, token })` with an identity token; `client.db(name,
  catalog)` takes no token. The per-db `{ token }` form survives as the
  static-mode/compat spelling.
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
  the JWT no longer carrying class, the unverified-claims fallback
  (`claims?.ramose?.class` in Reef's screens) is deleted rather than fixed —
  one source of truth remains.

## 8. Agent principals and API keys (#209)

Agents are ordinary principals — same rows, same deny-by-default policy,
same audit surface:

- A `principal` row with `kind: "agent"` and a synthetic sub
  (`agent:<uuid>`), plus `apiKey` rows referencing it.
- `createApiKeyOp` (a `_dir` operation) generates a high-entropy secret
  server-side, returns it **once** in the operation output, and stores only
  its SHA-256 in `keyHash` (`unique strict`). A hash of a 256-bit random
  secret is not sensitive data, so keys don't gate on the erasure story.
- The peer accepts `Authorization: Bearer rk_<secret>`: hash, look up the
  `apiKey` row (one entid on `keyHash`), check `status: "active"`, then
  enter the directory path (§5) with the key's principal `sub`. Revocation
  is `revokeApiKeyOp` — effective at resolver latency, no TTL involved.
- Grants for agents are ordinary grant rows; "what did the agent do" is
  provenance + `history`, as #209 frames it.

## 9. `learn()` alignment (#209)

`learn()` with no argument = a query over `_dir` under the caller's own
session: db rows visible to me (deny-by-default already scoped them), each
joined with my grant's `class`, plus `doc` — precisely the "name,
description, the caller's class there" card. Live by construction. The
static-claims fallback (`learn()` enumerates from the token) stays as
specified there; both paths sit behind the same tool surface.

## 10. Staged D1 removal

| Stage | Moves | Mechanism | Gate |
| --- | --- | --- | --- |
| 1 | `organization`, `member`, `invitation` → `_dir` `db`/`grant`/`invite` | Migration op reads Better Auth's org API once and seeds `_dir` (org slug → db name, `member.role` through Reef's `classOfRole` → grant class, role owner/admin → `admin: true`); then Reef drops the org plugin, mint goes identity-only, UI queries `_dir` | none — this is the core |
| 2 | `jwks` → Durable Object storage (or Workers secrets) | Wanted regardless: the pinning ritual exists because `BetterAuthSecret` (encrypting `jwks.privateKey`) lives only in Alchemy state, so a cache miss remints it and orphans the keys. Keys in DO storage keyed by deployment, rotated in place, published unchanged at `/api/auth/jwks` | independent of stage 1 |
| 3 | `user`, `account`, `session`, `verification` → Better Auth adapter backed by Ramose (`_auth`, sibling of `_dir`) | Adapter implements Better Auth's CRUD contract over named system operations | **erasure story** (§11) + adapter-contract gaps: composite uniqueness (`user.email` is single-attr and fine; `member` is gone by then), sort/limit/IN (query surface exists post-#299), hard deletes (retraction suffices *only* under shredding) |
| 4 | bootstrap circularity | Dissolved by §6: minting never reads the directory; the peer never calls the auth service; deploy seeds via `$token`. The resource graph stays a DAG | falls out |

Recommendation for the "identity in `_dir` or a sibling" open question:
**sibling `_auth`**. `_dir` is broadly readable by design (every principal
lists their workspaces); identity storage is secret-bearing, erasure-gated,
and read by nothing but the auth service. Different sensitivity, different
policy, different lifecycle — different database. `SYSTEM_DATABASES` grows
by one string when stage 3 lands.

End state: one storage system (DO + R2), no D1, no migration files; identity,
grants, and databases as policy-guarded, live-queryable, auditable data.

## 11. Erasure: crypto-shredding sketch (stage 3 gate)

Secrets in an append-only, time-travelable store are readable forever via
`asOf` — deletion is retraction, not excision (documented engine behavior).
Leading candidate, as the issue anticipates: **crypto-shredding**.

- Fields marked secret at schema level (working spelling:
  `Ramose.shredded(Ramose.string())`) store `Bytes` ciphertext under a
  per-principal data-encryption key (AES-256-GCM).
- DEKs live in **mutable transactor-DO storage** of the owning system
  database — colocated, deletable, no new DO namespace; a small
  internal-gated keyring API on the transactor (`get/create/deleteKey(sub)`).
- Encrypt at transact, decrypt at read for authorized readers; both happen
  server-side in paths that already run inside the DO.
- Erasing a principal = delete their DEK + retract their rows. Every
  historical ciphertext datom — password hash, session token, refresh token,
  email if marked — becomes permanently unreadable, including via
  `asOf`/`history`. GC of unreadable segments can lag; confidentiality does
  not depend on it.
- True excision (rewriting segments) stays the heavier alternative if
  regulators require the bytes gone rather than unreadable; "secrets never
  enter Ramose" (identity stays outside) remains the fallback that abandons
  stage 3 without harming stages 1–2.
- Honest scope note: identity PII already leaks into workspace databases
  today (`ramose.attrs` → `:user/email` datoms), so an erasure story is owed
  before 1.0 with or without stage 3 — §4 stops the leak at the source
  (profile stops riding tokens), and shredded fields are the candidate
  answer for app data too.

## Open questions (remaining)

1. Exact combinator spellings for the directory policy arms (§3 sketch), and
   whether directory operations are hand-written or lean on #302's generated
   CRUD + arms.
2. Push invalidation for live sockets (§5): transactor revocation watermark
   vs replica-side epoch check — needs a small transactor→replica signal
   design.
3. Profile propagation into `_dir` principal rows: mint-side provision vs
   OIDC top-level claims (§4).
4. Whether `grant.class` becomes card-many (multi-class grants) before or
   after 1.0 — the seam supports either.
5. `_dir` catalog/policy versioning across engine upgrades: evolution guard
   semantics for a package-owned schema (likely: additive-only, enforced in
   CI like the wire contract).
6. Stage-3 adapter details once Better Auth's full contract is pinned down
   (this repo doesn't vendor it) — sort/limit/IN coverage, session sweep
   cadence.

## Constraints honored

| Binding decision | How this design satisfies it |
| --- | --- |
| #183 hold: no new token claim formats; identity-only is the target | Identity token is a strict subset of today's payload; the single-db claim survives unchanged as static/compat mode; deferred #183 items (credential attachment point, remount elimination) resolved in §7 |
| #179: superuser as directory bootstrap | `Principal.classes` seam is the resolver's write target (§5); policy-head `superuser` semantics untouched; `_dir` admin = a grant row, the recursion's base case is the `$token` seed (§6) |
| #203: `databases:` is a seed, not the authority | Seeding posts declarative rows to `_dir` and stores nothing resource-side; `doc` lands in the directory; removal from the prop revokes nothing (§6) |
| #209: discovery as a directory query, static-claims fallback | §9; agent principals as ordinary rows + API keys (§8), both paths behind one tool surface |
| AGENTS.md (5): don't deepen Better Auth/D1 coupling | Stage 1 removes the mint route's D1 reads entirely; core design has zero new D1 touchpoints |
| Decision 1/6/7 (operations-only writes, no deprecation windows, put/update semantics) | All directory writes are named operations under deny-by-default arms; compat is a mode, not a deprecation window; seed uses upsert-by-unique-key semantics |
