# ramose.ai — the docs site

The static documentation site for Ramose: [Astro](https://astro.build) +
[Starlight](https://starlight.astro.build), branded per the ramose.ai brand
guide (white on deep black, dark-forest panels, one green signal, Manrope as
the Avenir Next web fallback), deployed to Cloudflare with Alchemy — the same
pattern [alchemy.run](https://alchemy.run) uses for its own website.

## Develop

```sh
bun install            # once, at the repo root (website is a workspace)
cd website
bun run dev            # astro dev on http://localhost:4321
```

## Build

```sh
bun run build          # static output in website/dist
bun run preview        # serve the built site locally
```

## Deploy

An assets-only Cloudflare Worker via `alchemy.run.ts` (no server bundle —
Cloudflare's asset layer serves every request, with Starlight's 404.html for
misses):

```sh
bun alchemy deploy website/alchemy.run.ts               # $USER stage
bun alchemy deploy website/alchemy.run.ts --stage prod  # production
bun alchemy destroy website/alchemy.run.ts              # tear a stage down
```

Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (see
`CONTRIBUTING.md`).

PRs that touch `website/` get an automatic preview deployment (stage
`pr-<number>`) with the URL commented on the PR; the preview is destroyed when
the PR closes. Merges to `master` / `main` publish the `prod` stage.

The Cloudflare Worker keeps its original physical name, `ripple-docs`, so the
existing deployment is updated rather than orphaned; its workers.dev hostname
[ripple-docs.tvanhens.workers.dev](https://ripple-docs.tvanhens.workers.dev)
stays live. The public site is **https://ramose.ai** — the default custom
domain in `alchemy.run.ts` (the zone is onboarded in the Cloudflare account;
Alchemy manages the DNS record and certificate). Set `RAMOSE_DOCS_DOMAIN` on
the Development environment to override the hostname. See
`.github/workflows/docs-preview.yml`,
`.github/workflows/docs-publish.yml`, and the "Docs previews" / "Docs
production" sections of `CONTRIBUTING.md`.

## Check

```sh
bun run check            # objective report on every page; exits 1 on errors
bun run check --json     # machine-readable
bun scripts/docs-check.mjs --page guides/catalog
bun scripts/docs-check.mjs --only words|shape|terms|links|images|code
```

`scripts/docs-check.mjs` is the single source of truth for the objective facts
about this site, so that reviews converge instead of arguing about measurement.
It checks, with one fixed definition each:

| check | what it verifies |
| --- | --- |
| `words` | prose and code word counts against the per-page budgets |
| `shape` | frontmatter `title`/`description`, `<Learn>`, `<Next>`, unused component imports, heading order |
| `terms` | banned prose vocabulary (code spans excluded), and that "Datomic" appears only on `concepts/data-model` |
| `links` | every internal link resolves to a real page, and every `#anchor` to a real heading id |
| `images` | every referenced image exists, has alt text and real dimensions; lists unused assets |
| `code` | every fence whose `title` cites a repo file (`path#marker` or `path:N-M`) extracts from source; a mismatch or a missing marker fails |
| `facts` | doc-stated error counts and export tables against `Errors.ts` / the public barrels |

A cited fence is filled from source at build time (`remark-extract-snippets`
in `astro.config.mjs`). The title is the citation; the body may be empty or
must match the extract. Named regions in example files are `// docs:name` …
`// enddocs:name`.

Word counts in particular were hand-counted three different ways during one
review cycle, which is why they now have exactly one definition. Cite the tool,
not a manual count.

`docs-check.mjs` runs on every CI job and fails the build on any ERROR.
Warnings are the Glossary / data-model pages naming the vocabulary they
replace, plus unused `public/` assets. Anything else is new and wants
looking at.

## Layout

| path | contents |
| --- | --- |
| `src/content/docs/` | all pages (Markdown/MDX); `index.mdx` is the landing page |
| `src/styles/theme.css` | the brand theme mapped onto Starlight variables |
| `src/components/` | `SiteTitle` (lockup), `ThemeProvider`/`ThemeSelect` (dark-only) |
| `src/assets/ramose-mark.svg` | the mark (the two-stroke ramose loop) |
| `public/favicon.svg` | micro-use mark (loop only, per the brand guide) |
| `public/reef/` | light-theme product shots; regenerate with `bun scripts/shots/capture.mjs` |
| `astro.config.mjs` | Starlight config: sidebar, edit links, code theme |
| `alchemy.run.ts` | the Cloudflare deploy stack |
