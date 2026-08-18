# Reef — feature → code map

Source of truth: `/Users/tvanhens/git/ripple/examples/reef` at commit `2659601` (branch `master`, 2026-08-18). Every code block below is copied verbatim from the file named in its heading; line numbers are the file's own. Package internals cited from `/Users/tvanhens/git/ripple/packages/*` are noted as such.

---

## 1. Overview

### What Reef is (plain English)

Reef is a small Linear-style issue tracker: you sign up, create a "workspace" for your team, and get a four-column kanban board (Backlog / Todo / In Progress / Done) with drag-and-drop cards, an issue side panel (title, description, status, priority, assignee, labels, comments, an admin-only note), invitations with three roles (admin / member / viewer), a "Time travel" slider that shows the board as it looked after any earlier change, and a dark/light theme. Every change anyone makes shows up in every open tab within about a second, without a refresh. Under the hood, **each workspace is its own Ramose database**, created from the browser the moment you click "Create" — no deploy, no migration, no per-tenant server code. The whole backend is one Cloudflare Worker running Ramose plus one small auth Worker running Better Auth; the app itself never writes an API route for its data.

### Runtime topology

```
                ┌───────────────────────────────────────────────────────────┐
                │ browser SPA  (Vite + React 19 + StyleX)   http://localhost:5173
                │   @ramose/react hooks: useLive / usePull / useQuery /       │
                │   useTransact / useBasis   ·   Better Auth React client     │
                └───────────┬───────────────────────────────┬───────────────┘
        cookies + /api/*    │                               │  JWT per request
        (Vite proxies /api  │                               │  (WebSocket session for reads/ticks,
         → :1338 in dev)    ▼                               ▼   HTTPS POST for writes)
   ┌────────────────────────────────┐        ┌────────────────────────────────────────┐
   │ auth Worker  :1338             │        │ Ramose peer Worker  :1337              │
   │ Better Auth on D1              │  JWKS  │ RAMOSE_POLICY (compiled from           │
   │  · email+password sign-in      │◄───────│   src/domain/policy.ts)                │
   │  · organization plugin         │  GET   │ RAMOSE_JWKS_URL → verifies every JWT   │
   │    (a workspace *is* an org)   │        │  ├─ TransactorDO   (one per database)  │
   │  · jwt plugin (/api/auth/jwks) │        │  ├─ QueryReplicaDO (reads / basis)     │
   │  · @ramose/better-auth mint:   │        │  └─ R2 bucket "Store" (immutable log   │
   │    POST /api/auth/ramose/token │        │        + segments for every workspace)  │
   │  · serves the built SPA (prod) │        └────────────────────────────────────────┘
   └────────────────────────────────┘
   The auth Worker never talks to the peer. The browser is the only data-plane client.
```

(Diagram source for the two-Worker relationship: `README.md:44-57`.)

### How to run it

From the repo root:

```sh
bun run dev:reef
```

which is (`package.json` `scripts.dev:reef`):

```sh
CI=1 ALCHEMY_STATE=local \
  CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
  CLOUDFLARE_API_TOKEN=x \
  bun alchemy dev examples/reef/alchemy.run.ts
```

Ports / URLs (pinned in `src/domain/shared.ts:36-39`):

| what | where |
|---|---|
| Ramose peer | http://localhost:1337 (`DEV_PEER_PORT = 1337`) |
| auth Worker | http://localhost:1338 (`DEV_API_PORT = 1338`) |
| SPA (Vite) | http://localhost:5173 (`DEV_UI_ORIGIN`) — **open this** |
| Better Auth routes | `/api/auth/*` on the auth Worker; JWKS at `/api/auth/jwks`; mint at `POST /api/auth/ramose/token` |

Tests: `bun test examples/reef` (part of the root `bun run test`).

Deploy to real Cloudflare (`README.md:126-137`): `bun alchemy deploy examples/reef/alchemy.run.ts`, then `VITE_RAMOSE_URL=<peerUrl> bunx vite build examples/reef`, then deploy again so the built SPA ships as the auth Worker's assets. Needs an API token with Workers Scripts + R2 + `Account / D1 / Edit`.

### The user's flow

1. **Sign up** (`AuthScreen`): name + email + password. Accounts are auto-verified (no mailer). Toggle to "Sign in" if you already have one.
2. **Workspaces** (`WorkspacesScreen`): "Hi, Ada" — list of your workspaces (each shows `db/<slug>`), pending invitations ("Accept & open"), and a "New workspace" form. Typing "Coral Team" previews `ramose.db("coral-team").install()`. Clicking **Create** makes a Better Auth org, mints a JWT for that database, runs `install()` + seeds four labels + your `user` row, and opens the board.
3. **Board** (`BoardScreen`): header with workspace name, `db/<slug>`, your class badge (`admin`/`member`/`viewer`), a "live · N ticks" pill that pulses on every push, "Time travel", "Invite" (admin only), theme toggle, avatar, sign-out. Four columns with "+" buttons; an empty board offers "Add sample issues" (nine issues in one transaction) or "New issue".
4. **Issue panel**: click a card → side panel with editable title, "opened by …", status/priority/assignee selects, label toggles, description, "Admin note" (masked for non-admins), comments.
5. **Time travel**: a slider from `t=1` to the current basis; the board re-renders "as of transaction t"; deleted issues appear in a "Deleted, still in history" strip. "Back to live" returns.
6. **Invite → viewer**: admin invites an email as admin/member/viewer; the invitee sees it under "Invitations" on their workspace screen, accepts, and opens the board with a `viewer` badge. Dragging a card as a viewer produces a red toast: `retract denied on :issue/status`.

---

## 2. Feature table

Summary first; per-feature detail (with verbatim excerpts) follows.

| # | Feature | Plain-English one-liner | Ramose feature | Main files |
|---|---|---|---|---|
| F1 | Sign up / sign in | Email + password accounts | (Better Auth; Ramose only *verifies* JWTs) | `src/app/screens/AuthScreen.tsx`, `src/app/auth.ts`, `src/infra/api.ts` |
| F2 | Create workspace | A new database appears the moment you click Create | multi-tenancy: `ramose.db(slug, Reef).install()` at runtime | `src/app/screens/WorkspacesScreen.tsx`, `src/app/ramose.ts`, `src/app/mutations.ts:28-45` |
| F3 | Open / switch workspace | Each workspace has its own connection & token | `RamoseProvider key={slug}`, `Ramose.token.jwt` auto-refresh | `src/app/App.tsx:144-158`, `src/app/ramose.ts:33-51` |
| F4 | Board with columns | Four columns, ordered cards | `useLive(db, boardQuery)` — one standing query | `src/app/screens/BoardScreen.tsx:230-234`, `src/domain/queries.ts:66-68`, `src/app/components/Board.tsx` |
| F5 | Create issue | "+" on a column opens a dialog | `db.transact` with `tx.entity()` + `.add` | `src/app/mutations.ts:87-110`, `BoardScreen.tsx:404-421,494-593` |
| F6 | Move issue (drag) | Drag a card to another column / position | one transact = two datoms (status + rank) | `src/app/mutations.ts:113-122`, `Board.tsx:196-209`, `src/domain/rank.ts` |
| F7 | Edit issue (detail panel) | Title, description, status, priority, assignee, labels | `usePull` standing pull + small transacts; `tx.retract` | `src/app/components/IssueDetail.tsx`, `src/app/mutations.ts:125-172` |
| F8 | Labels | Colored chips, many per issue | `cardinality: "many"` ref attribute; add/retract | `src/domain/schema.ts:24-27,41`, `mutations.ts:156-165` |
| F9 | Assignees / people | Pick a teammate | `Ref(() => User)`, join through the ref in a query | `schema.ts:39-40`, `queries.ts:17,31-32`, `mutations.ts:146-154` |
| F10 | Priorities | 0–4 with glyphs | `Ramose.Long` attribute | `schema.ts:35`, `mutations.ts:141-144` |
| F11 | Ranking / drag ordering | Cards keep their order | fractional rank stored as one `Schema.Number` datom | `src/domain/rank.ts`, `queries.ts:67` (`orderBy(Issue.rank)`) |
| F12 | Live updates across tabs/users | Every tab updates ~1s after any write | `db.live` over the session WebSocket; basis ticks | `useLive` (pkg), `BoardScreen.tsx:264-305` (tick pulse) |
| F13 | Comments | Per-issue thread with authorship | per-issue live query; `preset` authorship | `queries.ts:78-82`, `IssueDetail.tsx:267-270`, `mutations.ts:179-196` |
| F14 | Invite / roles | admin, member, viewer | Better Auth org roles → `ramose.class` claim | `src/domain/roles.ts`, `BoardScreen.tsx:597-669`, `WorkspacesScreen.tsx:223-237`, `packages/better-auth` |
| F15 | Permission enforcement | Viewer can't write; member edits only their own; peer refuses, UI toasts | `Ramose.Policy` compiled into the peer; `Unauthorized` | `src/domain/policy.ts`, `BoardScreen.tsx:243-245`, `IssueDetail.tsx:246-248` |
| F16 | Masked field (admin note) | Non-admins never receive the value | per-attribute `read` rule; `.optional` in pull shapes; compile-time check | `policy.ts:56-60`, `queries.ts:40-46`, `test/policy.test.ts:65-76` |
| F17 | Time travel slider | See the board as of any past transaction | `db.asOf(t)`, `useBasis` | `BoardScreen.tsx:439-490`, `src/app/components/TimeTravel.tsx` |
| F18 | History / deleted issues | Deleted issues still listed | `db.history` | `queries.ts:84-88`, `BoardScreen.tsx:454-460` |
| F19 | Delete issue / comment | Trash icon | `tx.retractEntity` | `mutations.ts:174-177,193-196` |
| F20 | Sample data | "Add sample issues" | nine issues, labels, assignees in one `db.transact` | `mutations.ts:200-303` |
| F21 | Dark / light theme | Sun/moon toggle, persisted | (StyleX `createTheme`; not Ramose) | `src/app/App.tsx:47-100`, `src/app/theme/*` |
| F22 | Deploy / infra | One stack file: peer + auth + dev UI | `Ramose.Server`, `Ramose.authEnv`, no `Ramose.Database` | `alchemy.run.ts`, `src/infra/resources.ts`, `src/infra/api.ts` |

