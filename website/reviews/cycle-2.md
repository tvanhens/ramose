# Adversarial review — cycle 2

Site: `website/` (Astro 5 + Starlight), branch `feat/docs-site` (PR #31), read at
`cdcecc3`, freshly rebased on master after **PR #30** (server-side
`orderBy`/`limit`/`offset`, callback query builder retired, `db.live` suppresses
identical consecutive emissions).

What a stranger sees now: **22 pages** in `dist/` (Pagefind `page_count: 22`),
~21,600 words of rendered body text site-wide, **1,523 words on the landing
page**, 8 code frames on the landing, and **zero raster images anywhere except
`og.png`** — no screenshots, no diagrams, no video. The word "Reef" appears on
**zero** pages, although `examples/reef` is the flagship demo in the repo and
boots with one command.

Reader assumed: never heard of Datomic; wants a database to vibe-code apps with;
wants typed data and per-user permissions so they cannot silently wreck prod;
comparing against Convex / Supabase / Instant / Postgres+ORM.

Ground truth used: `packages/` (verified directly for every mechanism claim in
this document), `examples/`, `docs/QUERY.md`, `docs/API.md`, and
`website/reviews/shipped-api.md` — **except** §5.5 / §5.6 / §12 of that file,
whose query semantics predate PR #30 and must not be used.

---

## 1. Cycle-1 fixes: landed / partially / not

Checked against the site as it stands (`cycle-1.md` §3, items 1–16).

| # | Cycle-1 fix | Status |
| --- | --- | --- |
| 1 | Hero states a job, not a topology | **Landed** — H1 is "The typed, realtime database for apps you ship on Cloudflare"; no Durable Object / R2 / Datalog above the fold. Residual: the H1 does not contain the word "Ripple" (D2/C15), and the tagline's "no server to run" overclaims (A3/A8). |
| 2 | Safety on the first screen with a mechanism | **Landed** — the third code moment is policy + a denied write + `Policy.compile(policy, { pulls })`. Residual: the deploy-time check is only a code comment (A9), and the deny-by-default sentence is factually wrong (A3). |
| 3 | A working demo / screenshot on the landing | **Not landed** — replaced by a CSS-drawn two-pane mock (`index.mdx:18-36`). Still zero images (C6/A10). |
| 4 | Real copyable try-it command + honest pre-release status | **Partially** — the fake terminal strip is gone and pre-release is stated, but the block is a 4-env-var, two-process, 9-line paste that PR-phase-0 has now made obsolete (C1). |
| 5 | Checkpointed quickstart, one port, corrected token guard | **Partially** — `<Steps>`, a `curl /health` checkpoint and the correct token guard all landed. Still three terminals, numbered 1/3/2, no prerequisite, no stop instruction, and an "empty list" checkpoint that is false on run two (C9–C12, F11). |
| 6 | One canonical catalog, compiling snippets | **Landed** — todos + `user`/`owner` is used from quickstart through the guides. Residual: `live-queries.md` puts `db.live` in the wrong file (F9), `permissions.md` edits files that do not exist (F4). |
| 7 | Auth promoted out of last place, split | **Landed** — `guides/permissions.md` exists and is linked from the quickstart's Next; `guides/auth.md` remains as reference. Residual: the permissions walkthrough is not actually runnable (F4). |
| 8 | Delete "The shape of a deployment" | **Landed** — replaced by "How it works" in plain nouns. Residual: numbered 01/02/03 as if steps (D10) and one false durability claim (A4). |
| 9 | Six internals cells → four benefits | **Landed** — four benefit cards in reader language. Residual: three of the four restate the code moments (C5/D4) and none mentions tenancy (A2-appeal). |
| 10 | "Instead of what?" comparison | **Landed** — four rows + an honest limits line. Residual: no Cloudflare-native row (A8), limits line is a middot run-on (D9). |
| 11 | "Before production" page | **Landed** — `guides/before-production.md`. Residual: one checklist item is stale after #30 (A5/F2). |
| 12 | Introduction: mental model, Datomic moved out | **Landed** — `concepts/for-datomic-users.md` exists. Residual: that page still advertises the retired callback builder and client-side paging (A9/F14/A7-appeal); the Introduction contradicts the landing on time-to-first-run (A12-appeal). |
| 13 | Client API reference with examples | **Not landed** — `reference/client-api.md` still has zero code fences. Out of scope for cycle 2 (see "Deliberately not doing"). |
| 14 | Site looks like a product | **Landed** — brand code theme (`everforest-dark`), `title=` on fences, `<Steps>`, `og.png`, splash template, `<title>` contains "Ripple". Residual: `og:type` is `article` on the home page (D12); no footer. |
| 15 | Examples section, React binding, llms.txt | **Partially** — an Examples sidebar group exists, but it lists two of the three examples and omits the flagship (C2/A1/F10/D12); no React package, no `llms.txt`. |
| 16 | Honest limits stated where relevant | **Partially** — retention sits next to time travel on the landing and the write ceiling is in the limits line. Residual: the ceiling is stated without its escape hatch (A11), and the Introduction promises "a free audit trail" with no retention caveat (A13). |

---

## 2. New-user dry run (phase 0)

A fresh clone of this branch was run end to end on Bun 1.3.10, macOS, ports
1337/5173/1338 confirmed free first.

