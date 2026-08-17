# Adversarial review — cycle 1

Site: `website/` (Astro 5 + Starlight 0.36), built and read at commit `a15b538`.
Build: 20 pages, 1.9 MB `dist/`, Pagefind indexes **1,693 words total** across
19 pages. Zero raster images, zero diagrams, zero screenshots, zero video.

Reader assumed: has never heard of Datomic, wants a database to vibe-code apps
with, wants permissions and typed data so they cannot silently wreck prod.

---

## 1. Inventory

### IA (sidebar, `astro.config.mjs:46-85`)

| group | pages (in order) |
| --- | --- |
| Getting started | Introduction, Quickstart |
| Concepts | Architecture, A database is a name, Time travel |
| Guides | Define a catalog, Transact, Query and pull, Live queries, Workers and tenants, Deploy with Alchemy, **Auth and policy** (7th of 7) |
| Reference | Client API, Alchemy resources, HTTP API, Errors, Configuration, Runbook |

18 doc pages + `index.mdx` landing. No Examples section, no React/framework
page, no comparison page, no FAQ, no limitations page, no changelog, no
"what Ripple is not". `examples/todos` and `examples/kv-style` exist in the
repo and are named only in running prose (`guides/workers.md:80-81`,
`guides/live-queries.md:33`). The site never links to either directory.

### Landing copy, verbatim (`src/content/docs/index.mdx`)

- Frontmatter title (`:2`): `The graph that reacts` — this is also `<title>`
  and `og:title`. Neither the word "Ripple" nor "database" is in it.
- Hero H1 (`:19`): **"The graph that reacts."**
- Subhead (`:21-25`): **"Ripple is an immutable, reactive graph database for
  Cloudflare. One Durable Object writes. Segment trees live in R2. Datalog runs
  at the edge, next to your app. Built on Effect, typed end to end."**
- CTAs (`:28-29`): **"Get started"** → `/getting-started/quickstart/`;
  **"GitHub"** → `github.com/tvanhens/ripple`. Two CTAs, no demo, no playground.
- Pseudo-terminal strip (`:32`, styled `.rg-install`, `user-select: all`):
  **"› ripple.db("acme", Catalog) // a database is a name — no provision step"**
- Section 2 (`:36-41`): H2 **"State the change."** / lede **"A change enters the
  system, travels through the field, and produces a coherent response. Write a
  row and every standing live query re-runs — no refetch, no invalidation call
  at the write site."** Then "The catalog is the schema" + catalog snippet.
- Section 3 (`:74`): **"Observe. Propagate. Resolve."** + query/transact snippet.
- Section 4 (`:106`): **"Deploy is one resource"** + Alchemy snippet.
- Section 5 (`:136-137`): H2 **"Why Ripple."** / lede **"Reactive graph
  infrastructure for agentic systems — one exact sentence per claim."** Six
  cells: Typed catalog, Effect-native, Live queries, Db-per-tenant, Time travel,
  **"Invariants as product"**.
- Section 6 (`:168-172`): **"The shape of a deployment."** — "One peer Worker,
  one Transactor Durable Object per logical database, N QueryReplica Durable
  Objects, one R2 bucket. Nothing else to run." + four invariant cells
  (Single writer / Dense `t` / Persist-before-ack / Replicas first-class).
- Closing (`:195`): **"Changes ripple. Agents respond. State stays coherent."**
  + one CTA, **"Read the introduction"**.

### First-run path, in order

1. `getting-started/introduction.md` — 415 words, **zero code blocks**, six
   table rows, one section titled "Datomic, revisited for the edge".
2. `getting-started/quickstart.md` — 539 words. Step 1 is `git clone
   https://github.com/tvanhens/ripple`.
3. Then the reader is on their own: the Guides order is catalog → transact →
   query → live → workers → deploy → auth.

### Reference pages

Client API (743 w, **37 table rows, 0 code blocks**), Alchemy resources (407 w),
HTTP API (448 w, 21 rows, 0 code blocks), Errors (364 w), Configuration
(569 w, 29 rows), Runbook (691 w, 0 code blocks).