### F1 — Sign in / sign up

- **Plain English**: create an account with email + password; sign in later. Accounts are auto-verified because the demo ships no mailer.
- **Ramose feature**: none directly — identity is Better Auth's. Ramose's role is to *verify* the JWT that Better Auth signs (JWKS) and read `sub` + `ramose.{db,class}` from it.
- **Files**: `src/app/screens/AuthScreen.tsx:136-157` (form), `src/app/auth.ts:12-18` (client), `src/infra/api.ts:74-121` (server config).
- **Excerpt** — `src/app/screens/AuthScreen.tsx:144-157`:

```ts
  const submit = async () => {
    setBusy(true);
    try {
      const result =
        mode === "up"
          ? await authClient.signUp.email({ name, email, password })
          : await authClient.signIn.email({ email, password });
      if (result.error) {
        toast("error", result.error.message ?? "authentication failed");
      }
    } finally {
      setBusy(false);
    }
  };
```

- **Excerpt** — `src/infra/api.ts:74-79`, `92-121` (the whole auth server):

```ts
  Effect.gen(function* () {
    const auth = yield* BetterAuth({
      basePath: AUTH_BASE_PATH,
      emailAndPassword: { enabled: true },
      // The Vite dev server proxies /api here, so browser-visible origins are
      // the Vite origin (dev) and the Worker's own origin (deployed assets).
      trustedOrigins: [DEV_UI_ORIGIN],
```
```ts
      plugins: [
        organization({
          ac,
          roles,
          // Invitations are in-app only: invitees see them on their next
          // sign-in via listUserInvitations. Nothing to send.
          async sendInvitationEmail() {},
        }),
        jwt({
          jwt: {
            issuer: REEF_AUTH.issuer,
            audience: REEF_AUTH.audience,
            expirationTime: `${REEF_AUTH.ttl}s`,
          },
        }),
        // `POST /api/auth/ramose/token { db }` → `{ token, class, exp }`.
        // The session cookie authenticates the caller; `orgClassOf` maps
        // their membership in the org whose slug is `db` to a policy class
        // (owner|admin → admin, member → member, else viewer; no org and no
        // membership are the same 403); `Ramose.claims` builds the claim set
        // the peer verifies from the same REEF_AUTH the peer's env pins,
        // validated against the compiled policy; signing uses the same JWKS
        // key the /api/auth/jwks endpoint publishes.
        ramoseToken({
          auth: REEF_AUTH,
          policy: compiledPolicy(),
          classOf: orgClassOf(),
        }),
      ],
    });
```

- **What you didn't have to write**: password hashing, sessions, cookies, org/member tables, JWKS key management, the token-mint route (it's the `ramoseToken` plugin from `@ramose/better-auth`), the role→class mapping (`orgClassOf()` default), any auth middleware on the data plane (the peer verifies per request).
- **Screenshot moment**: the sign-up card ("Create your account", three feature blurbs Live / Multi-tenant / Time travel at the bottom).

### F2 — Create workspace (= a new database from the browser)

- **Plain English**: type "Coral Team", click Create, and you have a fresh, empty, isolated database for that team — instantly, from the browser.
- **Ramose feature**: multi-tenancy by name. `ramose.db(slug, Reef)` is pure; `db.install()` writes the schema as an ordinary (idempotent) transaction, under the creator's freshly minted admin JWT. There is no `Ramose.Database` resource in the stack (`src/infra/resources.ts:68-74`), unlike the todos example which installs at deploy (`examples/todos/alchemy.run.ts:34`).
- **Files**: `src/app/screens/WorkspacesScreen.tsx:208-221` (create), `src/app/App.tsx:125-137,164-165` (`enter(..., provision=true)`), `src/app/ramose.ts:33-51` (`openWorkspace`), `src/app/mutations.ts:28-45` (`provisionWorkspace`), `src/domain/shared.ts:57-67` (slug rules).
- **Excerpt** — `src/app/mutations.ts:28-45`:

```ts
export const provisionWorkspace = (
  db: ReefDb,
  me: { id: string; name: string; email: string },
) =>
  Effect.gen(function* () {
    yield* db.install();
    yield* db.transact(function* (tx) {
      const user = yield* tx.entity();
      yield* user.add(User.sub, me.id);
      yield* user.add(User.name, me.name);
      yield* user.add(User.email, me.email);
      for (const seed of SEED_LABELS) {
        const label = yield* tx.entity();
        yield* label.add(Label.name, seed.name);
        yield* label.add(Label.color, seed.color);
      }
    });
  });
```

- **Excerpt** — `src/app/ramose.ts:33-51`:

```ts
export const openWorkspace = async (
  slug: string,
  user: { id: string; name: string; email: string },
  provision: boolean,
): Promise<Workspace> => {
  const token = Ramose.token.jwt(() => authClient.ramose.token({ db: slug }));
  const cls = ((await token.claims()).ramose?.class ?? "viewer") as RamoseClass;
  const ramose = Ramose.connect({ url: RAMOSE_URL, token });
  try {
    const db = ramose.db(slug, Reef);
    if (provision) await Effect.runPromise(provisionWorkspace(db, user));
    const myEid = await Effect.runPromise(
      ensureSelf(db, user, cls !== "viewer"),
    );
    return { slug, cls, token, myEid };
  } finally {
    await ramose.close();
  }
};
```

- **Excerpt** — `src/app/screens/WorkspacesScreen.tsx:381-390` (the on-screen preview):

```tsx
                <div {...stylex.props(styles.slugPreview)}>
                  {slug !== "" ? (
                    <>
                      <Icon name="arrowRight" size={11} />
                      <Code>ramose.db(&quot;{slug}&quot;).install()</Code>
                    </>
                  ) : (
                    "the name becomes the database"
                  )}
                </div>
```

- **What you didn't have to write**: per-tenant provisioning scripts, migrations, a "create schema" endpoint, tenant routing (`ramose.db(name)` *is* the routing), tenant-scoped connection strings, R2/DO wiring per tenant.
- **Screenshot moment**: the "New workspace" card with "Coral Team" typed and the `→ ramose.db("coral-team").install()` preview beneath it; then the empty board immediately after.

### F3 — Open / switch workspace (per-tenant client + token refresh)

- **Plain English**: opening a workspace connects you to that database only; your credentials for it refresh themselves; switching workspaces swaps the connection.
- **Ramose feature**: `Ramose.token.jwt(mint)` — a self-refreshing token source (re-mints inside 2 min of `exp`; the JWT ttl is 900 s); `RamoseProvider key={slug}` closes the old client and connects a new one.
- **Files**: `src/app/App.tsx:144-158`, `src/app/ramose.ts:38`, `packages/react/src/RamoseProvider.tsx:37-67`, `packages/alchemy/src/db/token.ts`.
- **Excerpt** — `src/app/App.tsx:144-158`:

```tsx
  if (open !== null) {
    return (
      <RamoseProvider
        key={open.workspace.slug}
        url={RAMOSE_URL}
        token={open.workspace.token}
      >
        <BoardScreen
          workspace={open.workspace}
          name={open.name}
          user={me}
          onLeave={() => setOpen(null)}
        />
      </RamoseProvider>
    );
  }
```

- **What you didn't have to write**: token refresh timers, reconnect logic, per-tenant connection pools, "which tenant is this request for" plumbing.
- **Screenshot moment**: the workspace list with two workspaces (`db/coral-team`, `db/deep-sea`) and the "opening" spinner on one.

### F4 — Board with columns

- **Plain English**: four columns of cards, sorted, always current.
- **Ramose feature**: one hoisted navigational query (`Ramose.query(Issue).orderBy(Issue.rank).select(boardShape)`), read with `useLive` — the columns are just `rows.filter(status)`.
- **Files**: `src/domain/queries.ts:24-34,66-68`, `src/app/screens/BoardScreen.tsx:230-234,262-271`, `src/app/components/Board.tsx:171-331`.
- **Excerpt** — `src/app/screens/BoardScreen.tsx:228-234`:

```ts
  const { cls, slug, myEid } = workspace;
  const toast = useToast();
  const db = useDb(slug, Reef);

  const board = useLive(db, boardQuery);
  const people = useLive(db, peopleQuery);
  const labels = useLive(db, labelsQuery);
```

- **Excerpt** — `src/app/components/Board.tsx:213-217`:

```tsx
  return (
    <div {...stylex.props(styles.board)}>
      {STATUSES.map((status) => {
        const column = rows.filter((r) => r.status === status);
        const over = overColumn === status && dragging;
```

- **What you didn't have to write**: a `GET /issues` endpoint, a fetch + cache layer, invalidation, a "refetch after mutation" call (there is none anywhere in the app), a store/reducer for board state.
- **Screenshot moment**: full board with 9–12 cards, avatars and label chips, "live · 3 ticks" pill in the header.

### F5 — Create issue

- **Plain English**: "+" on a column (or "New issue") opens a dialog; the card appears in that column at the bottom.
- **Ramose feature**: `db.transact(function* (tx) { const issue = yield* tx.entity(); yield* issue.add(...) })` — one atomic write; the peer presets `Issue.creator` to the caller (policy `preset`), so writing it yourself is the same datom.
- **Files**: `src/app/mutations.ts:87-110`, `src/app/screens/BoardScreen.tsx:404-421` (submit), `494-593` (dialog).
- **Excerpt** — `src/app/mutations.ts:86-110`:

```ts
/** `creator` is preset by the peer; writing it explicitly is the same datom. */
export const createIssue = (
  db: ReefDb,
  myEid: number,
  lastRankInColumn: number | undefined,
  draft: NewIssue,
) =>
  db.transact(function* (tx) {
    const issue = yield* tx.entity();
    yield* issue.add(Issue.title, draft.title);
    if (draft.description !== undefined && draft.description !== "") {
      yield* issue.add(Issue.description, draft.description);
    }
    yield* issue.add(Issue.status, draft.status);
    yield* issue.add(Issue.priority, draft.priority);
    yield* issue.add(Issue.rank, rankAfter(lastRankInColumn));
    yield* issue.add(Issue.createdAt, new Date());
    yield* issue.add(Issue.creator, myEid);
    if (draft.assigneeId !== undefined) {
      yield* issue.add(Issue.assignee, draft.assigneeId);
    }
    for (const labelId of draft.labelIds ?? []) {
      yield* issue.add(Issue.labels, labelId);
    }
  });
```

