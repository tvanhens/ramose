# Cycle 2 — Landing plan

**Owner:** the Landing agent. Files you own: `website/src/content/docs/index.mdx`,
`website/src/styles/theme.css`, `website/src/components/*`, `website/public/*`,
the og script, and `website/astro.config.mjs` **except the sidebar array** (the
Docs agent owns that). Touch nothing else.

**Budget:** the landing is 1,523 rendered words today. It must come out
**shorter** — target ≤ 1,450. Every addition below is paired with a cut. If you
run out of budget, drop items 13–16 before dropping items 1–8.

**Hard rules:** no invented API, flag, package or feature. Every claim below has
been verified against `packages/` or `examples/` in cycle 2; do not extend it.

---

## 1. Hero (frontmatter, `index.mdx:2-7`) — name the product, drop the overclaim

Replace `title`, `description` and `hero.title` / `hero.tagline` with exactly:

```yaml
title: Ripple — the typed, realtime database for Cloudflare
description: Ripple is a typed, realtime database for apps you ship on Cloudflare. Write TypeScript, get queries that update themselves and per-user permissions, all running in your own Cloudflare account.
hero:
  title: Ripple — the typed, realtime database for Cloudflare
  tagline: Define your schema in TypeScript. Queries update themselves as data changes, every user only sees their own rows, and one deploy puts it all in your own Cloudflare account.
```

Why: the visible hero never contained the word "Ripple" (first rendered
occurrence was inside the pre-release caveat), and "there is no server to run" is
contradicted by the page's own "How it works" band, by the quickstart's step 2,
and by `guides/before-production.md`. The `description` carried the same phrase
and must change with it.

CSS, `theme.css:88-91`:

```css
.hero h1 {
  letter-spacing: -0.03em;
  max-width: 22ch;   /* was 18ch — the title now sets in 2–3 lines, not 4 */
}
```

Keep the hero illustration and its `one tab` / `another tab` labels. Do not
relabel them "another user" — different sign-ins are exactly what does **not**
propagate under the local emulator.

## 2. Mobile hero order — highest-value CSS change on the page

Starlight's `.hero > .hero-html` is `width: min(70%, 20rem)` unconditionally and
only gets `order: 2` inside `@media (min-width: 50rem)`, and the illustration is
the first DOM child of `.hero`. On a phone the first ~200 px of the page is an
`aria-hidden` diagram and the H1 is pushed down. Add next to the existing hero
rules in `theme.css` (Starlight's rules use `:where()`, so a plain selector
wins):

```css
@media (max-width: 49.99rem) {
  .hero > .hero-html {
    order: 2;
    width: min(100%, 22rem);
  }
}
```

## 3. Try-it band (`index.mdx:39-59`) — the highest-leverage pixels

Replace the whole `sh` fence with **exactly** this (note `wrap`, which stops the
57-char clone line scrolling sideways on a 375 px viewport):

````md
```sh title="From the repository root" frame="terminal" wrap
git clone https://github.com/tvanhens/ripple && cd ripple
bun install
bun run dev:todos     # peer on :1337, app on :5173
```
````

Trim `rg-run-note` (`:43`) to one sentence — the second half is now redundant
with the block:

```html
<p class="rg-run-note"><strong>Ripple is pre-release and not on npm yet</strong> — you run it from the repository. One command starts the database and the app together.</p>
```

Replace the `rg-run-after` paragraph (`:57`) with — **this exact two-tab
wording, which the Docs agent reuses verbatim in `quickstart.mdx` and
`live-queries.md`**:

```html
<p class="rg-run-after">Open <code>http://localhost:5173</code> and add a todo. The list re-renders from the database and there is no refetch call anywhere in the app — that is <code>db.live</code>, working locally. <span class="rg-caveat">On the local emulator writes do not propagate between isolates, so a second tab picks them up on reload; your own tab always updates, and against a deployed peer every connected client does.</span></p>
```

Then add the Reef pointer as a new paragraph immediately after, inside the same
`rg-band`:

```html
<p class="rg-run-more">Want the bigger one? <code>bun run dev:reef</code> boots <a href="https://github.com/tvanhens/ripple/tree/master/examples/reef">Reef</a> — a Linear-style, multi-tenant issue tracker where every workspace is its own database, with Better Auth JWTs and a compiled policy.</p>
```

CSS for the new class (match `.rg-run-after`'s size, one step dimmer is fine but
**not** `gray-4`):

```css
.rg-run-more {
  margin: 0.75rem 0 0;
  font-size: 0.9375rem;
  color: var(--sl-color-gray-3);
}
```

Keep the eyebrow "Try it in two minutes" unchanged — the Docs agent is bringing
the quickstart down to match it.

## 4. Contrast (`theme.css`)

`--sl-color-gray-4` (`#6c6a61`) on the card ground `#0b0b09` is **3.63:1** —
below AA for 0.875 rem text, and it is the colour of the two sentences that
pre-empt the biggest objections. Change the colour value in these two rules to
`var(--sl-color-gray-3)` (~7.3:1):