**Part A — the documented path, unmodified.** It works. Every promise the docs
make was reproduced:

| step | time | result |
| --- | --- | --- |
| `git clone` (local) | 0.2 s | clean (from GitHub expect 10–30 s) |
| `bun install` at root | 3.1 s | 1540 packages, no errors, `node_modules/` at root as documented |
| `CI=1 ALCHEMY_STATE=local CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=x bun alchemy dev examples/todos/alchemy.run.ts` | 4 s | `[Peer] ready at http://localhost:1337`, `Done: 8 succeeded` |
| `curl http://localhost:1337/health` | — | `200 {"ok":true,"service":"ripple","stage":"dev","time":…}` — byte-for-byte the documented shape |
| `VITE_RIPPLE_URL=http://localhost:1337 bunx vite examples/todos` | 0.6 s | `Local: http://localhost:5173/`, all modules transform 200 |
| write + read through the example's own `addTodo`/`todoQuery` | — | `[{"id":1003,"title":"buy milk","done":false,…}]`; peer logged `subscriber.connect`, `replica.connect`, `indexer index.run` |
| browser at :5173 | — | heading, textbox, live list rendering the row written outside the browser |
| `bun test examples/todos` | 0.3 s | **4 pass / 0 fail / 17 expect()** |

Time to first success is **under a minute of machine time**; all the cost is
copy-paste. Friction found, in order of how much it hurts:

1. **Four hand-set env vars across a backslash continuation**, plus **three
   terminals** before first success. The single ugliest moment in the first hour
   and easy to mangle when copied out of a browser.
2. **No stated prerequisite.** Nothing says Bun is required, or which version.
3. **No stop instruction**, and nothing says `ALCHEMY_STATE=local` persists
   state in the repo between runs — so the documented checkpoint "an empty list"
   is **false on run two**, and a correct setup reads as a failure.
4. **A red workerd stack trace on every client disconnect**: `Uncaught
   exception: … The Workers runtime canceled this request because it detected
   that your Worker's code had hung and would never generate a response.` It is
   the local emulator reaping a live-query socket, not a crash — but the docs
   told the reader to watch that terminal and never mention it.
5. **No `--strictPort`** on the documented Vite command, so a busy :5173 would
   have silently become :5174 with `VITE_RIPPLE_URL` still pointing correctly and
   the reader on the wrong page.
6. **`bun test examples/todos` is invisible** — a free four-second "is my machine
   OK" checkpoint driving the exact `todoQuery`/`addTodo` the page documents.
7. `curl http://localhost:1337/` (no `/health`) returns an unrelated built-in
   demo HTML page — a confusing second app for a curious reader.
8. Quickstart step 1 clones with no branch, so a stranger lands on `master`,
   which does not contain this docs branch. (Correct once the PR merges; noted
   only for reviewers of the branch.)

**Part B — the one-command path, built and verified.** `bun run dev:todos` now
exists. `package.json` gained a `dev:todos` script mirroring `dev:reef` (each env
var defaulted only when unset); `examples/todos/alchemy.run.ts` gained a
`Command.Dev` `Ui` resource that yields `Server`, runs
`bunx vite examples/todos --port 5173 --strictPort`, and passes
`VITE_RIPPLE_URL: server.url` — so the resource graph orders Vite after the peer
and the URL is never hand-set. Verified in the real repo: `Plan: 5 to create`,
`[Peer] ready at http://localhost:1337`, `[Ui] ready at http://localhost:5173/`,
`Done: 10 succeeded`, health 200, browser rendered the app, `bun run typecheck`
exits 0.

**The try-it command the site must show from now on:**

```sh
git clone https://github.com/tvanhens/ripple && cd ripple
bun install
bun run dev:todos     # peer on :1337, app on :5173
```

Files changed by phase 0 (already in the working tree): `package.json`,
`examples/todos/alchemy.run.ts`, `examples/todos/README.md`.

---

## 3. Findings by lens

Ids are kept from the review agents. `revised` marks a finding whose evidence
survived verification but whose proposed fix was corrected.

### Lens A — Conversion

**C1 — The first code a stranger sees is a 4-env-var, two-process paste, and it
is now obsolete.** *(confirmed, sev 3, Landing)*
`index.mdx:45-55`. A band titled "Try it in two minutes" showing nine lines, two
long-lived processes, a fake Cloudflare account id and an API token. A reader
scanning for "how hard is this" prices the product at Cloudflare-infra
difficulty. **Fix:** the three-line block above, plus one clause — "one command
starts the database and the app together."

**C2 / A1 / F10 / D12(a) / A11 — Reef appears nowhere on the site.**
*(confirmed, sev 3, Landing + Docs)*
`grep -rni reef website/src/content/docs website/astro.config.mjs` → zero hits.
The sidebar's Examples group has exactly two entries; `quickstart.mdx:209` says
"**Both** examples in the repository" while `ls examples/` returns
`kv-style reef todos`. Meanwhile `examples/reef/README.md`: "The flagship demo: a
Linear-style, multi-tenant, real-time issue tracker where **every workspace is
its own Ripple database**… One command: `bun run dev:reef`." A senior dev judges
a database by the largest thing built on it; the site's only artifact is a todo
list. **Fix:** one line on the landing after the try-it block, a first sidebar
Examples entry, a third bullet in the quickstart's example list, and a line in
the Introduction's "Start here". No hosted demo, no screenshot.