- **Excerpt** — `src/app/screens/BoardScreen.tsx:409-419` (UI → mutation):

```tsx
          onSubmit={(draft) => {
            if (myEid === undefined) {
              toast("error", "viewers cannot create issues");
              return;
            }
            const column = liveRows.filter((r) => r.status === draft.status);
            void run(
              createIssue(db, myEid, column[column.length - 1]?.rank, draft),
            );
            setDraftStatus(null);
          }}
```

- **What you didn't have to write**: `POST /issues`, request validation (types come from the catalog), an ORM model, "who created this" server code (`preset`), optimistic-update bookkeeping.
- **Screenshot moment**: the "New issue · In Progress" dialog with the segmented priority control.

### F6 — Move issue (drag and drop)

- **Plain English**: drag a card to a new column or between two cards; every open tab shows the move.
- **Ramose feature**: a move is one transaction of two datoms (`:issue/status`, `:issue/rank`); the board has no local reorder state — it re-renders when the peer's basis tick comes back.
- **Files**: `src/app/mutations.ts:112-122`, `src/app/components/Board.tsx:196-209` (drop → rank), `src/app/screens/BoardScreen.tsx:346-348`, `src/domain/rank.ts`.
- **Excerpt** — `src/app/mutations.ts:112-122`:

```ts
/** Drag-and-drop: one status datom + one rank datom. */
export const moveIssue = (
  db: ReefDb,
  issueId: number,
  status: Status,
  rank: number,
) =>
  db.transact(function* (tx) {
    yield* tx.add(issueId, Issue.status, status);
    yield* tx.add(issueId, Issue.rank, rank);
  });
```

- **Excerpt** — `src/app/components/Board.tsx:196-209`:

```ts
  const drop = (status: Status, before: BoardRow | undefined) => {
    if (dragId === null) return;
    const column = rows.filter((r) => r.status === status && r.id !== dragId);
    const rank =
      before === undefined
        ? rankAfter(column[column.length - 1]?.rank)
        : rankBetween(
            column[column.findIndex((r) => r.id === before.id) - 1]?.rank,
            before.rank,
          );
    onMove(dragId, status, rank);
    setDragId(null);
    setOverColumn(null);
  };
```

- **What you didn't have to write**: `PATCH /issues/:id`, a reorder endpoint that rewrites sibling positions, conflict handling between tabs, WebSocket broadcast of the move.
- **Screenshot moment**: mid-drag with the target column highlighted ("Drop here"), or a two-window shot after the drop.

### F7 — Edit issue (detail panel)

- **Plain English**: click a card to edit its title, description, status, priority, assignee, labels; edits from another tab land in place.
- **Ramose feature**: status/priority/assignee/labels come from the *live board row* (already reactive); title/description/admin note ride one standing `usePull(db, { id }, issueExtraShape)`; each field change is a one-datom transact; clearing a field is `tx.retract`.
- **Files**: `src/app/components/IssueDetail.tsx:246-277` (hooks), `303-316` (title), `331-401` (meta grid), `403-415` (description); `src/app/mutations.ts:125-172`.
- **Excerpt** — `src/app/components/IssueDetail.tsx:254-270`:

```ts
  // A standing pull: `{ id: issueId }` inline is fine (the subject is
  // structural), and every emission — an edit from any tab — resets the
  // drafts, so the panel updates in place.
  const extra = usePull(db, { id: issueId }, issueExtraShape).rows ?? null;
  useEffect(() => {
    if (extra === null) return;
    setTitleDraft(extra.title);
    setDescriptionDraft(extra.description ?? "");
    setNoteDraft(extra.privateNote ?? "");
  }, [extra]);

  // built per id, so memoise the query on `issueId` — its one dependency
  const comments = useLive(
    db,
    useMemo(() => commentsQuery(issueId), [issueId]),
  );
```

- **Excerpt** — `src/app/mutations.ts:135-139`:

```ts
export const setDescription = (db: ReefDb, issueId: number, text: string) =>
  db.transact(function* (tx) {
    if (text === "") yield* tx.retract(issueId, Issue.description);
    else yield* tx.add(issueId, Issue.description, text);
  });
```

- **What you didn't have to write**: `GET /issues/:id`, per-field `PATCH` handlers, form-state sync with the server, "someone else edited this" refresh logic.
- **Screenshot moment**: the side panel open on an issue with two labels, an assignee, and a comment; a second window showing the same panel receiving the edit.

### F8 — Labels

- **Plain English**: colored chips; an issue can have several.
- **Ramose feature**: `labels: Ramose.Attr(Ramose.Ref(() => Label), { cardinality: "many" })` — a set-valued reference; toggling is `tx.add`/`tx.retract` of one datom; the query joins through it (`Issue.labels.select(labelShape)`).
- **Files**: `src/domain/schema.ts:24-27,41`, `src/domain/queries.ts:18-22,33,74-76`, `src/app/mutations.ts:156-165`, `IssueDetail.tsx:384-400`.
- **Excerpt** — `src/app/mutations.ts:156-165`:

```ts
export const toggleLabel = (
  db: ReefDb,
  issueId: number,
  labelId: number,
  on: boolean,
) =>
  db.transact(function* (tx) {
    if (on) yield* tx.add(issueId, Issue.labels, labelId);
    else yield* tx.retract(issueId, Issue.labels, labelId);
  });
```

- **What you didn't have to write**: an `issue_labels` join table, its migration, the join query, a labels CRUD API.
- **Screenshot moment**: label chips row in the panel with two toggled on.

### F9 — Assignees / people

- **Plain English**: assign an issue to a teammate; their avatar shows on the card.
- **Ramose feature**: `assignee: Ramose.Attr(Ramose.Ref(() => User))` — a targeted ref; the board query selects through it: `assignee: Issue.assignee.select(personShape).optional`. People list is `peopleQuery` (users who have entered the workspace — `ensureSelf` writes your row on first entry).
- **Files**: `src/domain/schema.ts:14-22,39-40`, `src/domain/queries.ts:17,31-32,70-72`, `src/app/mutations.ts:55-75,146-154`.
- **Excerpt** — `src/domain/queries.ts:24-34`:

```ts
export const boardShape = {
  id: Issue.id,
  title: Issue.title,
  status: Issue.status,
  priority: Issue.priority,
  rank: Issue.rank,
  createdAt: Issue.createdAt,
  creator: Issue.creator.select(personShape),
  assignee: Issue.assignee.select(personShape).optional,
  labels: Issue.labels.select(labelShape),
} as const;
```

- **What you didn't have to write**: a users table sync from the auth system (the `user` row is written by the app on first entry and `sub` is pinned to the token by policy), foreign-key joins, N+1 loaders.
- **Screenshot moment**: card with an avatar top-right; the Assignee select open in the panel.

### F10 — Priorities

- **Plain English**: none/low/medium/high/urgent glyph on each card.
- **Ramose feature**: `priority: Ramose.Attr(Ramose.Long)`; set with one `tx.add`.
- **Files**: `src/domain/schema.ts:34-35,76`, `src/app/mutations.ts:141-144`, `src/app/ui.tsx:602-` (`PriorityIcon`).
- **What you didn't have to write**: an enum column + migration + validation endpoint.
- **Screenshot moment**: the segmented priority radio in the New issue dialog.

### F11 — Ranking / drag ordering

- **Plain English**: cards remember their order in a column.
- **Ramose feature**: fractional ranking — position is one `Schema.Number` datom; `orderBy(Issue.rank, "asc")` in the board query does the sorting server-side.
- **Files**: `src/domain/rank.ts` (30 lines), `src/domain/queries.ts:66-68`, `test/rank.test.ts`.
- **Excerpt** — `src/domain/rank.ts:8-23`:

```ts
export const RANK_GAP = 1024;

/** The rank for appending after `last` (or the first rank of an empty list). */
export const rankAfter = (last: number | undefined): number =>
  last === undefined ? RANK_GAP : last + RANK_GAP;

/** A rank strictly between two neighbours (either side may be open). */
export const rankBetween = (
  before: number | undefined,
  after: number | undefined,
): number => {
  if (before === undefined && after === undefined) return RANK_GAP;
  if (before === undefined) return (after as number) - RANK_GAP;
  if (after === undefined) return before + RANK_GAP;
  return (before + after) / 2;
};
```

- **What you didn't have to write**: "shift every sibling's position" updates; a sort in the client.
- **Screenshot moment**: (same as F6).

### F12 — Live updates across tabs / users

- **Plain English**: open the board twice (or as two people); a change in one appears in the other within about a second, and the "live" pill pulses.
- **Ramose feature**: `db.live(query)` — the client holds one WebSocket session per database (`GET /db/:name/session`), the peer pushes unsolicited `{ op: "t" }` basis ticks (it polls the replica about once a second per db per isolate and shares the reading across sessions — `packages/worker/src/session.ts:105,186-205`), and each tick re-runs standing queries; a pass with identical rows is not re-emitted. `useLive` exposes `{ rows, error, ticks }`.
- **Files**: `src/app/screens/BoardScreen.tsx:264-305` (tick pulse), `packages/react/src/useLive.ts:50-114`, `packages/alchemy/src/db/Db.ts` (`live` at 59-66 of the interface region), `packages/alchemy/src/db/session.ts:1-21`.
- **Excerpt** — `src/app/screens/BoardScreen.tsx:264-267,287-305`:

```tsx
  const liveRows = board.rows;
  // `ticks` counts emissions after the first — every one is a basis change
  // the peer pushed, and the pulse makes that reactivity visible.
  const ticks = board.ticks;
```
```tsx
        <span
          {...stylex.props(styles.live, styles.wide)}
          title="Every board update is a basis tick pushed by the peer over db.live"
        >
          <span
            key={ticks}
            {...stylex.props(
              styles.liveDot,
              timeTraveling && styles.liveDotPaused,
              ticks > 0 && !timeTraveling && styles.liveDotPulse,
            )}
          />
          {timeTraveling ? "paused" : "live"}
          {ticks > 0 && (
            <span {...stylex.props(styles.liveMono)}>
              {ticks} {ticks === 1 ? "tick" : "ticks"}
            </span>
          )}
        </span>
```

