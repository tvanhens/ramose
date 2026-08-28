<div align="center">

<a href="https://ramose.ai">
  <img src="./website/public/brand/ramose-lockup-horizontal.svg" alt="Ramose.ai" width="440" />
</a>

<br />
<br />

[![npm](https://img.shields.io/npm/v/ramose?style=flat-square&color=FF6500&label=ramose)](https://www.npmjs.com/package/ramose)
[![license](https://img.shields.io/badge/license-Apache%202.0-FF6500?style=flat-square)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-ramose.ai-FF6500?style=flat-square)](https://ramose.ai)

**The typed database foundation for apps on Cloudflare** — describe schemas,
queries, operations, and authorization in TypeScript, then deploy the
authoritative Worker and storage topology into your account.

[Docs](https://ramose.ai) · [Getting started](https://ramose.ai/getting-started/quickstart/) · [Tour of Reef](https://ramose.ai/getting-started/tour-of-reef/) · [Examples](./examples)

</div>

---

- **A typed schema.** One TypeScript file your app, your rules, and your deploy
  all import. A wrong write is a red squiggle, not a bad row.
- **Portable authoring.** Schemas, queries, pulls, and operation declarations
  are ordinary values shared by application and server code.
- **Permissions in the database.** Who may read or write each field is checked
  on the server, deny by default — not middleware you remember to add.
- **A database per customer.** One deployed peer owns many isolated database
  names without provisioning another Worker for each customer.
- **Nothing overwritten.** Every version is kept; read the database as it was
  at any earlier point in time.
- **Your Cloudflare account.** One Worker, Durable Objects, and R2, deployed
  with [Alchemy](https://alchemy.run). No Ramose bill, no dashboard, no
  managed service.

```sh
bun add ramose effect@rc
```

`effect` is a required peer because operation input and output codecs are
Effect Schemas. `alchemy` comes with Ramose for deploys. Apps using
`ramose/better-auth` also need `better-auth` and `zod`.

## Learn more

- [What is Ramose?](https://ramose.ai/getting-started/introduction/) — the one-minute version
- [Getting started](https://ramose.ai/getting-started/quickstart/) — define and deploy a typed database
- [Tour of Reef](https://ramose.ai/getting-started/tour-of-reef/) — a multi-tenant issue tracker whose whole backend is 680 lines
- [How it compares](https://ramose.ai/getting-started/compare/) — against Convex, Supabase, Instant, Firebase, and D1
- [Examples](./examples) — runnable apps in this repository

> **Ramose is pre-release.** The API moves between releases, so pin exact
> versions. Issues and pull requests are welcome.

## Contributing

Ramose itself is a Bun monorepo — `bun install && bun run test`. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for unit vs local vs Cloudflare e2e.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