### Examples present on the site

None. No runnable app on the site, no StackBlitz, no CodeSandbox, no
`examples/` index page, no screenshot of the todos app the Quickstart tells you
to run.

### Site-wide component usage

Zero Starlight components: no `<Card>`, `<CardGrid>`, `<Tabs>`, `<Steps>`,
`<LinkCard>`, `<FileTree>`. Three `:::note`/`:::caution` asides in the whole
site. Zero code fences with `title=` or `frame=` — filenames are announced in
bold prose above naked code blocks (`quickstart.md:39`, `:53`, `:76`).

---

## 2. Five hats

### Hat 1 — Confused beginner ("what is this and can I use it?")

**F1.1 — The first screen never says what you build.** Hero H1 "The graph that
reacts." + subhead "One Durable Object writes. Segment trees live in R2.
Datalog runs at the edge, next to your app. Built on Effect, typed end to end."
Four sentences, four proper nouns of internal machinery (Durable Object,
segment trees, R2, Datalog), and not one noun the reader owns: no app, no user,
no screen, no team, no data. A stranger cannot answer "would I use this for my
chat app?" *Fix:* one sentence of the form "Ripple is a typed, realtime
database for apps you deploy on Cloudflare — write TypeScript, get live queries
and per-user permissions, no server to run," then the machinery below the fold.

**F1.2 — "Datalog" is on the first screen and is never defined on the site.**
`index.mdx:23` says "Datalog runs at the edge." Search the docs: `guides/queries.md`
mentions "the datalog + pull IR" (`:8`) and `concepts/architecture.md:39` "The
datalog engine is seek-driven" — nobody ever says what datalog *is* or why the
reader should care. Same for "segment trees", "basis", "novelty", "peer".
The brief's banned words are technically absent from the hero, but "Datalog",
"Durable Object", "R2", and "Effect" are four unexplained nouns in 42 words —
identical bounce behaviour. *Fix:* zero unexplained proper nouns above the fold;
one glossary page, and every first use links to it.

**F1.3 — "transactor" and "datom" are on the landing page anyway.**
`index.mdx:162`: "Replicas are first-class — workers never read novelty from the
transactor." `index.mdx:170,177`: "one Transactor Durable Object per logical
database". The section that is supposed to reassure ("The shape of a
deployment.") is the densest jargon on the page. *Fix:* replace with a
capability list a beginner can check off, or delete it — an internals section
belongs on `concepts/architecture.md`, which already has all of it.

**F1.4 — The Introduction is a history lesson.** `introduction.md:43-51` is a
section literally titled **"Datomic, revisited for the edge"**: "If you know
Datomic, the bones are familiar: an immutable EAVT fact store, a single
transactor, time travel as a view (`asOf`, `history`), datalog queries, and pull
patterns." This is the second thing in the sidebar. For a reader who has never
heard of Datomic it says: *you are not the intended reader.* It also contains
the exact four bounce words (EAVT, transactor, datalog, pull). *Fix:* demote to
`concepts/for-datomic-users.md`, unlinked from the first-run path, and make
Introduction a 200-word "here is the mental model in three nouns: entity,
attribute, fact — with one code block".