- **Excerpt** — package mechanism, `packages/react/src/useLive.ts:50-54,69-75`:

```ts
/** Query form: `db.live(query)`, memoised on the view's structural key and `query`. */
export function useLive<C extends Catalog.Any, R>(
  db: ReadDb<C>,
  query: QueryInput<R>,
): Live<R>;
```
```ts
  const stream = useMemo(
    () =>
      query === undefined
        ? (source as Stream.Stream<unknown, unknown>)
        : (source as ReadDb).live(query),
    [sourceDep, query],
  );
```

- **What you didn't have to write**: a WebSocket server, pub/sub channels, fan-out per tenant, "which clients care about this row" logic, reconnect + resubscribe, polling, cache invalidation. `README.md:105-107`: "There is no refetch code anywhere in the app."
- **Screenshot moment**: two browser windows side by side, a card mid-move in one and already moved in the other; the header pill reading "live · 4 ticks".

### F13 — Comments

- **Plain English**: a per-issue thread; your name is attached automatically; you can delete your own.
- **Ramose feature**: a parameterised query (`commentsQuery(issueId)`) memoised on the id and read with `useLive`; `preset: [P.preset(Comment.author, P.principal)]` means the peer pins authorship to the caller.
- **Files**: `src/domain/queries.ts:48-53,78-82`, `src/app/components/IssueDetail.tsx:267-277,446-523`, `src/app/mutations.ts:179-196`, `src/domain/policy.ts:62-68`.
- **Excerpt** — `src/domain/queries.ts:78-82`:

```ts
export const commentsQuery = (issueId: number) =>
  Ramose.query(Comment)
    .where(Comment.issue.eq(issueId))
    .orderBy(Comment.at, "asc")
    .select(commentShape);
```

- **What you didn't have to write**: `GET/POST /issues/:id/comments`, author stamping on the server, live refresh of the thread.
- **Screenshot moment**: comment thread with two authors, the composer with the "⌘ + ↵ to send" hint.

### F14 — Invite / roles (admin / member / viewer)

- **Plain English**: an admin invites a teammate by email as admin, member or viewer; the invitee accepts from their workspace screen.
- **Ramose feature**: the role lives in Better Auth's org tables; `@ramose/better-auth`'s `orgClassOf()` maps role → `ramose.class` at mint time (`owner|admin → admin`, `member → member`, else `viewer`); the compiled policy is what enforces the class.
- **Files**: `src/domain/roles.ts` (custom `viewer` role with no permissions), `src/app/screens/BoardScreen.tsx:597-669` (InviteDialog), `src/app/screens/WorkspacesScreen.tsx:223-237,271-308` (accept), `src/app/auth.ts:81-100`, `packages/better-auth/src/index.ts:224-268` (`classOfRole`, `orgClassOf`).
- **Excerpt** — `src/domain/roles.ts:18-29`:

```ts
export const ac = createAccessControl(defaultStatements);

export const roles = {
  owner: ac.newRole(ownerAc.statements),
  admin: ac.newRole(adminAc.statements),
  member: ac.newRole(memberAc.statements),
  viewer: ac.newRole({}),
};

/** The roles the invite dialog offers (creators are `owner` automatically). */
export const INVITABLE_ROLES = ["admin", "member", "viewer"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];
```

- **Excerpt** — `packages/better-auth/src/index.ts:224-235`:

```ts
export const classOfRole = (role: string): "admin" | "member" | "viewer" => {
  const primary = role.split(",")[0]?.trim() ?? role;
  switch (primary) {
    case "owner":
    case "admin":
      return "admin";
    case "member":
      return "member";
    default:
      return "viewer";
  }
};
```

- **What you didn't have to write**: invitation tables and endpoints (Better Auth org plugin), the JWT claim plumbing, per-request "look up this user's role for this tenant" in your data API.
- **Screenshot moment**: the Invite dialog with the role select open ("viewer — read-only by policy"); the invitee's "Invitations" card ("invited as viewer · Accept & open").

### F15 — Permission enforcement (server-side; refused writes)

- **Plain English**: viewers cannot write anything; members can create issues/comments and edit or delete only their own; admins can do everything. The buttons are merely polite — if you force a write the server refuses it and you see a toast.
- **Ramose feature**: `Ramose.Policy.policy(Reef, {...})` compiled to JSON and set as `RAMOSE_POLICY` on the peer; every transaction is checked datom-by-datom (`checkTx`), and a denial comes back as `Unauthorized` with message `${op} denied on ${attr}` (`packages/worker/src/auth.ts:334`). Deny is the default. `useTransact({ onError })` turns that into a toast.
- **Files**: `src/domain/policy.ts` (whole file), `src/app/screens/BoardScreen.tsx:241-245`, `src/app/components/IssueDetail.tsx:246-248`, `src/app/components/Board.tsx:183-187`, `test/policy.test.ts:50-63`.
- **Excerpt** — `src/domain/policy.ts:26-32`:

```ts
const anyone = P.or(P.class("admin"), P.class("member"), P.class("viewer"));
const editor = P.or(P.class("admin"), P.class("member"));
const admin = P.class("admin");

/** `member` may touch an issue they created; `admin` never reaches the rules. */
const ownIssue = P.and(P.class("member"), P.eq(Issue.creator, P.principal));
const ownComment = P.and(P.class("member"), P.eq(Comment.author, P.principal));
```

- **Excerpt** — `src/app/screens/BoardScreen.tsx:241-245`:

```ts
  // Every write is one `run(...)`; a policy denial (or any DbError) becomes
  // a toast — enforcement is server-side, the UI is only a hint.
  const { run } = useTransact({
    onError: (error) => toast("error", errorMessage(error)),
  });
```

- **Excerpt** — `src/app/components/Board.tsx:181-187` (why drags stay enabled for viewers):

```ts
  /** Time travel: the past is not editable (and drags would be lies). */
  readOnly: boolean;
  /**
   * Viewers get a polite UI (no "+" buttons) but drags stay enabled on
   * purpose: the proof of enforcement is the peer's `Unauthorized` toast.
   */
  canCreate: boolean;
```

- **Excerpt** — package mechanism, `packages/worker/src/auth.ts:332-335`:

```ts
  const p = await withEid(st.policy, principal, db);
  const res = await checkTx(tx as TxData, db, st.policy, p);
  if (!res.ok) throw new Unauthorized({ status: 403, message: `${res.op} denied on ${res.attr}`, code: res.code, attr: res.attr });
  return { kind: "send", tx: res.ops, principal: p };
```

- **What you didn't have to write**: authorization middleware, per-endpoint role checks, row-level ownership checks in every handler, an "is this my issue?" query before each update.
- **Screenshot moment**: viewer drags a card → red toast "retract denied on :issue/status" while the card snaps back; header badge reads `viewer`.

### F16 — Masked field (admin note)

- **Plain English**: the "Admin note" is visible only to admins; members and viewers never even receive it, and their attempt to write it is refused.
- **Ramose feature**: a per-attribute `read` rule (`P.attr(Issue.privateNote, { read: P.allow(admin) })`) that narrows the namespace read — the peer redacts the datom itself. Pull shapes must ask for it as `.optional`; asking for it as required is a *compile-time* error (`Ramose.Policy.compile(policy, { pulls: allShapes })`), checked in `test/policy.test.ts:65-70`.
- **Files**: `src/domain/policy.ts:56-60,72-77`, `src/domain/queries.ts:40-46,55-62`, `src/app/components/IssueDetail.tsx:417-444`, `test/policy.test.ts:39-48,65-76`.
- **Excerpt** — `src/domain/queries.ts:40-46`:

```ts
export const issueExtraShape = {
  title: Issue.title,
  description: Issue.description.optional,
  // Read-masked for member/viewer (policy.ts): must be `.optional`, so for
  // them the row survives and the field is simply absent.
  privateNote: Issue.privateNote.optional,
} as const;
```

- **Excerpt** — `test/policy.test.ts:65-70`:

```ts
  test("a masked attribute pulled as required is a compile error", () => {
    const badShape = { note: Issue.privateNote };
    expect(() =>
      Ramose.Policy.compile(policy, { pulls: [...allShapes, badShape] }),
    ).toThrow(/privateNote/);
  });
```

- **Excerpt** — `src/app/components/IssueDetail.tsx:417-422`:

```tsx
        <div>
          <div {...stylex.props(styles.sectionLabel)}>
            <Icon name="lock" size={12} />
            Admin note
            {cls !== "admin" && <Tag tone="warn">masked for {cls}</Tag>}
          </div>
```

- **What you didn't have to write**: field-level serializers per role, "strip this column for non-admins" in every read path, a second DTO.
- **Screenshot moment**: the panel as admin (note filled in) next to the same panel as member ("masked for member" tag, empty textarea).

### F17 — Time travel slider (asOf)

- **Plain English**: drag a slider back in time and watch the board become what it was after transaction *t*. Nothing was copied or snapshotted.
- **Ramose feature**: `db.asOf(t)` is a pure read-only view; the same `boardQuery` runs against it via `useQuery(db.asOf(t), boardQuery)`; `useBasis(db)` gives the slider's ceiling (current `t`) and updates as the basis moves.
- **Files**: `src/app/screens/BoardScreen.tsx:432-490`, `src/app/components/TimeTravel.tsx:98-148`.
- **Excerpt** — `src/app/screens/BoardScreen.tsx:448-460`:

```ts
  const maxT = useBasis(db);
  const [scrubbed, setScrubbed] = useState<number | null>(null);
  const t = scrubbed ?? maxT;
  // Until the basis lands, read the live view — the same rows the board
  // already shows — so the hook order never varies.
  const past = useQuery(t === undefined ? db : db.asOf(t), boardQuery);
  const everything = useQuery(db.history, everyIssueEverQuery);

  if (t === undefined || maxT === undefined) {
    return <Loading text="reading basis…" />;
  }
  const live = new Set(liveRows.map((r) => r.id));
  const deleted = (everything.data ?? []).filter((r) => !live.has(r.id));
```

- **Excerpt** — `src/app/components/TimeTravel.tsx:115-131`:

