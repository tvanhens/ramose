# Cycle 1 — landing page rebuild plan

Owner: landing agent. Scope: `src/content/docs/index.mdx`, `src/styles/theme.css`,
`src/components/*`, `public/*`, `src/assets/*`, `astro.config.mjs` (everything except the
`sidebar:` array). Fixes taken from `cycle-1.md`: **1, 2, 3 (no images available), 4, 8, 9, 14**.

## Plan

1. **Structure** — drop the hand-rolled `.rg-hero` + the `main:has(.rg-hero)` h1-hiding hack
   (F3.5). Use Starlight `template: splash` + `hero` frontmatter so there is exactly one `<h1>`.
   Frontmatter `title` carries the word "Ripple" so `<title>` and `og:title` do (F3.6).
2. **Hero** (fix 1) — H1 = category + payoff, subhead ≤25 words covering typed schema, live
   queries, per-user permissions, nothing to operate. No unexplained proper nouns above the
   fold: no Datalog / Durable Object / R2 / Effect / EAV / datom / transactor / segment tree.
   Right-hand column is a pure-CSS "two tabs stay in sync" illustration — no fake screenshot
   (fix 3, as far as it can go without images).
3. **Try it** (fix 4) — the fake `› ripple.db(...)` strip becomes the real repo command block
   from `examples/todos/README.md` (port **1337**, env vars inlined) plus an explicit
   "not on npm yet" line.
4. **Three code moments** (fix 2) — real snippets, each fence with `title=`:
   (a) typed catalog + a write that does not compile, (b) `Ripple.query` + `db.live`,
   (c) `Ripple.Policy` rule + what a denial returns (`Unauthorized` 403 at ingress,
   `TxRejected` at the writer) + `Policy.compile(policy, { pulls })` as a deploy-time leak check.
   Catalog is extended once with `user` + `todo/owner` so all three moments type-check together.
5. **Benefits** (fix 9) — four outcome-titled cells, two of them lead-sized, each with one
   precise mechanism subline. "Effect-native", "Invariants as product", "requirements channel
   is `never`", "teardown is fiber interruption" are gone.
6. **Instead of what** — compact 4-row honest strip (Postgres+ORM / Convex / Supabase /
   Instant) plus a one-line list of what Ripple does not have.
7. **How it works** (fix 8) — "The shape of a deployment." replaced by three plain boxes
   (one writer / durable storage / readers at the edge) linking to `/concepts/architecture/`.
8. **Closing CTA** — "Changes ripple." survives here only, as a small eyebrow.
9. **Design / ship polish** (fix 14) — brand-coherent code theme (`everforest-dark`: sand
   foreground, moss strings) replacing `github-dark`; visible surfaces instead of 1px
   hairlines on void; varied section widths and backgrounds; `og.png` generated at 1200×630
   with `sharp` and wired through Starlight `head`.

## Verification

`bun run build` clean, then re-read `dist/index.html` as a stranger against the five hats.