- `.rg-moment-copy .rg-aside` (`theme.css:448-450`)
- `.rg-run .rg-caveat` (`theme.css:384-387`)

Leave `gray-4` everywhere else (`.rg-sync-label`, struck illustration rows,
borders).

## 5. Moment 1 — trim, and fold in the cardinality clause

`index.mdx:64-69`: cut the paragraph to three sentences and absorb the one
non-duplicated clause from the benefit card you are about to shorten:

```html
<p>
  A catalog is a plain value: the attributes an entity can carry, their types,
  cardinality, and whether one is unique. The same file is read by your app,
  your Worker, and your deploy — no codegen, no migration step, and changing it
  never rewrites data you already wrote.
</p>
```

## 6. Moment 2 — say "Effect" once, and fix the `useLive` count

Replace the `rg-aside` at `index.mdx:118-122` with:

```html
<p class="rg-aside">
  Ripple is built on <a href="https://effect.website">Effect</a>: a transaction
  is a generator, and <code>await run(…)</code> above is the runtime you set up
  once in the example's <code>db.ts</code>. There is no
  <code>@ripple/react</code> package yet — <a href="https://github.com/tvanhens/ripple/blob/master/examples/todos/src/useLive.ts"><code>useLive</code></a>
  is about a dozen lines you copy once, and it is the only React glue Ripple needs.
</p>
```

Do **not** write "you never touch Effect" — `db.ts` builds a `ManagedRuntime`
and `useLive.ts` uses `Effect.runFork` / `Stream.runForEach` / `Fiber.interrupt`.
Do **not** state a line count; the file is 13 lines with a header that says
twelve.

## 7. Moment 3 — fix the deny-by-default sentence, promote the deploy-time check

Replace the copy paragraph at `index.mdx:161-167` with:

```html
<p>
  One policy says who may read and write each attribute. Reads are filtered
  before they leave the edge, so a query simply returns fewer rows. Writes are
  checked twice — once on the way in, then again by the writer against the exact
  data the transaction would apply to. Deny by default: an operation is allowed
  only if the namespace rule, or the attribute's own rule, allows it, and an
  attribute rule can only narrow its namespace — never widen it.
</p>
<p>
  Because the policy and the shapes your app reads are both values,
  <code>Ripple.Policy.compile</code> checks them against each other at deploy
  time: tighten a rule a screen depends on and the deploy fails, instead of that
  screen quietly going empty for one customer.
</p>
```

("An attribute with no rule is denied" is false — verified in
`packages/core/src/policy/eval.ts`, `allowsOp`: with no attribute rule the
namespace rule alone applies.)

Add three anchor lines in the copy column so the reader knows what the three
frames are, and make the column sticky so the 5fr/7fr grid stops leaving a tall
dead gutter. Add after the paragraphs above, before the `rg-aside`:

```html
<ol class="rg-frames">
  <li>the policy</li>
  <li>what a refused write looks like</li>
  <li>the deploy-time check</li>
</ol>
```

```css
.rg-frames {
  list-style: none;
  margin: 1.25rem 0 0;
  padding: 0;
  display: grid;
  gap: 0.375rem;
  font-size: 0.875rem;
  color: var(--sl-color-gray-3);
  counter-reset: rg-frame;
}
.rg-frames li::before {
  counter-increment: rg-frame;
  content: counter(rg-frame, decimal-leading-zero) " ";
  color: var(--rg-moss);
  font-weight: 600;
}
@media (min-width: 60.0625rem) {
  .rg-moment-copy { position: sticky; top: 5rem; }
}
```

Keep all three code frames, including `alchemy.run.ts` — it is the page's most
differentiating artifact.

## 8. "What you get" — swap the duplicate card for tenancy