```tsx
    <div {...stylex.props(styles.sliderWrap)}>
      <span {...stylex.props(styles.bound)}>t=1</span>
      <input
        type="range"
        min={1}
        max={maxT}
        value={t}
        aria-label="Basis transaction"
        onChange={(e) => onScrub(Number(e.target.value))}
        {...stylex.props(styles.slider)}
      />
      <span {...stylex.props(styles.bound)}>t={maxT}</span>
    </div>
    <span {...stylex.props(styles.t)}>
      db.asOf(<strong>{t}</strong>)
      <span {...stylex.props(styles.tDim)}> / {maxT}</span>
    </span>
```

- **What you didn't have to write**: audit tables, `updated_at` history rows, snapshot jobs, "as of" query variants for every endpoint.
- **Screenshot moment**: the blue Time travel bar with the slider mid-way (`db.asOf(7) / 23`), the "Read-only view as of transaction 7" notice, and a visibly sparser board.

### F18 — History / deleted issues

- **Plain English**: issues you deleted are still listed (struck through) — the past is not erased.
- **Ramose feature**: `db.history` — a view that includes retracted facts; the same query type runs over it (`everyIssueEverQuery`); "deleted" = in history but not in the live rows.
- **Files**: `src/domain/queries.ts:84-88`, `BoardScreen.tsx:454,459-460`, `TimeTravel.tsx:135-146`.
- **Excerpt** — `src/domain/queries.ts:84-88`:

```ts
/** Over `db.history` this also returns issues that no longer exist. */
export const everyIssueEverQuery = Ramose.query(Issue).select({
  id: Issue.id,
  title: Issue.title,
});
```

- **What you didn't have to write**: soft-delete columns, `deleted_at` filters in every query, an audit log.
- **Screenshot moment**: "Deleted, still in history:" strip with two struck-through titles.

### F19 — Delete issue / comment

- **Ramose feature**: `tx.retractEntity(id)` — retracts every fact about the entity; the policy op is `retractEntity` (member: own only).
- **Files**: `src/app/mutations.ts:174-177,193-196`, `IssueDetail.tsx:293-298,472-480`. Note `BoardScreen.tsx:268-270`: the panel closes itself when its issue disappears from the live rows.
- **What you didn't have to write**: `DELETE` handlers, cascading deletes for comments/labels join rows.

### F20 — Sample data

- **Ramose feature**: nine issues + labels + assignments in one `db.transact` (`seedSampleIssues`, `mutations.ts:276-303`); shows atomic multi-entity writes.
- **Screenshot moment**: the empty-state card ("This board is empty … nine issues in one `db.transact`") and the board one click later.

### F21 — Dark / light theme

- Not a Ramose feature. StyleX `defineVars` (`src/app/theme/tokens.stylex.ts`) + `createTheme` (`themes.stylex.ts`), class applied to `<html>` so portaled dialogs/toasts inherit; persisted in `localStorage` (`App.tsx:49-62,90-100`).
- **Screenshot moment**: same board in both themes.

### F22 — Deploy / infra: the whole backend

- **Plain English**: one file declares the peer, the auth Worker and (in dev) the Vite server; `bun alchemy dev` runs it all locally, `bun alchemy deploy` ships it.
- **Ramose feature**: `Ramose.Server` over a `Cloudflare.Worker` whose `main` is `@ramose/worker`; `Ramose.authEnv({ policy, auth })` sets `RAMOSE_POLICY`, `RAMOSE_JWT_ISS/AUD/MAX_TTL` and mints the Worker→DO secret; `RAMOSE_JWKS_URL` is an `Output.interpolate` over the auth Worker's URL.
- **Files**: `src/infra/resources.ts:37-74`, `alchemy.run.ts:49-93`.
- **Excerpt** — `src/infra/resources.ts:37-66`:

```ts
const Store = Cloudflare.R2.Bucket("Store");
const Transactor = Cloudflare.DurableObject("TransactorDO", { className: "TransactorDO" });
const Replica = Cloudflare.DurableObject("QueryReplicaDO", { className: "QueryReplicaDO" });

export const RamoseWorker = Cloudflare.Worker("Peer", {
  main: "./packages/worker/src/index.ts",
  compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
  dev: { port: DEV_PEER_PORT },
  env: {
    STORE: Store,
    TRANSACTOR: Transactor,
    REPLICA: Replica,
    ...Ramose.authEnv({
      policy: compiledPolicy(),
      auth: REEF_AUTH,
      internalSecret: process.env.RAMOSE_INTERNAL_SECRET,
    }),
    // Yielding the Api declaration registers (or reuses) the Worker in the
    // stack and hands back the resource whose attributes are Outputs — the
    // interpolation is then resolved by the engine at reconcile.
    [Ramose.AUTH_ENV_KEYS.jwksUrl]: Effect.map(
      Api,
      (api) => Output.interpolate`${api.url}${AUTH_BASE_PATH}/jwks`,
    ),
    [Ramose.AUTH_ENV_KEYS.allowedOrigins]: Effect.map(
      Api,
      (api) => Output.interpolate`${DEV_UI_ORIGIN},${api.url}`,
    ),
  },
});
```

- **What you didn't have to write**: the peer Worker itself (it's `@ramose/worker`), any Durable Object code, R2 layout, wrangler.toml, a docker-compose for local dev, per-tenant infrastructure.
- **Screenshot moment**: (code, not UI) `resources.ts` next to a terminal showing `bun run dev:reef` bringing up `:1337`, `:1338`, `:5173`.

---

## 3. The pieces, verbatim, and how they connect

### 3.1 The schema — `src/domain/schema.ts` (76 lines, complete)

```ts
/**
 * Reef — the catalog one workspace runs on.
 *
 * Every workspace is its own Ramose database (`ramose.db(slug, Reef)`), so
 * this catalog is installed once per workspace at creation time, from the
 * browser, under the creator's admin-class JWT. Refs are targeted
 * (`Ramose.Ref(() => User)`) so navigational queries can join through them
 * (`Issue.assignee.name`).
 */

import * as Ramose from "@ramose/alchemy/db";
import * as Schema from "effect/Schema";

/** One row per human who has entered the workspace. `sub` is the JWT subject. */
export const User = Ramose.Namespace("user", {
  sub: Ramose.Attr(Schema.String, {
    unique: "identity",
    doc: "Better Auth user id — the JWT `sub`; the policy resolves principals through it",
  }),
  name: Ramose.Attr(Schema.String),
  email: Ramose.Attr(Schema.String),
});

export const Label = Ramose.Namespace("label", {
  name: Ramose.Attr(Schema.String, { unique: "identity" }),
  color: Ramose.Attr(Schema.String),
});

export const Issue = Ramose.Namespace("issue", {
  title: Ramose.Attr(Schema.String),
  description: Ramose.Attr(Schema.String),
  /** One of {@link STATUSES}. */
  status: Ramose.Attr(Schema.String),
  /** 0 none · 1 low · 2 medium · 3 high · 4 urgent. */
  priority: Ramose.Attr(Ramose.Long),
  /** Fractional order inside a column; drag-and-drop writes midpoints. */
  rank: Ramose.Attr(Schema.Number),
  createdAt: Ramose.Attr(Ramose.Instant),
  creator: Ramose.Attr(Ramose.Ref(() => User)),
  assignee: Ramose.Attr(Ramose.Ref(() => User)),
  labels: Ramose.Attr(Ramose.Ref(() => Label), { cardinality: "many" }),
  /** Admin-only field — the policy narrows its `read` (see policy.ts). */
  privateNote: Ramose.Attr(Schema.String, {
    doc: "visible to the admin class only",
  }),
});

export const Comment = Ramose.Namespace("comment", {
  body: Ramose.Attr(Schema.String),
  at: Ramose.Attr(Ramose.Instant),
  author: Ramose.Attr(Ramose.Ref(() => User)),
  issue: Ramose.Attr(Ramose.Ref(() => Issue)),
});

export const Reef = Ramose.Catalog({
  user: User,
  label: Label,
  issue: Issue,
  comment: Comment,
});

export type Reef = typeof Reef;

// ── shared vocabulary ────────────────────────────────────────────────────────

export const STATUSES = ["backlog", "todo", "doing", "done"] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  doing: "In Progress",
  done: "Done",
};

export const PRIORITIES = ["No priority", "Low", "Medium", "High", "Urgent"] as const;
```

**Plain-English gloss, per attribute** (wire name in parentheses — every attribute becomes `:namespace/name`):