**C3 / A6 / D3 / F13 — The hero animation promises two-tab sync; the caveat 15
lines below retracts it, in three different strengths across the site.**
*(revised, sev 2, Landing + Docs)*
Hero panes are labelled `one tab` / `another tab` with a wire between them;
`index.mdx:57` then says a change reaches the other tab "on reload".
`quickstart.mdx:78-85` says it "usually does not" propagate;
`live-queries.md:93-98` says "often does not"; only the landing names the
remedy. The retraction lands inside the try-it band, at the moment the reader is
deciding to paste. **Revision:** do **not** delete the caveat — a reader will
open a second tab and see nothing, and `examples/reef/README.md` carries the same
miniflare limit, so Reef does not demonstrate cross-connection live locally
either. Instead lead with what genuinely works and state the limit plainly, in
one wording reused verbatim in all three places.

**C4 / A12(intro) — Three different, all-wrong promises of time-to-first-run.**
*(confirmed, sev 2, Landing + Docs)*
`index.mdx:41` "Try it in two minutes"; `quickstart.mdx:3` "Ten minutes from a
clone…"; `quickstart.mdx:8` "In ten minutes you will have…";
`introduction.md:53` "The Quickstart does that in ten minutes." Measured: under
a minute of machine time. The landing→quickstart handoff multiplies its own
promise by five. **Fix:** two minutes everywhere; reserve any longer figure for
the optional deploy step.

**C5 / D4 — "What you get" restates the three code moments, one card nearly
verbatim.** *(revised, sev 1–2, Landing)*
Card 3 "reads are filtered before they leave the edge, writes are re-checked
inside the writer" vs moment 3 "Reads are filtered before they leave the edge…
Writes are checked twice". Card 1 vs "The schema is TypeScript", card 2 vs "One
query, always current". ~180 words of re-explanation sit between the demonstrated
code and "Instead of what?" — the section that does new work. **Revision:** the
original proposal (delete three of four cards) is wrong: card 1 carries
cardinality/uniqueness and card 2 carries "one WebSocket per page", neither of
which appears in the moments. Delete only the near-verbatim card, fold its
non-duplicated clause into the matching moment, and reuse the freed slot for the
tenancy card (A2-appeal).

**C6 / A10 — No image on the entire site.** *(revised, sev 1, Deliberately not
doing)* Real gap; the fix is contingent on someone actually booting Reef,
signing in, creating a workspace and capturing a still, which nobody did this
cycle. Shipping a mockup or an unverified asset is worse than shipping nothing.
See §5.

**C7 — The landing never says what you would build; the only named app is a todo
list.** *(confirmed, sev 2, Landing)*
The two concrete-use sentences on the page are "add a todo" (`:57`) and "Clone
it, run the todo app, change one row" (`:329`). **Fix:** one sentence naming the
shape Ripple is differentiated for — multi-tenant apps with a database per
workspace — plus the Reef pointer from C2.

**C8 — Zero trust signals.** *(revised, sev 1, Landing)*
No page names tests, a license, a maintainer, or a version. **Revision:** there
is **no LICENSE file** in the repo (`ls LICENSE*` → no match), so do not mention
one. The only claim that can be backed: 48 `*.test.ts` files, and
`package.json:12` `bun run test` covers packages plus `examples/todos` and
`examples/reef`. One line, or nothing.

**C9 / F1 — Quickstart forces three terminals and numbers them 1, 3, 2.**
*(confirmed, sev 3, Docs)*
`quickstart.mdx:34-63`: "Terminal 1 — the peer", then an inner "Terminal 3 —
checkpoint", then "Terminal 2 — the app". The highest-friction minute in the
first hour, and the ordering makes a careful reader stop and re-read. The best
checkpoint on the site (`curl /health`) is a sub-block of the step it validates.
**Fix:** collapse to one `bun run dev:todos` step, promote the curl to its own
numbered checkpoint, demote the long env-var form to a collapsed aside.

**C10 / A2(accuracy) / F11 — "An empty list" is false on the second run, and
there is no way to stop.** *(confirmed, sev 2, Docs)*
`quickstart.mdx:61-63`; `examples/todos/alchemy.run.ts` pins
`state: Alchemy.localState()`, and the dry run confirmed earlier rows survive a
restart. A correct setup fails its own stated checkpoint.

**C11 / A14 — Two paragraphs apologising for a stale port, and no stated
prerequisite.** *(confirmed, sev 2, Docs)*
`quickstart.mdx:65-68` and `:160-162`. `examples/todos/alchemy.run.ts` now runs
`--port 5173 --strictPort` and always injects `VITE_RIPPLE_URL`, so the 8787
fallback in `examples/todos/src/db.ts:20` is unreachable. Meanwhile the one thing
that can stop a reader at line 1 — not having Bun — is unmentioned.

**C12 — The example's tests are a free checkpoint and are invisible.**
*(confirmed, sev 2, Docs)* `examples/todos/test/todos.test.ts`, 4 pass in 282 ms,
driving the same `todoQuery`/`addTodo` the page documents.

**C13 — see C2.**

