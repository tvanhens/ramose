# Cycle 1 — first-hour docs path: plan

Owner: docs agent (getting-started/*, guides/*, concepts/*, `sidebar:` only in
`astro.config.mjs`). Landing page, theme, components, public/ are another agent's.

Source of truth: `website/reviews/shipped-api.md`. Review items owned: 5, 6, 7,
11, 12, 16, and the examples pointer from 15.

## Story the path tells

install → first app running → a typed query → a live query → a permissioned
write that is denied → deploy. No history lesson, no Datomic in the first group.

## Canonical catalog

`examples/todos/schema.ts` ships exactly `todo/{title,done,createdAt}`. That
exact catalog is what Introduction, Quickstart, Write and Live queries use.

The Build pages that need a ref, an optional field or a principal (Define your
data, Query and pull, Permissions) use the *same* catalog grown by two
attributes and a `user` namespace — defined verbatim at the top of
`guides/catalog.md` and repeated where used, and labelled as "you add this,
`examples/todos` does not ship it". No page references an attribute that is not
defined on it or on a page it links by name.

```ts
user:  sub (unique identity), name, email (unique identity)
todo:  title, done, createdAt, due, owner -> Ref(() => User)
```

## Files

| file | action |
|---|---|
| `getting-started/introduction.md` | rewrite: ≤300 words, entity/attribute/fact, one real code block, for/not-for, pre-release status |
| `getting-started/quickstart.mdx` | replace `.md`: `<Steps>`, one command block, port **1337**, verbatim `db.ts`, `title=` on every fence, two-tab live moment (with the honest miniflare caveat), pointer to Permissions |
| `concepts/for-datomic-users.md` | new: the "Datomic, revisited for the edge" material, out of the first-run group |
| `guides/catalog.md` | retitle "Define your data"; canonical catalog + grown version; `title=` fences |
| `guides/transactions.md` | todos catalog; complete snippets; `Entity` has three verbs; tempids are not returned |
| `guides/queries.md` | catalog defined on page; hedging/legacy-builder into `:::note` at top of section; `orderBy` silent no-op + `limit` not bounding server work; drop `docs/QUERY.md` pointer |
| `guides/live-queries.md` | complete snippets; needs a WebSocket (not `ServerBinding`); miniflare caveat; terminal errors incl. `QueryBudgetExceeded` |
| `guides/permissions.md` | **new**: three modes table first, "Ripple verifies, never issues", one policy, local loop (`RIPPLE_JWKS_JSON` + `jose`, honestly: no minting helper ships), one denied write at both enforcement points, one filtered read, `compile(policy, { pulls })` |
| `guides/auth.md` | keep as the deep reference; fix §12.3, 12.8, 12.9, 12.10; combination rule as a table |
| `guides/workers.md` | fix §12.4 (imports/symbols) and §12.5 (`live` does not work under `ServerBinding`) |
| `guides/before-production.md` | **new**: checklist, every item checked against shipped-api |
| `guides/deploy.md` | link Before production; keep the "open by default" line but make it a caution with the fix |
| `astro.config.mjs` | targeted edit of the `sidebar:` array only |
| `README.md` (root) | minimal: port 1337, guarded token — it has the same two bugs |

## Sidebar

Getting started (Introduction, Quickstart) → Build (Define your data, Write
data, Query and pull, Live queries, Permissions) → Ship (Deploy with Alchemy,
Workers and tenants, Before production) → Concepts (Architecture, A database is
a name, Time travel, For Datomic users, Auth and policy) → Reference
(unchanged) → Examples (two GitHub links, one line each).

## Copy rules applied

Benefits before mechanisms; active voice; no unexplained proper noun in the
first paragraph of any Getting started / Build page; no sentence-fragment
manifesto; roadmap/hedges only inside labelled `:::note` callouts at the top of
the section they qualify.

## Verification

`cd website && bun run build` must pass. Landing page (`index.mdx`,
`theme.css`) belongs to another agent — a failure there is not mine to fix.
