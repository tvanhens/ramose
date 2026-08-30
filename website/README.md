# ramose.ai

The Ramose documentation site uses Astro and Starlight and is deployed to
Cloudflare with Alchemy. Public pages live in `src/content/docs`.

## Develop and verify

From the repository root, install dependencies with `bun install`. Then:

```sh
cd website
bun run dev
bun run check
bun run build
bun run preview
```

`bun run check` validates page structure, terminology, links, images, cited
source snippets, and documented exports and errors.

## Deploy

```sh
bun alchemy deploy website/alchemy.run.ts
bun alchemy deploy website/alchemy.run.ts --stage prod
bun alchemy destroy website/alchemy.run.ts
```

Deployment requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
`RAMOSE_DOCS_DOMAIN` overrides the configured hostname.