| attribute | gloss |
|---|---|
| `user.sub` (`:user/sub`) | The account id from the login system (the JWT's `sub`). `unique: "identity"` = one row per person, and you can look a user up by it. The policy uses it to answer "who is calling?". |
| `user.name`, `user.email` | Display name and email, copied in on first entry. |
| `label.name` (`unique: "identity"`), `label.color` | A label is a name + a hex color; names are unique per workspace. |
| `issue.title`, `issue.description` | Free text. Description is optional (simply absent when empty — see `setDescription`). |
| `issue.status` | One of `backlog / todo / doing / done` (a plain string; the app owns the vocabulary). |
| `issue.priority` (`Ramose.Long`) | An integer 0–4. |
| `issue.rank` (`Schema.Number`) | A double giving the position within a column; drags write midpoints. |
| `issue.createdAt` (`Ramose.Instant`) | A timestamp (JS `Date` in and out). |
| `issue.creator` → `user` | Who opened it. A **reference** to a `user` entity (a typed foreign key). The policy *presets* it to the caller. |
| `issue.assignee` → `user` | Who it's assigned to; optional. |
| `issue.labels` → `label`, `cardinality: "many"` | A *set* of label references — no join table. |
| `issue.privateNote` | Admin-only text; the policy narrows who can read it. |
| `comment.body`, `comment.at` | Text and timestamp. |
| `comment.author` → `user` | Preset to the caller by policy. |
| `comment.issue` → `issue` | Which issue the comment belongs to. |
| `Reef = Catalog({...})` | The whole schema as one value: passed to `ramose.db(slug, Reef)` and installed per workspace with `db.install()`. |

Every namespace also gets an implicit `id` (`User.id`, `Issue.id`…) used in `select` shapes.

### 3.2 The policy — `src/domain/policy.ts` (77 lines, complete)

```ts
/**
 * The workspace policy (docs/AUTH_LAYER.md): rules over catalog attributes and
 * JWT claims, compiled at deploy into the peer Worker's env. One policy serves
 * every workspace — the JWT's `ramose.db` binds a token to one of them.
 *
 * Classes (carried as `ramose.class`, minted from the Better Auth org role):
 *
 *   admin   workspace owners/admins — bypasses every rule (core `isAdmin`),
 *           which is also what lets the creator run `db.install()` and read
 *           `issue.privateNote`
 *   member  can create issues/comments and edit or delete *their own*
 *   viewer  read-only; every write arm denies it
 *
 * Deny is the default: a namespace without a rule denies, and `preset`
 * attributes are peer-owned on create — a client-supplied value is allowed
 * only when identical, so a member can never forge `issue.creator`.
 */

import * as Ramose from "@ramose/alchemy";
import { allShapes } from "./queries.ts";
import { Comment, Issue, Reef, User } from "./schema.ts";
import { CLASSES } from "./shared.ts";

const P = Ramose.Policy;

const anyone = P.or(P.class("admin"), P.class("member"), P.class("viewer"));
const editor = P.or(P.class("admin"), P.class("member"));
const admin = P.class("admin");

/** `member` may touch an issue they created; `admin` never reaches the rules. */
const ownIssue = P.and(P.class("member"), P.eq(Issue.creator, P.principal));
const ownComment = P.and(P.class("member"), P.eq(Comment.author, P.principal));

export const policy = P.policy(Reef, {
  principal: User.sub,
  classes: CLASSES,
  ns: {
    user: {
      read: P.allow(anyone),
      // First entry into a workspace writes your own row; `sub` is preset from
      // the token, so you cannot register as someone else.
      create: P.allow(editor),
      preset: [P.preset(User.sub, P.claims.sub)],
    },
    label: {
      read: P.allow(anyone),
      create: P.allow(editor),
    },
    issue: {
      read: P.allow(anyone),
      create: P.allow(editor),
      add: P.allow(ownIssue),
      retract: P.allow(ownIssue),
      retractEntity: P.allow(ownIssue),
      preset: [P.preset(Issue.creator, P.principal)],
      attrs: [
        // Narrows the namespace `read`: members and viewers never see this
        // datom — pulls must ask for it as `.optional` (compile() checks).
        P.attr(Issue.privateNote, { read: P.allow(admin) }),
      ],
    },
    comment: {
      read: P.allow(anyone),
      create: P.allow(editor),
      retract: P.allow(ownComment),
      retractEntity: P.allow(ownComment),
      preset: [P.preset(Comment.author, P.principal)],
    },
  },
});

/**
 * The wire JSON for `RAMOSE_POLICY`. Compiling against the app's pull shapes
 * makes "a masked attribute pulled as required" a deploy-time error.
 */
export const compiledPolicy = (): string =>
  P.compile(policy, { pulls: allShapes });
```

**Plain-English gloss, per rule:**

| rule | gloss |
|---|---|
| `principal: User.sub` | "Who is calling" is the `user` row whose `sub` equals the token's `sub`. So `P.principal` in any rule means *my user entity*. |
| `classes: CLASSES` (`["admin","member","viewer"]`) | The three roles a token can carry (`ramose.class`). A token with any other class fails at mint. |
| `anyone / editor / admin` | Helper expressions: any of the three; admin-or-member; admin only. |
| `ownIssue` | "I am a member AND this issue's `creator` is me." Admins never reach rules — they bypass everything. |
| `user.read: anyone` | Everyone can see the people list. |
| `user.create: editor` + `preset(User.sub, claims.sub)` | Members/admins may create their own `user` row on first entry; the server fills `sub` from the token, and if you supply a *different* sub the write is refused. You cannot register as someone else. |
| `label.read: anyone`, `label.create: editor` | Anyone reads labels; editors may add labels (there is no UI for it, but the seed does it). Nobody but admin can change/delete a label (no `add`/`retract` arm → deny). |
| `issue.read: anyone` | Everyone (including viewers) sees issues… |
| `issue.attrs: privateNote read: admin` | …except `privateNote`, which only admins receive; the peer strips that one datom for everyone else. |
| `issue.create: editor` | Members/admins can open issues. |
| `issue.add / retract / retractEntity: ownIssue` | Members can change, un-set, or delete only issues they created; viewers never; admins always. (Moving a card = `add` status + `add` rank; a card-one `add` implies a `retract` of the old value, so the first denied op is `retract denied on :issue/status`.) |
| `issue.preset: creator = principal` | The server stamps `creator` to the caller on create. |
| `comment.*` | Same shape: anyone reads, editors create, members retract/delete their own, author is preset. |
| `compiledPolicy()` | Turns the policy into the JSON the peer loads (`RAMOSE_POLICY`), and — because it's passed the app's pull shapes — refuses to compile if any shape pulls `privateNote` as required. |
| (implicit) | Anything not mentioned is denied: there is no `add`/`retract` arm on `user` or `label`, so members cannot rename users or recolor labels. |

### 3.3 The queries — `src/domain/queries.ts` (95 lines, complete)

```ts
/**
 * Every read the app asks, as hoisted navigational query values — stable
 * dependencies for `useLive`, runnable one-shot (`db.q`), live (`db.live`) or
 * in the past (`db.asOf(t).q`) unchanged. The pull shapes are also fed to
 * `Ramose.Policy.compile({ pulls })` so a read-masked attribute pulled as
 * required is a deploy-time error, not a silently dropped row.
 */

import type { Db } from "@ramose/alchemy/db";
import * as Ramose from "@ramose/alchemy/db";
import { Comment, Issue, Label, Reef, User } from "./schema.ts";

export type ReefDb = Db<typeof Reef>;

// ── shapes ───────────────────────────────────────────────────────────────────

export const personShape = { id: User.id, name: User.name } as const;
export const labelShape = {
  id: Label.id,
  name: Label.name,
  color: Label.color,
} as const;

export const boardShape = {
  id: Issue.id,
  title: Issue.title,
  status: Issue.status,
  priority: Issue.priority,
  rank: Issue.rank,
  createdAt: Issue.createdAt,
  creator: Issue.creator.select(personShape),
  assignee: Issue.assignee.select(personShape).optional,
  labels: Issue.labels.select(labelShape),
} as const;

/**
 * What the detail panel `db.pull`s on top of its live board row (the row
 * already carries status/priority/assignee/labels/creator).
 */
export const issueExtraShape = {
  title: Issue.title,
  description: Issue.description.optional,
  // Read-masked for member/viewer (policy.ts): must be `.optional`, so for
  // them the row survives and the field is simply absent.
  privateNote: Issue.privateNote.optional,
} as const;

export const commentShape = {
  id: Comment.id,
  body: Comment.body,
  at: Comment.at,
  author: Comment.author.select(personShape),
} as const;

/** Everything `compile({ pulls })` should vet. */
export const allShapes: readonly unknown[] = [
  boardShape,
  issueExtraShape,
  commentShape,
  personShape,
  labelShape,
];

// ── queries ──────────────────────────────────────────────────────────────────

export const boardQuery = Ramose.query(Issue)
  .orderBy(Issue.rank, "asc")
  .select(boardShape);

export const peopleQuery = Ramose.query(User)
  .orderBy(User.name, "asc")
  .select({ id: User.id, name: User.name, email: User.email });

export const labelsQuery = Ramose.query(Label)
  .orderBy(Label.name, "asc")
  .select(labelShape);

export const commentsQuery = (issueId: number) =>
  Ramose.query(Comment)
    .where(Comment.issue.eq(issueId))
    .orderBy(Comment.at, "asc")
    .select(commentShape);

/** Over `db.history` this also returns issues that no longer exist. */
export const everyIssueEverQuery = Ramose.query(Issue).select({
  id: Issue.id,
  title: Issue.title,
});

/** One row of {@link boardQuery} — inferred from the query, never restated. */
export type BoardRow = Ramose.Row<typeof boardQuery>;

export type Person = BoardRow["creator"];
export type LabelRow = Ramose.Row<typeof labelsQuery>;
export type CommentRow = Ramose.Row<ReturnType<typeof commentsQuery>>;
```

Plain English: a *shape* says which fields you want back (and follows references: `Issue.assignee.select(personShape)` gives you `{ id, name }` of the assignee inline). A *query* says which namespace, optional `where`, `orderBy`, and the shape. Queries are plain values built once at module scope; the same value runs one-shot, live, or against the past. Row types (`BoardRow`) are inferred, never hand-written.

### 3.4 Mutations — `src/app/mutations.ts` key excerpts

Already shown above: `provisionWorkspace` (28-45), `createIssue` (87-110), `moveIssue` (113-122), `setDescription` (135-139), `toggleLabel` (156-165). Two more that matter:

`src/app/mutations.ts:55-75` — first entry writes your own `user` row (and shows `dbAfter` reading your own write):

```ts
export const ensureSelf = (
  db: ReefDb,
  me: { id: string; name: string; email: string },
  canWrite: boolean,
) =>
  Effect.gen(function* () {
    const mineQuery = Ramose.query(User)
      .where(User.sub.eq(me.id))
      .select({ id: User.id });
    const existing = yield* db.q(mineQuery);
    if (existing.length > 0) return existing[0]!.id;
    if (!canWrite) return undefined;
    const report = yield* db.transact(function* (tx) {
      const user = yield* tx.entity();
      yield* user.add(User.sub, me.id);
      yield* user.add(User.name, me.name);
      yield* user.add(User.email, me.email);
    });
    const after = yield* report.dbAfter.q(mineQuery);
    return after[0]?.id;
  });
```

`src/app/mutations.ts:167-177` — admin-only write and delete:

```ts
/** Admin-only by policy: everyone else gets `Unauthorized` from the peer. */
export const setPrivateNote = (db: ReefDb, issueId: number, note: string) =>
  db.transact(function* (tx) {
    if (note === "") yield* tx.retract(issueId, Issue.privateNote);
    else yield* tx.add(issueId, Issue.privateNote, note);
  });

export const deleteIssue = (db: ReefDb, issueId: number) =>
  db.transact(function* (tx) {
    yield* tx.retractEntity(issueId);
  });
```

Note the file's own framing (`mutations.ts:1-6`): "Every write the app makes. Each is one `db.transact` generator — the whole body commits atomically or the peer's policy rejects it with `Unauthorized`, which the UI surfaces as a toast (enforcement is server-side; the buttons are merely polite)."

### 3.5 React wiring — key excerpts

`src/app/auth.ts:12-18` (Better Auth client with the Ramose mint plugin):

```ts
export const authClient = createAuthClient({
  baseURL: `${window.location.origin}${AUTH_BASE_PATH}`,
  // `ramoseTokenClient` pairs with the server's `ramoseToken` plugin:
  // `authClient.ramose.token({ db })` resolves the mint route's body,
  // which `Ramose.token.jwt` accepts unchanged (app/ramose.ts).
  plugins: [organizationClient({ ac, roles }), ramoseTokenClient()],
});
```

`src/app/ramose.ts:16-26`:

```ts
export const RAMOSE_URL =
  import.meta.env.VITE_RAMOSE_URL ?? "http://localhost:1337";

export interface Workspace {
  readonly slug: string;
  readonly cls: RamoseClass;
  /** Stable for the workspace's lifetime — `RamoseProvider` keys its client on it. */
  readonly token: Ramose.TokenSource;
  /** The caller's `user` eid in this workspace (`undefined` for viewers). */
  readonly myEid: number | undefined;
}
```

`src/app/App.tsx:119-137` (session gate + entering a workspace):

```tsx
const Root = () => {
  const session = authClient.useSession();
  const toast = useToast();
  const [open, setOpen] = useState<Open | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const enter = useCallback(
    async (slug: string, name: string, user: SessionUser, provision = false) => {
      setOpening(slug);
      try {
        setOpen({ workspace: await openWorkspace(slug, user, provision), name });
      } catch (err) {
        toast("error", errorMessage(err));
      } finally {
        setOpening(null);
      }
    },
    [toast],
  );
```

Hooks used, and where (all from `@ramose/react`, `packages/react/src/index.ts:18-25`):

| hook | used at | what it gives |
|---|---|---|
| `RamoseProvider` | `App.tsx:146-157` | owns the `Client` (`Ramose.connect`) for the open workspace; `key={slug}` remounts per tenant |
| `useDb(slug, Reef)` | `BoardScreen.tsx:230` | the typed `Db` for this workspace |
| `useLive(db, query)` | `BoardScreen.tsx:232-234`, `IssueDetail.tsx:267-270` | `{ rows, error, ticks }` standing query |
| `usePull(db, { id }, shape)` | `IssueDetail.tsx:258` | standing single-entity projection |
| `useTransact({ onError })` | `BoardScreen.tsx:243-245`, `IssueDetail.tsx:246-248` | `run(effect)` for writes; failures → toast |
| `useQuery(view, query)` | `BoardScreen.tsx:453-454` | one-shot read (used with `db.asOf(t)` and `db.history`) |
| `useBasis(db)` | `BoardScreen.tsx:448` | current transaction number (slider ceiling) |
| `errorMessage` | `App.tsx:131`, `BoardScreen.tsx:244`, `IssueDetail.tsx:247` | error → toast text |

### 3.6 End-to-end: "drag an issue to Done"

1. **UI event** — `Board.tsx:297-301`: `onDrop` on a card (or `:230-233` on the column) calls `drop(status, row)`; `drop` (`:196-209`) filters the target column, computes `rank` with `rankAfter`/`rankBetween` (`rank.ts`), and calls `onMove(dragId, "done", rank)`.
2. **Mutation** — `BoardScreen.tsx:346-348`: `onMove={(id, status, rank) => void run(moveIssue(db, id, status, rank))}`. `moveIssue` (`mutations.ts:113-122`) is `db.transact(function* (tx) { yield* tx.add(id, Issue.status, "done"); yield* tx.add(id, Issue.rank, rank); })` — an Effect value, not yet run.
3. **run** — `useTransact().run` (`packages/react/src/useTransact.ts:76-91`) does `Effect.runPromiseExit(effect)`; the transact is a `POST /db/coral-team/transact` over HTTPS with the current JWT (re-read from `Ramose.token.jwt`; re-minted if within 2 minutes of `exp`).
4. **Policy check on the peer** — the peer verifies the JWT against the auth Worker's JWKS (`RAMOSE_JWKS_URL`), resolves the principal (`sub → user eid`, class from `ramose.class`), and runs `checkTx` (`packages/core/src/policy/check.ts:60-`) against `RAMOSE_POLICY`: `add` on `:issue/status` for a member requires `ownIssue` (`P.eq(Issue.creator, P.principal)`); an admin bypasses; a viewer has no arm → `Unauthorized("retract denied on :issue/status")` (`packages/worker/src/auth.ts:334`). Then the Transactor DO applies the two datoms (plus the implied retracts of the old values) and the basis `t` advances.
5. **Failure path** — `run` sees a failed `Exit`, calls `onError` → `toast("error", errorMessage(error))` (`BoardScreen.tsx:243-245`). The board never moved locally, so nothing to roll back.
6. **Success path, this tab** — `db.live` re-runs after a local `transact` (`Db.ts` `live` contract: "re-run on every basis tick this session sees, and after a local `transact`"), the new rows are emitted, `useLive` sets state, `Board` re-renders with the card in Done.
7. **Every other tab / user** — each open board holds a session WebSocket to `/db/coral-team/session`; the peer's per-session poll notices the basis moved (≈1 s, `DEFAULT_POLL_INTERVAL_MS = 1_000`, `packages/worker/src/session.ts:105`) and sends `{ op: "t", t }`; the client session `bump`s (`packages/alchemy/src/db/session.ts:211`), every standing `live`/`livePull` on that db re-runs; identical results are not re-emitted, changed ones are. `useLive.ticks` increments → the header pill pulses (`BoardScreen.tsx:291-305`), the board re-renders. Nothing in the app subscribed to anything, and no fetch was written.
8. **Later** — Time travel: `useQuery(db.asOf(t), boardQuery)` with a `t` before step 4 shows the card in its old column; the same `boardQuery` value is used unchanged.

---

## 4. Line-count facts (`wc -l`, exact)

Raw `wc -l` (includes comments and blank lines):

| bucket | files | lines |
|---|---|---|
| `src/domain` | schema 76 · policy 77 · queries 95 · rank 30 · roles 29 · shared 67 | **374** |
| `src/infra` | api 139 · resources 74 | **213** |
| `alchemy.run.ts` | | **93** |
| **backend = domain + infra + alchemy.run.ts** | | **680** |
| `src/app` (all) | App 168 · auth 100 · Board 331 · IssueDetail 528 · TimeTravel 148 · index.css 34 · main 10 · mutations 303 · ramose 51 · AuthScreen 252 · BoardScreen 669 · WorkspacesScreen 413 · themes 33 · tokens 74 · ui 906 | **4020** |
| `src/app` minus `ui.tsx` + `theme/` + `index.css` (design-system chrome) | | **2973** |
| `test/` | policy.test 103 · rank.test 50 | **153** |
| whole `src/` | | **4607** |
| everything (README + alchemy.run + vite.config + src + test) | | **4990** |

Non-blank, non-comment lines (`grep -vE '^\s*$|^\s*(//|/\*|\*|\*/)'`):

| bucket | lines |
|---|---|
| `src/domain` | **208** (schema 50 · policy 45 · queries 61 · rank 14 · roles 16 · shared 22) |
| `src/infra` | **119** (api 80 · resources 39) |
| `alchemy.run.ts` | **47** |
| **backend = domain + infra + alchemy.run.ts** | **374** |
| schema + policy + queries only | **156** |
| `src/app` (all) | 3647 |
| app data-plane glue (`mutations.ts` + `ramose.ts` + `auth.ts` + `App.tsx`) | 495 |
| StyleX styling blocks inside `src/app` (`stylex.create/keyframes/defineVars/createTheme`) | ≈1291 |

Headline facts to quote:

- The entire backend of a realtime, multi-tenant, role-based issue tracker — schema, policy, queries, deploy, auth Worker — is **680 lines** (`374` without comments/blanks). Of that, the auth Worker (Better Auth config) is 139 lines; the Ramose peer declaration is 74; the schema is 76; the policy is 77; the queries are 95.
- The **data model + access rules + every read** (`schema.ts` + `policy.ts` + `queries.ts`) is **248 lines** raw / **156** code lines.
- **Backend : UI ratio** — 680 : 4020 (about 1 : 6). Roughly a third of the UI (≈1291 lines) is StyleX design-system styling; `ui.tsx` alone (icons, buttons, dialogs, toasts) is 906 lines.
- **Zero** lines of: WebSocket server, REST endpoints for issues/comments/labels, migrations, ORM models, authorization middleware, per-tenant provisioning, refetch/invalidation code. Search proof: `grep -rn "fetch(" examples/reef/src` finds only Better Auth's `$fetch` wrappers in `auth.ts`; the data plane has no fetch calls.

---

## 5. Rough edges (for writers and the screenshot agent)

**Ramose/Datomic-flavored wording visible in the UI** — fine for a dev audience but worth knowing before framing screenshots as "just an app":

- Header pill title text: "Every board update is a basis tick pushed by the peer over db.live" (`BoardScreen.tsx:289`), and the pill reads "live · N ticks" (`:299-303`). "tick"/"basis" are Ramose jargon.
- Class badge in the header shows the raw class (`admin` / `member` / `viewer`) with title "your ramose.class in this workspace" (`:280-285`); the header also shows `db/<slug>` (`:279`).
- Empty board hint: "…start from a sample board — nine issues in one `db.transact`." (`:359-361`).
- Time travel: "Read-only view as of transaction {t}. Same queries, pinned basis — nothing was copied." (`:472-473`); the bar shows `db.asOf(7) / 23` and bounds `t=1` … `t=23` (`TimeTravel.tsx:116-131`); "Deleted, still in history:" (`:138`).
- Issue panel admin note: placeholder "Read-masked for your class — a write here is denied by the peer" and hint "`issue.privateNote` has a narrowed read rule — the peer redacts the datom itself for non-admins." (`IssueDetail.tsx:425-443`). "datom" and "peer" appear verbatim.
- Workspaces screen: "Every workspace is its own Ramose database — `ramose.db(slug)` — created on the spot, no deploy." (`WorkspacesScreen.tsx:265-268`), "Create one below — it is one install() and one transaction." (`:319`), and the live preview `ramose.db("coral-team").install()` (`:385`).
- Auth screen feature blurbs: "db.live streams every board." / "One database per workspace." / "db.asOf(t) — nothing copied." (`AuthScreen.tsx:130-134`).
- Invite role labels: "viewer — read-only by policy", "member — can edit issues" (`BoardScreen.tsx:649-653`).
- The denial toast is the peer's raw message: `retract denied on :issue/status` (from `packages/worker/src/auth.ts:334`), so the wire ident `:issue/status` leaks into UI. It's a good "proof" screenshot for a dev audience but reads like an error to a product audience.
- Cards show `#<eid>` (`Board.tsx:309`) — entity ids are per-database integers shared with users and labels, so issue numbers are not 1..N (users and the four seed labels take ids before the first issue) and gaps appear after deletes.

**Seed data that is meta about Ramose** (`mutations.ts:209-269`) — three of the nine sample titles talk about the demo itself: "Live board flickers when two tabs move the same card", "Time-travel slider should snap to transaction boundaries", "Rotate the JWKS signing key on a schedule", "Ship the peer to three regions", "Per-datom policy for issue.privateNote". Fine for dogfooding, bad for a "this could be your app" screenshot.

**Behavioural rough edges**:

- The description/title/note textareas commit `onBlur` (`IssueDetail.tsx:311-315,409-413,431-435`); a screenshot agent must click elsewhere (or press Enter in the title) before the write happens.
- Every control in the panel is enabled for viewers except the comment composer (`IssueDetail.tsx:496-498,513-518`); a viewer changing status via the select gets a toast, not a disabled control. Intentional (`IssueDetail.tsx:4-6`), but may look like a bug.
- Comments' delete "x" is shown to everyone; non-owners get a toast.
- Assignee/people list only contains users who have *opened* the workspace at least once as admin/member (`ensureSelf`, `mutations.ts:55-75`); a freshly invited member does not appear until they enter, and viewers never do.
- Labels can't be created/edited in the UI — only the four seeds (`bug`, `feature`, `design`, `infra`; `mutations.ts:15-20`).
- No issue search/filter, no per-user avatars beyond initials, no markdown in descriptions.
- Time travel slider starts at `t=1` where the board is empty (`install()` and the label/user seed are the first transactions; issues arrive later), so the leftmost positions all show "Nothing here at this point in time". For a good scrub screenshot, create issues over several separate transactions first.
- Sign-up defaults to the "Create account" mode; a returning user must click "Sign in".
- `Board.tsx:39-40` columns have `minWidth: 236px` / `maxWidth: 380px`; at 1280 px wide, four columns plus the 420 px panel push the board into horizontal scroll — screenshots with the panel open want ≥1440 px, or the header's `wide` elements (db slug, live pill, divider, avatar) hide under 760 px (`BoardScreen.tsx:92-94`).

**Suggested seed content for screenshots** (a fictional product team, "Coral Team", building a scheduling app called "Tidepool"; type these via the New issue dialog or, better, temporarily edit `SAMPLE_ISSUES` locally — read-only rule for me, but a screenshot agent can):

| # | title | status | priority | labels | assignee |
|---|---|---|---|---|---|
| 1 | Calendar week view drops the last event on Sundays | doing | Urgent | bug | Ada |
| 2 | Add "Suggest a time" to the invite composer | todo | High | feature | Grace |
| 3 | Redesign the empty-calendar illustration | backlog | Low | design | — |
| 4 | Google Calendar sync: handle recurring events | doing | High | feature, bug | Ada |
| 5 | Timezone picker should default to the browser zone | todo | Medium | bug | — |
| 6 | Weekly digest email | backlog | Medium | feature | Grace |
| 7 | Onboarding checklist for new workspaces | todo | Low | design, feature | Linus |
| 8 | Rate-limit the public booking page | backlog | High | infra | — |
| 9 | Move image uploads to R2 | done | Medium | infra | Linus |
| 10 | Keyboard shortcut: `c` to create an event | done | Low | feature | Grace |
| 11 | Booking page loads slowly on mobile | doing | High | bug, infra | Linus |
| 12 | Dark mode contrast pass on the settings screen | done | Low | design | Ada |

People: **Ada Lovelace** (owner/admin, `ada@example.com` — the auth screen placeholder already suggests this), **Grace Hopper** (member), **Linus Torvalds** (viewer for the enforcement shot, or member). Labels: keep the four seeds (`bug` red, `feature` blue, `design` purple, `infra` green). Workspaces: "Coral Team" (`db/coral-team`) and a second, "Deep Sea" (`db/deep-sea`), to show multi-tenancy in the picker. Comments to type on issue 1: "Repro on Safari 17 too — it's the DST boundary." (Ada) / "I can take this after the sync work lands." (Grace). Admin note on issue 4: "Customer escalation from Acme — keep it quiet until the fix ships."

---

## 6. Concepts a beginner meets in Reef code, in the order they meet them

1. **Namespace** (`Ramose.Namespace("issue", {...})`, `schema.ts:29`) — a named group of fields, like a table name; each field becomes an attribute `:issue/title`.
2. **Attr** (`Ramose.Attr(Schema.String, { unique, doc, cardinality })`, `schema.ts:16`) — one field with a type (an Effect `Schema`) and options; `unique: "identity"` = lookup key, `cardinality: "many"` = a set of values.
3. **Ramose.Long / Instant / Ref** (`schema.ts:35,38,39`) — value types: integer, timestamp (a JS `Date`), and a reference to another namespace's entity (a typed foreign key, `Ref(() => User)`).
4. **Catalog** (`Ramose.Catalog({ user, label, issue, comment })`, `schema.ts:55`) — the whole schema as one value; `Db<typeof Reef>` is typed from it.
5. **connect / db** (`Ramose.connect({ url, token })`, `ramose.db(slug, Reef)`, `ramose.ts:40-42`) — a client for the peer, and a *pure* handle to one database by name; naming a database costs nothing.
6. **install** (`db.install()`, `mutations.ts:33`) — write the catalog into a database as an ordinary, idempotent transaction; this is how a workspace is "created".
7. **transact** (`db.transact(function* (tx) {...})`, `mutations.ts:93`) — the one way to write: a generator whose body either commits atomically or fails as a whole.
8. **entity / add / retract / retractEntity** (`tx.entity()`, `issue.add(Issue.title, …)`, `tx.add(id, attr, v)`, `tx.retract(id, attr)`, `tx.retractEntity(id)`, `mutations.ts:94-95,120,137,176`) — create a new thing, set a fact, unset a fact, delete everything about a thing. A "datom" is one such fact `[entity, attribute, value]`.
9. **preset** (`P.preset(Issue.creator, P.principal)`, `policy.ts:55`) — a field the server fills in from the caller's identity on create; a client value is allowed only if identical.
10. **query / where / orderBy / select** (`Ramose.query(Comment).where(Comment.issue.eq(id)).orderBy(Comment.at, "asc").select(shape)`, `queries.ts:78-82`) — a typed read built as a value: which namespace, filter, sort, and which fields.
11. **shape / pull / `.select` through refs / `.optional`** (`boardShape`, `queries.ts:24-34`; `usePull(db, { id }, issueExtraShape)`, `IssueDetail.tsx:258`) — the fields you want back; `Issue.assignee.select(personShape)` follows the reference inline; `.optional` means "absent is fine" (required + missing → the row is `null`).
12. **Row** (`Ramose.Row<typeof boardQuery>`, `queries.ts:91`) — the TypeScript type of one result row, inferred from the query.
13. **q vs live** (`db.q(query)`, `mutations.ts:64`; `useLive(db, boardQuery)`, `BoardScreen.tsx:232`) — run once, or stand up a subscription that re-emits whenever the database changes.
14. **basis / t / ticks** (`useBasis(db)`, `BoardScreen.tsx:448`; `board.ticks`, `:267`) — every committed transaction gets a number `t`; the "basis" is the `t` you are reading at; a "tick" is the peer telling your session it moved.
15. **asOf / history** (`db.asOf(t)`, `db.history`, `BoardScreen.tsx:453-454`) — pure read-only views: the database as it was after `t`, and the database including retracted facts.
16. **dbAfter** (`report.dbAfter.q(mineQuery)`, `mutations.ts:73`) — read your own write immediately, with no second round trip.
17. **Policy / principal / class / allow / preset / attr** (`policy.ts:34-70`) — declarative rules over attributes: who (a class from the token) may `read` / `create` / `add` / `retract` / `retractEntity` which namespace or attribute; `principal` is "the caller's own entity"; deny by default; compiled to JSON for the peer.
18. **TokenSource / `Ramose.token.jwt`** (`ramose.ts:38`) — a self-refreshing credential: a function that fetches a JWT; the client re-reads it on every write and reconnect and re-mints near expiry.
19. **Unauthorized / DbError / errorMessage** (`BoardScreen.tsx:243-245`, `packages/react/src/errors.ts`) — typed failures; a policy denial is `Unauthorized` with a readable message.
20. **RamoseProvider / useDb / useLive / usePull / useQuery / useBasis / useTransact** (`@ramose/react`) — the React bindings; the provider owns one client, `useTransact().run` runs a write from an event handler.
21. **Effect generators / Effect.runPromise** (`Effect.gen(function* () { yield* db.install(); … })`, `mutations.ts:32-33`; `Effect.runPromise(...)`, `ramose.ts:43`) — Ramose's methods return `Effect` values (lazy, typed-error programs); `yield*` sequences them inside `Effect.gen`, `Effect.runPromise` runs one as a promise. Inside React you rarely see this: the hooks run them for you.
22. **Alchemy resources** (`Cloudflare.Worker`, `Cloudflare.R2.Bucket`, `Cloudflare.DurableObject`, `Ramose.Server`, `Command.Dev`, `Alchemy.Stack`, `resources.ts:37-74`, `alchemy.run.ts:49-93`) — infrastructure declared as values in one TypeScript file; `bun alchemy dev` runs it locally (miniflare), `bun alchemy deploy` ships it. `Ramose.authEnv(...)` turns the compiled policy + auth config into the peer's env vars.
23. **Better Auth + `@ramose/better-auth`** (`api.ts:75-121`, `auth.ts:12-18`) — the identity plane; the `ramoseToken` server plugin adds `POST /api/auth/ramose/token { db }` and the `ramoseTokenClient` browser plugin adds `authClient.ramose.token({ db })`; `orgClassOf()` maps org role → policy class.