**C14 — Pre-release is said three times; the closing CTA repeats the hero's.**
*(revised, sev 1, Landing)* Repetition verified (`index.mdx:43`, `:293`,
`quickstart.mdx:13-16`) and the closing buttons duplicate the hero actions.
**Revision:** keep both pre-release statements — "an npm package (clone the
repo)" is doing scanner work inside the comparison list, not apologising. Change
only the closing secondary button, to Reef.

**C15 / D2 — The word "Ripple" never appears above the fold.**
*(confirmed, sev 1–3, Landing)* `astro.config.mjs:9` renders "ripplegraph.ai";
the H1 (60 chars, capped at `18ch` → ~4 wrapped lines) and the 158-char tagline
contain no "Ripple". First rendered occurrence is inside the pre-release caveat
at `:43`. A visitor arriving from a tweet that said "Ripple" cannot confirm they
are in the right place.

### Lens B — Product appeal

**A2 — "A database is a name" — the sharpest differentiator against all four
competitors — is missing from the landing.** *(confirmed, sev 3, Landing)*
The four benefit cards are typed writes, live queries, per-user rows,
immutability. Nothing about tenancy. `concepts/databases-are-names.md` carries
it: `ripple.db("acme", Catalog)` is pure and does zero network; one deployed peer
serves every name, each with its own writer and key prefix. Every competitor
makes per-tenant isolation an ops project. **Fix:** a benefit card (using the
slot freed by C5) plus one clause in the Supabase/Convex comparison rows.

**A3(appeal) / A8(accuracy) — "There is no server to run" is contradicted 300
lines later, and by the quickstart itself.** *(revised, sev 2, Landing)*
`index.mdx:7` and the frontmatter `description` at `:3`. The page then says
"Three moving parts, all of them provisioned by one deploy" (`:303`) and
"deployed into your own Cloudflare account instead of a hosted platform"
(`:275`); the quickstart's step 2 starts a server; `before-production.md` is an
eleven-item operations checklist for it. Against a Convex/Supabase shopper "no
server to run" reads as "hosted for you", which is the opposite of the truth —
and the true version is the better differentiator. **Revision:** the replacement
must be short enough to work as a hero tagline, and must be applied to the
frontmatter `description` too, or the two contradict.

**A4(appeal) / F7 — Two of three landing code moments are Effect generators with
an undefined `run(...)`, and the word "Effect" never appears on the landing.**
*(revised, sev 3, Landing + Docs)*
`index.mdx:91-103` and `:197-207`. The real definition is
`examples/todos/src/db.ts:28` `export const run = runtime.runPromise;`. The first
snippet already imports `effect/Schema` at `:75`. `function*` + `yield*` + a bare
`run` is the silhouette that makes a Convex or Drizzle user think "this is an
Effect project, I will be learning a framework, not a database". The quickstart
compounds it: `ManagedRuntime`, `Redacted` and `yield*` with no orientation, and
`introduction.md` never mentions Effect. **Revision:** do **not** write "you never
write an Effect combinator" — `db.ts` builds a `ManagedRuntime` and
`useLive.ts` uses `Effect.runFork` / `Stream.runForEach` / `Fiber.interrupt`.
Name Effect, explain `run`, and stop there.

**A5 — "Ripple ships no React package" is framed as a virtue.**
*(revised, sev 2, Landing)* True (`packages/` = alchemy, core, replica, storage,
transactor, worker) but spun. **Revision:** the file is **not** shown on the
landing (only `App.tsx` is), and the hook body is 13 lines
(`examples/todos/src/useLive.ts:15-27`) while the landing says twelve and the
quickstart says thirteen (see A12-accuracy). Link the file, do not claim it is
on screen, and say "about a dozen lines" everywhere.

**A7 / A9(accuracy) / F14 — The Datomic page describes retired, pre-#30
semantics.** *(confirmed, sev 3, Docs)*
`concepts/for-datomic-users.md:28` "plus a legacy callback builder" and `:44`
"Ordering, limit, and offset run on the client today." Both false:
`packages/alchemy/src/db/NavQuery.ts` exports one query entry point and lowers
order/limit/offset into the query; `docs/QUERY.md:236` records "(the string-var
callback builder is retired)". It also contradicts `guides/queries.md:109` on the
same site, to the most technically demanding visitor on it.

**A8(appeal) — "Instead of what?" omits Durable Objects + SQLite / D1 +
Drizzle.** *(confirmed, sev 2, Landing)*
The hero is Cloudflare-specific; the four comparison rows address people who have
not chosen Cloudflare yet. The developer who already wrote a DO with
`ctx.storage.sql` is the highest-intent reader on the page and is never told what
Ripple replaces in the code they have.

**A9(appeal) — The deploy-time policy×pull check is delivered as a code
comment.** *(confirmed, sev 2, Landing)*
Verified real: `packages/alchemy/src/db/Policy.ts` — `CompileOptions.pulls`,
`checkPulls`, invoked by `compile`; header line 3 "every check is deploy-time";
`examples/reef/README.md` confirms required pulls of a masked attribute fail at
compile time, with a test. "Tightening a permission rule breaks the build instead
of silently emptying a screen" is something no competitor on the list does, and
it is the page's best answer to the target reader's stated fear. It is currently
unheadlined, below the fold, inside the third code block.

