# Launch checklist — what the site still hedges on

Two of the four items here are done. The repository is public and the package is
on npm, so the "not published yet" hedges and the `git clone`-only install path
are gone from the site; `getting-started/first-app.mdx` was folded into the
Quickstart, which now builds an app from an empty folder against the published
package. It is a single `ramose` package, so every install line on the site
is one `bun add`.

```sh
grep -rni "not on npm yet\|not published yet\|unpublished" website/src/content/docs
cd website && bun run check     # must stay at 0 errors after every edit
```

## 1. When the LICENSE lands on the default branch

`release/npm-publishing` adds Apache-2.0. The landing page's trust strip
(`index.mdx`, `.rg-trust`) deliberately names no license, because there is no
LICENSE file on `master` yet. Once there is, add it:

> Pre-release · Apache-2.0 · no Ramose bill … · 669 tests …

## 2. Standing facts the site depends on

Re-check these when the code changes; each is asserted on several pages.

- **669 tests, 65 files** — `index.mdx` trust strip. Re-run `bun run test`.
- **Reef's backend is 680 lines** — `getting-started/tour-of-reef.mdx`.
  `cat examples/reef/src/domain/*.ts examples/reef/src/infra/*.ts examples/reef/alchemy.run.ts | wc -l`
- **166–879 writes/second** — five pages, always attributed to `bench/RESULTS.md`.
- **Ports 1337 / 1338 / 5173** — `examples/reef/src/domain/shared.ts`.
  Note `examples/todos/src/db.ts:17` still falls back to the dead `:8787`; the
  docs say so out loud. Fixing the example retires that sentence.