Delete the third card entirely (`index.mdx:243-250`, "Every user sees only their
rows") — it repeats moment 3 nearly word for word. Put the tenancy card in its
place, which is the strongest thing on the page a reader cannot get from Convex,
Supabase or Postgres:

```html
  <div class="rg-benefit">
    <h3>One database per customer, for free</h3>
    <p>
      <code>ripple.db("acme", Catalog)</code> is a pure function call — no
      create, no provisioning, no request. One deployed peer serves every name,
      each with its own writer and its own key prefix in storage. Tenant count
      is a namespace, not an ops problem.
      <a href="/concepts/databases-are-names/">How that works →</a>
    </p>
  </div>
```

Also trim card 1 (`:226-232`): its cardinality/uniqueness clause has moved into
moment 1, so cut it to two sentences ending "…not a row in production."

## 9. "Instead of what?" — add the Cloudflare-native row, first

`index.mdx:269-271` lede: delete "on purpose" so it reads "Ripple is small and
pre-release. Here is the honest trade against what you are probably using
today."

Insert as the **first** `rg-vs-row`, before Postgres:

```html
  <div class="rg-vs-row">
    <h3>Durable Objects + SQLite, or D1 + Drizzle</h3>
    <p>The same primitives, already assembled. You stop writing the live fan-out, the per-tenant routing, the migration runner and the authorization middleware, and you keep the account, the pricing and the deploy you already have. What you give up is SQL and hand-tuning the storage layout.</p>
  </div>
```

Add one clause each to the Convex and Supabase rows: after "…instead of a hosted
platform" append "and a database per customer is a function call, not a
deployment."; after "…and they run at the edge" append "A database per tenant
costs one function call."

## 10. Limits — a list, with the throughput escape hatch

Replace the `rg-limits` paragraph (`index.mdx:292-296`) with:

```html
<div class="rg-limits">
  <strong>What Ripple does not have</strong>
  <ul>
    <li>SQL, or joins across databases</li>
    <li>An npm package — you clone the repo</li>
    <li>A hosted dashboard</li>
    <li>An identity provider of its own — bring any issuer with a JWKS endpoint</li>
  </ul>
  <p>Throughput ceiling: low thousands of writes per second, per database. Past that you split into more databases, which is a function call rather than a deployment — and the price is the no-joins line above.</p>
</div>
```

CSS additions:

```css
.rg-limits ul { list-style: none; margin: 0.5rem 0 0; padding: 0; display: grid; gap: 0.375rem; }
.rg-limits p { margin: 0.75rem 0 0; }
```

## 11. "How it works" — fix the durability claim and the fake steps

Lede (`:303`): `Three parts, one deploy: one place commits writes, object
storage keeps every version, and reads run at the edge.` (No left/right or flow
language — the grid wraps to one or two columns on narrow viewports.)

Replace the `01` / `02` / `03` spans with role eyebrows, keeping `.rg-step`
styling: `writes`, `storage`, `reads`.

Rewrite the "Durable storage" body (`:314`) — "A write is in object storage
before your call returns" is false; the ack is durable in the writer's own
SQLite (`packages/transactor/src/transactor.ts`, one group-commit storage write
per batch), and R2 segments are published later by the indexer:

```html
<p>A write is durable in the writer's own storage before your call returns. Immutable segments are published to object storage afterwards and never rewritten, which is exactly why you can still read yesterday.</p>
```

## 12. Closing band (`index.mdx:327-333`)

```html
<div class="rg-closing">
  <p class="rg-eyebrow">Changes ripple.</p>
  <p class="rg-big">Clone it, run the todo app in one command, then run Reef.</p>
  <p class="rg-closing-note">The repository ships 48 test files; <code>bun run test</code> runs the suite across the packages and the example apps.</p>
  <div class="rg-actions">
    <a class="rg-button primary" href="/getting-started/quickstart/">Open the quickstart</a>
    <a class="rg-button secondary" href="https://github.com/tvanhens/ripple/tree/master/examples/reef">See Reef</a>
  </div>
</div>
```

```css
.rg-closing-note { font-size: 0.875rem; color: var(--sl-color-gray-3); margin: 0.75rem 0 0; }
```

Do **not** mention a license, a maintainer or a version — none exist in the repo
to link. Do **not** put a duration in a CTA label; the eyebrow already makes the
one time claim on the page.

Hero primary action label (`index.mdx:9`): `Run it locally`. Leave the secondary
GitHub action as is.

## 13. `og:type` on the home page only

Add to `index.mdx` frontmatter (Starlight's `mergeHead` dedupes by `property`
and page frontmatter wins, so docs pages stay `article`):

```yaml
head:
  - tag: meta
    attrs:
      property: og:type
      content: website
```

Rebuild and confirm `dist/index.html` contains exactly one `og:type`, with value
`website`, and that a docs page still says `article`.

## 14. Reduced motion — unfreeze the stuck dot

`theme.css:257-267`, inside the `@media (prefers-reduced-motion: reduce)` block,
add:

```css
  .rg-sync-wire span {
    top: calc(50% - 0.21875rem);
    opacity: 1;
  }
```

Today `top`/`opacity` exist only in `@keyframes rg-travel`, so with the animation
off the dot renders at the wire's top edge at full opacity — it reads as "the
write got stuck", the opposite of the claim.

## 15. Section order

Unchanged: hero → try-it → three moments → What you get → Instead of what? → How
it works → closing. The "Instead of what?" band is already only one band below
the moments and the benefits band is now shorter, so no reorder is needed. Do
not move sections.

## 16. Before you finish

- `bun run build` in `website/`, then re-count landing words from
  `dist/index.html`: must be **≤ 1,450**.
- Grep the built landing for the phrases that must be gone: `no server to run`,
  `An attribute with no rule is denied`, `in object storage before your call
  returns`, `CLOUDFLARE_API_TOKEN`, `twelve lines`.
- Check `dist/index.html` at 375 px: no horizontal scroll, H1 above the
  illustration.