**A11 — The write ceiling is given without its escape hatch.**
*(revised, sev 2, Landing)* `index.mdx:293-295` "more than low thousands of
writes per second per database", stated as an absence. The mitigation exists only
in `concepts/databases-are-names.md` and `reference/runbook.md`: split into
several logical databases along write-ownership lines — and a database is a
function call. **Revision:** only the throughput reframe is worth doing; the rest
of this finding is taste and would churn copy cycle 1 just set. The reframe must
keep the price visible (no joins across databases, already in the same list).

**A12(appeal) — The Introduction contradicts the landing and never positions
Ripple against anything.** *(confirmed, sev 2, Docs)*
`introduction.md:51-53` "ten minutes"; "Start here" lists Quickstart,
Permissions, Define your data — no comparison, no Reef. The Introduction is the
one page a skeptic reads before deciding, and "is this Convex?" goes unanswered
where it is asked.

### Lens C — First hour

**F2 / A5(accuracy) — Before production still says paging is client-side.**
*(confirmed, sev 3, Docs)*
`guides/before-production.md:77-79` "Paging happens after the full result
arrives" vs `guides/queries.md:109-112` "`orderBy`, `limit`, and `offset` run on
the server". Verified against `packages/core/src/query/engine.ts:1167-1168`:
"order → offset → limit, then resolve pulls — so a `:limit` only pulls the rows
that survive it." Two pages of one site give opposite answers on a load-bearing
performance claim, and the wrong half is the scary one.

**F3 / A7(accuracy) — "Copy this file as it stands" does not match the file.**
*(revised, sev 2, Docs)*
`quickstart.mdx:133-162` prints `?? "http://localhost:1337"` under the title
`examples/todos/src/db.ts`, where the file reads `8787`, and then apologises for
it in prose. **Revision:** nobody is broken (`dev:todos` always injects
`VITE_RIPPLE_URL`), so this is credibility, not failure. Cheapest honest fix is
docs-only: print the file as it actually reads and delete the apology — the
fallback is unreachable and needs no commentary.

**F4 — "Permissions in 10 minutes" is not runnable.** *(revised, sev 2, Docs)*
`guides/permissions.md:100-178` shows `scripts/local-jwt.ts`, `policy.ts` and a
`resources.ts` importing `./src/queries.ts` — `examples/todos` has no
`policy.ts`, no `src/queries.ts` (the module is `src/todos.ts`), and its
`resources.ts` has no `Ripple.authEnv` block. `Ripple.authEnv` itself is real
(`packages/alchemy/src/index.ts`); only the file mapping is fictional.
**Revision:** do **not** propose `VITE_RIPPLE_TOKEN=… bun run dev:todos` —
unverified, and `dev:todos` starts its own Vite on `--strictPort 5173`, so it
would collide. Frame the snippets as files the reader creates, fix the bogus
import, and keep the manual two-terminal form here, labelled as the manual form
because the token has to be injected into Vite by hand.

**F5 — The Build path has no success checkpoint after the quickstart's curl.**
*(revised, sev 2, Docs)*
`guides/catalog.md:38-64` titles the grown schema just `schema.ts` — no path, no
"you should now see". Neither catalog, transactions, queries nor live-queries
contains a command to run or an expected output. **Revision:** do not assert
"the peer logs one install transaction" (unverified) and do not tell readers to
edit `examples/todos/schema.ts` (it has side effects on the shipped example and
its tests). Use only the verified checkpoint: `bun test examples/todos`.

**F6 — "Peer" is never defined.** *(confirmed, sev 2, Docs)*
First appearance is a code-block title (`quickstart.mdx:36`), then bare usage at
`:44`, `:134`, `:199`. `introduction.md` never contains the word.

**F8 — The queries guide's "Running a query" section never runs a query.**
*(confirmed, sev 2, Docs)* `guides/queries.md:126-136` ends at
`db.q(openTodos); // Effect — run it once`; the word `run` appears nowhere on the
page.

**F9 — The live-queries guide puts `db.live` in the wrong file.**
*(confirmed, sev 2, Docs)* `guides/live-queries.md:11-28` is titled
`src/todos.ts` and imports `./db.ts`; the real example hoists it in
`examples/todos/src/App.tsx:7`, which is exactly what `quickstart.mdx:193` tells
the reader.

**F12 — The workerd "your Worker's code had hung" trace is undocumented.**
*(confirmed, sev 2, Docs)* See the dry run. The quickstart's only guidance about
that terminal is "Leave this terminal running."

### Lens D — Design and copy

**D1 — On mobile the decorative hero diagram renders above the H1, at 70%
width.** *(confirmed, sev 3, Landing)*
Built CSS: `.hero > .hero-html { width: min(70%, 20rem) }` unconditionally; the
`order: 2` that moves it beside the title exists **only** inside
`@media (min-width: 50rem)`. `dist/index.html` has `<div class="hero-html …">` as
the first child of `.hero`. So on a phone the first ~200 px is an `aria-hidden`
abstract diagram squeezed to 70% of the viewport, and the only sentence that says
what this is sits below it. Starlight's hero rules use `:where()` (zero
specificity) and `theme.css` is injected after, so a plain override wins.