**F1.5 — The Introduction has no code.** Zero fences. The first page of the
site is a bullet list of claims ("The invariants are the product. Single writer.
Dense `t`. Persist-before-ack." `:23-25`) and a components table. A vibe-coder
scrolls for a code shape and finds none.

**F1.6 — There is no install command anywhere on the site.** Quickstart step 1
(`quickstart.md:11-14`) is `git clone` + `bun install` + `bun alchemy dev
examples/todos/alchemy.run.ts`. Every package in the repo is `"private": true`
(`packages/*/package.json`) — there is nothing on npm — but the docs never say
so. Meanwhile the hero's terminal-styled strip
(`› ripple.db("acme", Catalog)`) *looks* like the install line and isn't one;
`user-select: all` means one click copies the comment too. So the single
strongest "how do I try it" affordance on the page yields text that does not
run. *Fix:* say it out loud on the landing page and in Quickstart — "Ripple is
pre-release; you run it from the repo today" — and put a real command in the
strip (`bun alchemy dev examples/todos/alchemy.run.ts`).

**F1.7 — The Quickstart's own snippet is broken when copied.**
`quickstart.md:100-105`:
```ts
token: Effect.succeed(Redacted.make(import.meta.env.VITE_RIPPLE_TOKEN)),
```
The real example (`examples/todos/src/db.ts`) guards it: `token === undefined ||
token === "" ? undefined : Effect.succeed(Redacted.make(token))`. The
documented version wraps `undefined` and sends a bogus token — the reader's
first connection against an open local peer starts from a landmine. *Fix:*
paste the example verbatim, or better, import the file contents at build time so
docs cannot drift from `examples/`.

**F1.8 — Quickstart hedges the one thing that decides success or failure.**
`quickstart.md:28-32`: "Local dev needs no real Cloudflare account. Set
`ALCHEMY_STATE=local` and any placeholder `CLOUDFLARE_ACCOUNT_ID` (32 hex
characters) with `CLOUDFLARE_API_TOKEN=x` **if Alchemy asks for credentials**."
"If Alchemy asks" is a coin flip presented as prose after the command block.
`examples/todos/README.md` states the env vars as *required* and prefixes them
on the command. Also, port drift: `examples/todos/README.md` says "peer on
:1337" and uses `VITE_RIPPLE_URL=http://localhost:1337`, while
`quickstart.md:20` says `http://localhost:8787`. One of these makes the tab
never connect, with no error the reader can interpret. *Fix:* one copyable
block with the env vars inlined, one port, and a "you should see" checkpoint.

**F1.9 — No success checkpoint, no picture.** The payoff sentence is
`quickstart.md:26`: "Add a todo in one tab and watch another tab react." No
screenshot, no GIF, no expected terminal output, no "if it fails, check X".
For a product whose entire pitch is *reactivity*, the site never shows
reactivity happening.

**F1.10 — Code samples use symbols the site never defines.**
`guides/queries.md:13-20` builds `openTodos` from `Todo.done`, `Todo.owner.name`,
`Todo.due`, `User.name` — but the only `Todo` on the site
(`quickstart.md:45-50`, `index.mdx:58-65`) is `{ title, done, createdAt }`. No
`owner`, no `due`, no `User` in that catalog. The reader pastes the flagship
query example and TypeScript rejects it. Same class of failure:
`guides/auth.md:53-77` uses `Doc`, `Project`, `Org`, `User`, `App`, and `Schema`
with no definitions or imports on the page; `guides/workers.md:20-37` uses
`HttpServerRequest`, `HttpServerResponse`, and an undefined `tenantOf(request)`.
Nearly every non-Quickstart snippet is a fragment with `yield*` at top level and
no enclosing `Effect.gen` — nothing on this site can be run as pasted.
*Fix:* one catalog (todos, with `owner`, `due`, and `user`) used by every page
from Quickstart to Auth, and complete runnable blocks with the imports folded
into a collapsed section.

**F1.11 — "Where to go next" sends the beginner to the Client API.**
`introduction.md:55-59` offers Quickstart, Architecture, and "Client API — every
name the client exports". Two of three are internals/reference. There is no
"build your first app" track.

---

### Hat 2 — "Just give me Firebase"

**F2.1 — Auth is invisible in the funnel.** The landing page contains **zero**
occurrences of "auth", "permission", "policy", "secure", "security", or "safe"
(grep across `index.mdx`). The reader who came for "built-in safety" gets
"Dense `t`" instead. Auth is the **7th of 7** guides, behind deploy.

**F2.2 — Realtime is claimed but never shown as a UI.** "Live queries" is one of
six equal cells (`index.mdx:148-151`) and its body is "`db.live` is a `Stream`
on the session socket. It survives dropped sockets and retries with backoff;
teardown is fiber interruption." That is a description of a Stream, not of a
todo list updating in another tab. The React story exists — `useLive` at
`guides/live-queries.md:36-47` — but only as an inline block in guide #4, and
`examples/todos/src/useLive.ts` is labeled "Example code, **not** a shipped
name". So the framework story is: *write your own hook, we won't ship one.*
For a Firebase-shaped reader that is a missing product.

**F2.3 — No hosted anything.** No signup, no dashboard, no free tier, no
console, no data browser, no CLI beyond `bun alchemy`. `reference/http-api.md:17`
mentions "a small demo console (disabled once a policy is configured)" — the
only inspectable surface in the product, mentioned once, in the HTTP reference,
with no screenshot and no instruction to open it. Zero-ops is *true* here
(no external DB, one Worker) and it is never sold: the words the reader is
scanning for — "no server to run", "no migrations", "no connection pool" — are
never said in reader-facing terms. `quickstart.md:25` gets closest: "there is no
external database to start."

**F2.4 — Auth is BYO-everything and the docs bury the punchline.**
`guides/auth.md:147-148`: "Ripple verifies tokens; it never issues them. JWT
minting, IdP integration, login, and refresh UX live in your auth provider."
That is a legitimate design, but it is the *last line* of the page. A Firebase
reader reads seven paragraphs about policy ASTs and then discovers they must
supply Clerk/Auth0/WorkOS. *Fix:* say it in the first two lines, name the
providers that work, and add "Auth with Clerk in 10 minutes" as an actual page.

**F2.5 — Nothing tells you how to run a policy locally.** Auth modes table
(`guides/auth.md:9-12`): "Open | neither set | everyone — local dev". So the
documented dev loop has *no* permissions, and there is no recipe for a local
JWT, a test principal, or asserting that a denied write is denied. The reader
cannot experience the safety feature before deploying it.

**F2.6 — No comparison, anywhere.** "Postgres", "Convex", "Supabase",
"Firebase", "Instant" appear zero times across all 19 pages. The landing page
never answers "instead of what?" It also never states cost, latency numbers, or
scale in reader units (the one hard number in the product,
`reference/runbook.md:31-34`, "~2.5–2.9k small tx/s … low thousands of tx/s per
logical database, full stop", is buried on the last page of Reference — where
it reads like a limitation confession rather than a capacity answer).

---

### Hat 3 — Designer

**F3.1 — It is a well-recolored Starlight, not a product site.** Customization
is `theme.css` (color variables + landing-only classes), a `SiteTitle` lockup,
and a forced-dark `ThemeProvider`. Everything else is default Starlight: default
sidebar, default TOC, default asides, default tables, default search box, no
custom card/step/tab styling, no footer (no links to GitHub/Discord/status/
license below the fold on doc pages), no hero image, no motion. Landing scores:
one moss dot per feature cell (`.rg-cell h3::before`) is the entire ornament
budget.

**F3.2 — The feature grid is nearly invisible.** `.rg-grid` uses `gap: 1px` over
`background: var(--sl-color-hairline)` (`#232320`) with `.rg-cell { background:
var(--rg-void) }` — cells are the same color as the page, so six features read
as a faint 3×2 wireframe on black. Nothing draws the eye to the two cells that
matter (typed + live). *Fix:* give the two lead benefits a larger, distinct
treatment; drop the rest to a two-line list.

**F3.3 — Code is off-brand.** `astro.config.mjs:33` sets
`themes: ["github-dark"]` — GitHub's blues/purples/oranges inside a
warm-white/void/moss brand, and the reader spends more time looking at code
blocks than at anything else on the site. Frames are dark (`#0b0b09`) but the
tokens are somebody else's palette. Also every fence is untitled: no `title=` /
`frame=` in the entire content tree, so the file a snippet belongs to is
announced in bold prose above the block (`quickstart.md:39`: "**`schema.ts`** —
the catalog, shared by the stack…"). Starlight gives filename tabs for free and
the site declines them.

**F3.4 — Landing rhythm is flat.** Six sections, all the same width (72 rem),
same vertical rhythm (`margin: clamp(3.5rem,10vh,6rem)`), same two-column
split three times in a row (`index.mdx:43`, `:72`, `:114`) with the same
proportions (`2fr / 3fr`). No visual climax, no color change, no full-bleed
moment, no data, no logos, no testimonial, no screenshot. The page is a
uniformly-spaced column of text and code.

**F3.5 — Two `<h1>`s in the landing DOM.** `dist/index.html` contains
`<h1 id="_top">The graph that reacts</h1>` (Starlight's frontmatter title) and
`<h1>The graph that reacts.</h1>` (the hero). The first is hidden by
`main:has(.rg-hero) > .content-panel:first-child { display: none }`
(`theme.css:83-85`) — a fragile CSS trick against a framework-owned node, which
also means Pagefind and crawlers see a duplicated headline. *Fix:* use
`hero`/`template: splash` frontmatter or a dedicated `.astro` page instead of
hiding framework output with `:has()`.

**F3.6 — Social/SEO presentation is unbranded.** `og:title` = "The graph that
reacts", `og:description` = "Ripple — an immutable, reactive graph database for
Cloudflare. Changes ripple. Agents respond. State stays coherent." There is
`twitter:card: summary_large_image` and **no `og:image`** — every share renders
as a blank card. `<title>` for the homepage carries no product noun.

**F3.7 — Reference pages are table walls.** `reference/client-api.md`: 37 table
rows, zero code blocks. `reference/configuration.md`: 29 rows.
`reference/http-api.md`: 21 rows, zero code. Signatures like
`db.transact` — "`<A, E, R>(body: (tx: Tx<C>) => Generator<Effect<unknown, E,
R>, A>) => Effect<TxReport<C>, DbError \| E, R>`" — are jammed into a table cell
where they wrap into soup. Reference needs per-symbol sections with an example
each, not a spreadsheet.

**F3.8 — Dark-only, with the control deleted.** `ThemeSelect.astro` is an empty
component and `ThemeProvider.astro` pins `data-theme="dark"`. Defensible
brand-wise; still: no light mode for readers who need it, and no note anywhere
that the choice is deliberate.

---

### Hat 4 — Copy

**F4.1 — Meta-copy leaked onto the page.** `index.mdx:137`: "Reactive graph
infrastructure for agentic systems — **one exact sentence per claim**." The
second half is a note-to-self about how the copy was written. Delete it. The
first half is the other problem: "reactive graph infrastructure for agentic
systems" is four abstract nouns and zero verbs.

**F4.2 — Physics poetry where information belongs.** `index.mdx:36-39`: "State
the change." / "A change enters the system, travels through the field, and
produces a coherent response." "The field" is not a thing in this product.
`index.mdx:74`: "Observe. Propagate. Resolve." — three verbs with no subject.
`index.mdx:195`: "Changes ripple. Agents respond. State stays coherent." Three
sentences, zero facts. This is the closing CTA: the last thing a reader reads
before deciding, and it says nothing they can act on.

**F4.3 — "Agents" is a decoration, not a claim with support.** "agent" /
"agentic" appears exactly 3 times site-wide — `index.mdx:3`, `:137`, `:195` —
all in slogans. Not one page in Guides or Concepts mentions agents, LLMs, tools,
or MCP. Either the product has an agent story and the docs must show it, or the
word should be cut from the landing page for making a promise the site does not
keep.

**F4.4 — Features named as internals, not benefits.** Cell titles read
"Effect-native", "Invariants as product", "Db-per-tenant", "Time travel". Bodies
are worse: "Every signature's requirements channel is `never` — one runtime runs
everything" (`:146`); "teardown is fiber interruption" (`:150`); "Dense `t`. `t`
is only ever read. No API mints, skips, or supplies one; the log is gap-free by
construction" (`:180-181`). These are true and they are release notes for the
implementers. Benefit translations exist and are never made: *"a mistyped write
does not compile"*, *"an acknowledged write is on disk before you get the
reply"*, *"deleting a row never destroys the record — you can read yesterday"*.

**F4.5 — The one-noun brand test fails.** In the first 42 words the reader must
already know: Cloudflare, Durable Object, R2, Datalog, Effect. Every one is
somebody else's proper noun. Ripple is described in terms of five dependencies
before it is described in terms of one job.

**F4.6 — Hedging and roadmap in the middle of a teaching page.**
`guides/queries.md:92-94`: "**Today** order / limit / offset run client-side on
the projected rows; server-side ordering is **on the roadmap** (`docs/QUERY.md`
in the repository tracks the feature matrix)." A reader learning `orderBy` hits
"actually this is client-side" and is then sent to a Markdown file in a git repo
that this site does not host. `guides/queries.md:105-108` does the same with
"Both runners **also still accept the legacy callback builder**" — introducing a
deprecated API in the middle of the primary read guide.

**F4.7 — Passive/agentless constructions in the safety-critical page.**
`guides/auth.md:24-25`: "Writes are checked twice: a fast-fail at Worker
ingress, then authoritatively inside the Transactor's commit loop." Who checks?
`:98-100`: "Combination is deny-by-default: `allow` arms OR, any `deny` wins, an
attribute rule ANDs with its namespace rule, and a namespace with no rule
denies." That is a truth table rendered as a sentence — exactly the content that
should be a table or, better, four two-line code examples with the verdict in a
comment.

**F4.8 — Sentence fragments as a house style, at scale.** "One Durable Object
writes." "Dense `t`." "Persist-before-ack." "Install is explicit and once."
"Privilege is the capability you bind." Individually striking; twenty in a row
reads as a manifesto, and a beginner cannot extract a procedure from a manifesto.

---

### Hat 5 — Safety skeptic

**F5.1 — "Built-in safety" is not a promise the site makes.** It is not made on
the landing page at all (F2.1). The nearest thing is "Invariants as product"
(`index.mdx:161-162`), whose four invariants are about *durability and write
ordering*, not about *who is allowed to do what*. A skeptic scanning for
"permissions" finds nothing on the front door.

**F5.2 — The real mechanisms are strong and are hidden.** `guides/auth.md` is
the best page on the site: a filtered `Db` where "a datom `[e a v t]` is visible
iff the read rule for `a` holds for `e`" (`:22-23`), writes checked twice with
the authoritative pass "inside the Transactor's commit loop against the exact
database value the transaction will apply to" (`:24-25`), "Deny by default,
everywhere" (`:26`), a namespace rule that means "every attribute under this
prefix — a newly added `:doc/ssn` inherits `doc.read` rather than becoming
world-readable" (`:95-98`), "A denied `pull` is `NotFound`, indistinguishable
from absent" (`:119-120`), and a deploy-time compile error for masked required
attributes (`:123-127`). That last one is the single most convincing sentence on
the site — *the compiler catches an information leak before deploy* — and it
lives in a `:::caution` box on page 7 of the Guides. None of it is on the
landing page, in the Introduction, or in the Quickstart.

**F5.3 — No code demonstrates a denial.** Across 19 pages there is not one
snippet showing a write being rejected, a filtered read returning fewer rows, or
a test asserting a permission. `guides/auth.md:53-77` shows a policy *definition*
(with undefined symbols, F1.10) and never shows it in use. The reader must take
"deny by default" on faith.

**F5.4 — Typed safety is asserted, rarely demonstrated.** The one real
demonstration is `guides/transactions.md:33-34`: "`movie.add(Movie.year,
"2016")` does not compile." That is the best safety sentence in the Guides and
it appears once, without a red-squiggle screenshot or a "try changing this"
prompt. `index.mdx:142` restates it abstractly: "Attributes, uniqueness, and
cardinality are checked at compile time."

**F5.5 — "You cannot wreck production" is undersold and partly contradicted.**
The material for the strongest claim in the category exists: immutable facts
("there is no destructive migration — old datoms keep their attribute",
`guides/catalog.md:92-94`), `asOf`/`history` audit ("who changed this and when",
`concepts/time-travel.md:33-34`), and `txEid` for audit facts
(`guides/transactions.md:74`). None of it is framed as "you cannot lose data"
on the landing page. Meanwhile the operational sharp edges the skeptic actually
fears are only discoverable in Reference: 413 query-budget kills
(`guides/queries.md:146-151`), `Unavailable` 503s during a transactor reboot
(`reference/errors.md:25`), the hard write ceiling and the "split your database,
there are no cross-database joins" remedy (`reference/runbook.md:54-66`), and
`RIPPLE_RETAIN_ROOTS` default 20 — which quietly means **history older than the
retention window is not `asOf`-able** (`concepts/time-travel.md:46-49`,
`reference/configuration.md:36`). If time travel is a headline feature, its
retention limit must be next to it, not two clicks away.

**F5.6 — Deploy safety is asserted without a mechanism.** `guides/deploy.md:95`:
"The peer is open until you say otherwise." True and alarming: the default
posture is *no auth*, and nothing in the deploy guide gates or warns at deploy
time ("you are about to deploy an open peer"). There is no staging/prod
checklist, no "before you go to production" page, no way for the docs to prove
the reader did not just publish an open database to the internet. That is the
exact failure the target reader is afraid of.

**F5.7 — Nothing about backups, export, or disaster recovery.** The runbook
covers transactor aborts, replica gaps, indexer stalls, and bucket bloat. There
is no "how do I get my data out", no export path, no bucket-level backup story,
and no statement of what happens if the R2 bucket is deleted. A skeptic
evaluating a database asks this in the first ten minutes.

---

## 3. Prioritized fix list

Ordered by impact on "stranger understands + tries + trusts".

1. **Rewrite the hero to a job, not a topology.** *(Landing)* Replace H1 "The
   graph that reacts." and the 4-sentence subhead with: an H1 naming the
   product category and the payoff (e.g. "The typed, realtime database for apps
   you ship on Cloudflare"), a subhead of ≤25 words covering *typed schema +
   live queries + per-user permissions + nothing to operate*, and keep the
   poetry as an eyebrow or the closing line only. No unexplained proper nouns
   above the fold: move Durable Object / R2 / Datalog / segment trees down the
   page or into Concepts.

2. **Put safety on the first screen with a mechanism, not a slogan.**
   *(Landing)* Add a third hero-adjacent block, above "Why Ripple", with real
   code: a policy rule, a denied write returning `TxRejected`, and the
   compile-time rejection `movie.add(Movie.year, "2016")`. Lead with the
   deploy-time leak check from `guides/auth.md:123-127`, phrased for humans:
   "a read-masked attribute that would silently drop rows is a build error."

3. **Give the landing page a working demo.** *(Landing)* Screenshot or 5-second
   loop of the todos app with two tabs syncing, or an embedded editor. A
   reactivity claim with no visible reactivity is the biggest single credibility
   gap on the page.

4. **Fix the "how do I try it" line.** *(Landing / First-hour path)* Replace the
   fake terminal strip `› ripple.db("acme", Catalog) …` with a real, copyable
   command, and state pre-release status honestly ("not on npm yet — run it from
   the repo"). Nothing on the page should look like an install command and not
   be one.

5. **Rewrite Quickstart as a checkpointed 10-minute story.** *(First-hour path)*
   One block with env vars inlined (`ALCHEMY_STATE=local
   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=x`), one port (reconcile 8787 vs
   the example README's 1337), a "you should see" screenshot after each step, the
   corrected token guard from `examples/todos/src/db.ts` (kill the
   `Redacted.make(undefined)` bug at `quickstart.md:103`), and a final section
   "now make a write fail" that adds a policy and shows the denial.

6. **Make one catalog canonical and make every snippet compile.** *(First-hour
   path / Reference)* Pick the todos catalog, extend it with `owner`, `due`, and
   a `user` namespace, and use it on every page. Today `guides/queries.md:13-20`
   references `Todo.owner`, `Todo.due`, `User.name` that exist nowhere, and
   `guides/auth.md:53-77` references `Doc`/`Project`/`Org`/`App` that exist
   nowhere. Ideally import snippets from `examples/` at build time so drift is
   impossible.

7. **Promote Auth and policy out of last place and split it.** *(IA)* New order:
   Getting started → **Your first app** → **Permissions** → Queries → Live →
   Deploy. Split the current page into "Permissions in 10 minutes" (three modes,
   one rule, one denial, run it locally) and "Policy reference" (combinators,
   combination semantics, enforcement points). Add the missing recipe: how to
   get a JWT in local dev.

8. **Delete or replace "The shape of a deployment." on the landing page.**
   *(Landing)* "one Transactor Durable Object per logical database, N
   QueryReplica Durable Objects" is the highest-jargon block on the page and it
   sells nothing. If a "how it works" moment is wanted, use one diagram with
   three boxes and plain labels (writer / storage / edge readers) and link to
   `concepts/architecture.md`.

9. **Translate the six "Why Ripple" cells into benefits.** *(Landing)* Cut to
   four. Kill "Effect-native", "Invariants as product", "requirements channel is
   `never`", "teardown is fiber interruption". Replace with: *typed writes fail
   at compile time*, *queries update themselves*, *every user sees only their
   rows*, *nothing is ever overwritten — read any past state*. Keep the precise
   internal sentence as a smaller subline under each.

10. **Add "Ripple vs. what you're using now".** *(IA)* One page, honest columns
    against Postgres+Prisma, Convex, Supabase, Instant: what Ripple gives
    (typed graph, live queries by default, per-datom policy, immutable history,
    no server) and what it does not (no SQL, no published npm package yet, no
    hosted dashboard, no cross-database joins, low-thousands tx/s per database,
    BYO identity provider). The skeptic reads the "does not" column and trusts
    the rest.

11. **Add a "Before production" page.** *(IA / Reference)* Checklist:
    `RIPPLE_POLICY` set (the peer is open by default —
    `guides/deploy.md:95`), `RIPPLE_ALLOWED_ORIGINS` narrowed, JWT audience and
    TTL, admin routes reachable only by the `admin` class, retention chosen
    (`RIPPLE_RETAIN_ROOTS` — and what you lose when a root ages out), query
    budget, what to do on 503/413. Link it from Deploy and from the landing
    safety block.

12. **Fix Introduction: mental model + one code block, Datomic moved out.**
    *(First-hour path)* Explain entity / attribute / fact in three sentences
    with one runnable snippet; move "Datomic, revisited for the edge"
    (`introduction.md:43-51`) to `concepts/for-datomic-users.md` and keep it out
    of the sidebar's first group.

13. **Turn Client API from a table wall into a reference with examples.**
    *(Reference)* 37 rows, 0 code blocks today. One section per symbol
    (`db.q`, `db.live`, `db.pull`, `db.transact`, `db.asOf`, `db.history`,
    `db.install`) with signature, a 3-line example, and the errors it can fail
    with, cross-linked to `reference/errors.md`.

14. **Make the site look like it ships a product.** *(Landing / IA)* Custom code
    theme in brand colors instead of `github-dark`; `title=` on every fence so
    files are labeled; Starlight `<Steps>` for Quickstart and `<Card>`/`<Tabs>`
    where tables are being used to teach; an `og:image`; a real `<title>`
    containing "Ripple"; a footer with GitHub / license / status; drop the
    two-`h1` CSS hack at `theme.css:83-85` for a proper splash page.

15. **Ship the things a vibe-coder expects in 2026.** *(IA)* An `/examples`
    section that actually links `examples/todos` and `examples/kv-style` with
    what each proves; a shipped or clearly-blessed React binding (today
    `useLive` is explicitly "**not** a shipped name"); `llms.txt` /
    `llms-full.txt` and a "copy page as Markdown" affordance, since this
    audience's first move is pasting your docs into a coding agent — a
    1,693-word site is small enough to serve whole.

16. **State the honest limits where they are relevant, not only in the
    Runbook.** *(Reference / First-hour path)* Write ceiling (~low thousands
    tx/s per database) next to "db-per-tenant"; `asOf` retention next to "Time
    travel"; client-side `orderBy`/`limit` (`guides/queries.md:92-94`) as a
    labeled callout at the top of the ordering section rather than a trailing
    "Today… on the roadmap"; and no pointers to `docs/*.md` files the site does
    not host.