**D5 — Moment 3 stacks three code frames against one short paragraph.**
*(revised, sev 2, Landing)*
`.rg-moment` is `5fr / 7fr` with `align-items: start`; the copy column ends at
about a third of the code column's height. **Revision:** do **not** delete the
`alchemy.run.ts` frame — it is the most differentiating credibility artifact on
the page (A9). Make the copy sticky and add short anchor lines naming what each
frame shows.

**D6 — Body-copy grey fails WCAG AA on the two asides that carry the most
credibility.** *(confirmed, sev 2, Landing)*
`--sl-color-gray-4: #6c6a61` on `#0b0b09` = **3.63:1** (AA needs 4.5:1 at
0.875 rem). The strings dimmed this way are "Ripple ships no React package…" and
"Ripple verifies tokens, it never issues them…" — the two sentences that pre-empt
a senior dev's biggest objections — plus the try-it caveat. `gray-3` (`#a09d92`)
measures ~7.3:1.

**D7 — CTA microcopy is generic and the page ends on the buttons it opened
with.** *(revised, sev 1, Landing)* Verified; **revision:** no duration in a CTA
label — the page already makes one time claim in the eyebrow and a second,
different one reads as sloppy.

**D8 — The try-it terminal block scrolls sideways on a phone.**
*(confirmed, sev 2, Landing)* The fence at `index.mdx:45` has `title` and `frame`
but no `wrap`. At `codeFontSize: 0.8125rem` inside `.rg-run`'s
`clamp(1.75rem, 4vw, 2.75rem)` padding, the 57-character clone line overflows a
375 px viewport. `wrap` is supported by the installed Expressive Code 0.41.7.

**D9 — "What Ripple does not have" is a middot run-on that hides its own worst
item.** *(confirmed, sev 2, Landing)* Six unlike items in one wrapping sentence;
the only quantitative claim on the page is buried mid-string and phrased as a
double negative ("does not have … more than low thousands").

**D10 — "How it works" numbers three parallel components 01/02/03.**
*(revised, sev 1, Landing)* Copy says "parts", design says "steps".
**Revision:** no left/right or flow language in the replacement lede — the grid
is `repeat(auto-fit, minmax(15rem, 1fr))` and wraps to one or two columns on
narrow viewports.

**D11 — With reduced motion the hero's moss dot freezes at the top of the
wire.** *(confirmed, sev 1, Landing)* The reduce block sets `animation: none` but
`top`/`opacity` are defined only inside `@keyframes rg-travel`, so the dot
resolves to `top: auto` at full opacity — it reads as "the write got stuck".

**D12 — The home page ships `og:type=article`.** *(revised, sev 2, Landing)*
Verified in `dist/index.html`. **Revision:** put the override in the **page
frontmatter** `head`, not the global config — a docs page is legitimately an
article, and Starlight's `mergeHead` dedupes by `property`, with page frontmatter
last in merge order, so it wins on the home page alone. (The sidebar half of this
finding is folded into C2.)

### Lens E — Accuracy

**A3(accuracy) — The landing misstates deny-by-default.**
*(confirmed, sev 2, Landing)*
`index.mdx:165` "An attribute with no rule is denied." and `:246-248` "Deny by
default, per attribute". Verified `packages/core/src/policy/eval.ts`
(`allowsOp`): `if (attrArms && nsArms) ns && attr; else if (attrArms || nsArms)
evalArms(attrArms ?? nsArms); else false` — an attribute with no rule **inherits
its namespace rule**; it is not denied. `Policy.ts` agrees ("narrows (ANDs with)
its namespace rule"), and the site's own `permissions.md:76` states the correct
namespace-level form. This is the one sentence a security-minded reader will
test.

**A4(accuracy) — "A write is in object storage before your call returns" is
false.** *(confirmed, sev 2, Landing)*
`index.mdx:314`, repeated at `concepts/architecture.md:21-23`. Verified
`packages/transactor/src/transactor.ts:344-351`: the commit path does **one
SQLite storage write for the whole batch (group commit)** before the ack. R2
receives data later, from the alarm-driven indexer
(`packages/transactor/src/host.ts`: `indexTxThreshold: 500`,
`indexIntervalMs: 5_000`). `guides/transactions.md:138` already states it
correctly. The real guarantee — persist-before-ack in a single-writer DO — is
good; the overclaim is checkable and cheap to lose credibility on.

**A6 — Catalog guide says an un-inferable value type "throws when the module
loads".** *(confirmed, sev 2, Docs)*
`guides/catalog.md:85-91`. Verified: `Attribute.ts` uses `tryInferDbValueType`,
which returns `undefined` for anything unmapped; the throw is `inferDbValueType`
(`valueTypes.ts`, message `ripple/schema: cannot infer :db.type/* from this
Schema`) reached from `ensure.ts` — i.e. at catalog install / deploy. The docs
point the reader at the wrong moment for the most expensive failure.

**A10 — Cost headers are named without their `x-ripple-` prefix.**
*(confirmed, sev 1, Docs)* `guides/queries.md:206` and `reference/http-api.md:50-52`
say `r2-gets`, `cache-hits`. Wire names verified:
`packages/replica/src/replica-do.ts:334-335` and
`packages/worker/src/index.ts:90` (`access-control-expose-headers`).

**A12(accuracy) — `useLive` is twelve lines on the landing and thirteen in the
quickstart.** *(confirmed, sev 1, Landing + Docs)* The hook body is
`examples/todos/src/useLive.ts:15-27` — thirteen lines; the file's own header
says twelve. `live-queries.md:32` says "about a dozen"; `README.md:136` says
"twelve-line".

**A13 — Introduction promises "a free audit trail" with no retention caveat.**
*(confirmed, sev 1, Docs)* `introduction.md:41-43`. Default is
`retainRoots: 20` (`packages/transactor/src/host.ts`), and the site's own
`before-production.md:43-52` warns that older `db.asOf(t)` stops resolving. The
landing is honest about this (`index.mdx:256-258`); the Introduction is not, and
"audit trail" is a compliance word.

**A1(accuracy, README) — The root README's run command predates `dev:todos`.**
*(revised, sev 2, Docs)*
`README.md:29-33` prints the bare two-terminal form. **Revision:** the stated
harm is false — the bare command was re-run in a fresh clone with all four env
vars unset and succeeded (`Done: 8 succeeded`), because `alchemy.run.ts` pins
`Alchemy.localState()`. So the vars are CI/miniflare conveniences, not
requirements, and the README must not claim otherwise. What is real is staleness:
it predates `dev:todos` and `dev:reef`.

---

## 4. Prioritized fix list

Ranked by conversion impact. Owner tags: **Landing** = `index.mdx`, `theme.css`,
components, `public/`, the og script, `astro.config.mjs` *except* the sidebar.
**Docs** = `getting-started/*`, `guides/*`, `concepts/*`, the sidebar array in
`astro.config.mjs`, root `README.md`, `docs/QUERY.md` consistency.
**Example** = already done in phase 0.

| # | Fix | Owner | Findings |
| --- | --- | --- | --- |
| 0 | **`bun run dev:todos` exists.** Root `package.json` script + `Command.Dev` `Ui` resource in `examples/todos/alchemy.run.ts` (`--port 5173 --strictPort`, `VITE_RIPPLE_URL: server.url`) + `examples/todos/README.md` rewritten to lead with the one command. Verified end to end; `bun run typecheck` clean. | **Example — DONE** | phase 0 |
| 1 | **Replace the landing try-it block with the three-line one-command form**, and add the "one command starts the database and the app together" clause. | Landing | C1 |
| 2 | **Rebuild quickstart steps 2–3 into one `bun run dev:todos` step**, promote `curl /health` to its own checkpoint, add `bun test examples/todos`, add the Bun prerequisite, fix the "empty list" checkpoint, add the Ctrl-C stop line, add the workerd-scare note, delete both 8787 paragraphs, demote the env-var form to a collapsed aside. | Docs | C9, C10, C11, C12, F1, F3, F11, F12, A2, A14 |
| 3 | **Surface Reef.** Landing: one line after the try-it block + closing secondary CTA. Docs: first Examples sidebar entry, third bullet in the quickstart's example list ("Both" → "The"), one line in the Introduction's "Start here". | Landing + Docs | C2, A1, F10, C13, A11, D12 |
| 4 | **Fix the mobile hero order** — `@media (max-width: 49.99rem) { .hero > .hero-html { order: 2; width: min(100%, 22rem) } }`. Half of cold social traffic currently sees a decorative diagram before the headline. | Landing | D1 |
| 5 | **Correct the two false mechanism claims**: deny-by-default (attribute inherits its namespace rule) and durability ("in object storage before your call returns" → durable in the writer's storage; R2 segments follow). Fix the architecture page's copy of the second. | Landing (+ Docs for `concepts/architecture.md`) | A3, A4 |
| 6 | **Sweep every pre-#30 query claim**: `before-production.md:77-79`, `for-datomic-users.md:28` and `:44`. No page may say ordering/limit are client-side or reference a callback builder. | Docs | F2, A5, A7, A9, F14 |
| 7 | **Reconcile the time promise**: two minutes on the landing, the quickstart and the Introduction. | Landing + Docs | C4, A12 |
| 8 | **One two-tab wording, reused verbatim** in `index.mdx`, `quickstart.mdx` and `live-queries.md`: lead with what works locally, then the limit and the remedy. | Landing + Docs | C3, A6, D3, F13 |
| 9 | **Add the tenancy benefit card** ("one database per customer is a function call") in the slot freed by deleting the duplicated permissions card, and add the clause to the Convex/Supabase comparison rows. | Landing | A2, C5, D4 |
| 10 | **Reframe the hero tagline and the frontmatter description** away from "there is no server to run" toward "runs in your own Cloudflare account, from one deploy", and put "Ripple" in the visible hero. Widen `.hero h1` to `22ch`. | Landing | A3, A8, C15, D2 |
| 11 | **Promote the deploy-time policy×pull check** from a code comment to a sentence in the section body plus a card headline. | Landing | A9 |
| 12 | **Add the Cloudflare-native comparison row** (Durable Objects + SQLite / D1 + Drizzle), placed first. | Landing | A8 |
| 13 | **Name Effect once, on the landing and in the quickstart**, and define `run`. No claim that the reader never touches Effect. | Landing + Docs | A4, F7 |
| 14 | **Contrast**: `.rg-moment-copy .rg-aside` and `.rg-run .rg-caveat` → `var(--sl-color-gray-3)`. | Landing | D6 |
| 15 | **`wrap` on the try-it fence** (and any other terminal fence on the landing). | Landing | D8 |
| 16 | **Turn the limits run-on into a list** and pull the throughput number out of its double negative, with the escape hatch and its price. | Landing | D9, A11 |
| 17 | **Make moment 3's copy column sticky and add three anchor lines**; keep all three frames. | Landing | D5 |
| 18 | **Fix the guides' file-mapping and runnability errors**: `live-queries.md` snippet retitled `src/App.tsx`; `queries.md` "Running a query" actually runs one; `permissions.md` framed as files you create, with the bogus `./src/queries.ts` import fixed; `catalog.md` snippet given its real path plus the `bun test examples/todos` checkpoint. | Docs | F5, F8, F9, F4 |
| 19 | **Define "peer" once** in the Introduction and gloss it on first use in the quickstart. | Docs | F6 |
| 20 | **Small accuracy sweep**: `x-ripple-` header prefixes; catalog value-type throw timing; "a free audit trail" → bounded by retained roots; "a dozen lines" for `useLive` everywhere; `React package` framed as an owned gap plus a `rg-limits` entry. | Docs + Landing | A10, A6, A13, A12, A5 |
| 21 | **`og:type: website` on the home page only**, via `index.mdx` frontmatter `head`. | Landing | D12 |
| 22 | **Root `README.md`**: lead with `bun run dev:todos`, mention `bun run dev:reef`, keep the long form as the expansion. Do not call the env vars required — the bare command works. | Docs | A1 |
| 23 | **Polish**: reduced-motion dot position; CTA labels ("Run it locally" / "Open the quickstart" / "Browse the source"); `01/02/03` → `writes` / `storage` / `reads`. | Landing | D11, D7, D10 |
| 24 | **One trust line** above the closing buttons: 48 test files, `bun run test` covers the packages and the example apps. No license, no maintainer, no version — none exist to link. | Landing | C8 |

---

## 5. Deliberately not doing

- **A hosted demo, playground, or StackBlitz.** The product deploys into the
  reader's own Cloudflare account; hosting a shared instance is a product
  decision, not a docs-site decision, and nothing in the repo supports it.
- **Screenshots or video of Reef (C6, A10).** Real gap, contingent fix: nobody
  booted Reef, signed in, created a workspace and captured a still this cycle.
  Committing an unverified raster — or worse, a mockup dressed as a screenshot —
  is more damaging than the absence. If a capture is genuinely produced later,
  place it under the try-it block with the Reef caption; until then the Reef
  *link* carries the credibility (fix #3).
- **Publishing to npm, or writing the site as though it were published.** Every
  package is `"private": true`. The pre-release statement stays exactly as it is.
- **A `@ripple/react` package.** Does not exist; the honest framing (an owned
  gap, one copied file) is in fix #20.
- **Editing `examples/todos/src/db.ts`** to change the `8787` fallback. The
  fallback is unreachable under `dev:todos`, and the docs-only fix (print the
  file as it reads, delete the apology) costs nothing and touches no source.
- **A license, a maintainer bio, a version badge, or a "48 tests, all green"
  style claim.** No LICENSE file exists; only the one verifiable line in fix #24.
- **Rewriting `reference/client-api.md` from tables into per-symbol sections**
  (cycle-1 fix #13). Real, still open, and far larger than cycle 2's budget; it
  affects readers already past the conversion decision.
- **`llms.txt` / "copy as Markdown"** (cycle-1 fix #15). Worth doing, not a
  conversion lever this cycle.
- **Any IA restructure.** Cycle 1 just moved these pages; churn now costs more
  than it returns.
- **Claiming Reef demonstrates cross-connection live updates locally.**
  `examples/reef/README.md` carries the same miniflare limitation as todos.

## 6. Post-workflow notes (orchestrator)

- The ground-truth "addendum" agent lost its connection mid-run; the **Post-rebase addendum
  (after #30)** in `shipped-api.md` was written by hand afterwards from `f0f436f`, `NavQuery.ts`,
  `Db.ts` and `docs/QUERY.md`, and §5.5 / §5.6 / §11.4–5 were marked superseded. The accuracy
  lens caught the stale claims independently, so the sweep landed regardless.
- Judges scored the rebuilt site 8 (stranger) / 7 (accuracy). Polish resolved every severity ≥ 2
  residual; one regression report (mobile hero width "dead" CSS) was verified false — Starlight's
  hero rules are inside `@layer starlight.core`, so the unlayered `theme.css` rule wins.
- Fixed after the judges: the Reef screenshot caption said "every column is one `db.live`
  query" — the whole board is one `db.live(boardQuery)` stream (`examples/reef/src/app/components/Board.tsx:2`).
- Left open, deliberately: the landing renders ~1,850 words (~700 in code frames) against the
  plan's 1,450 target. The additions that pushed it over (Reef screenshot, the grown catalog the
  policy frame needs, the DO+SQLite comparison row) each answer a top-ranked finding, so length
  is now a taste call rather than a defect. Also a brand call: the header lockup now reads
  "Ripple" instead of "ripplegraph.ai" (`SiteTitle.astro`, `astro.config.mjs` title) — one-line
  revert if the domain-as-brand was intentional.
