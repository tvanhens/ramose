---
title: Introduction
description: Ramose in one page — the mental model, the packages you install, what it is good for, and what it is not.
---

Ramose is a database for apps you deploy on Cloudflare. You describe your data
in TypeScript, write it through a typed API, and read it with queries that
update themselves when the data changes. Who may read or write each field is
part of the database, not middleware you remember to add.

## Install

```sh
npm install @ramose/alchemy
```

`@ramose/alchemy` is the package. Import `@ramose/alchemy/db` from the
browser, tests, and anything else that should never see the deploy engine.
Import `@ramose/alchemy` from your Alchemy stack for `Server`, `Database`,
and `Policy`. A React app also takes `@ramose/react`. The peer — the Worker
that serves your databases — is `@ramose/worker`: you name it as `main` on a
`Cloudflare.Worker`, you do not copy it into your repo.

`bun add` and `pnpm add` work the same. Ramose is pre-release: expect the API
to still move.

## The mental model

A Ramose database is a set of **facts**. One fact says one thing: this
**entity** has this **attribute** with this value — todo 17 has the title
`"buy milk"`. You add facts, and nothing is overwritten: renaming that todo
adds a new fact and retires the old one, so last week's answer is still there
when you need it.

Queries ask about facts, live queries keep asking for you, and permissions
decide which facts a person can see. You declare the attributes in a
**catalog** — plain TypeScript, checked by the compiler:

```ts title="schema.ts"
import * as Ramose from "@ramose/alchemy/db";
import * as Schema from "effect/Schema";

export const Todo = Ramose.Namespace("todo", {
  title: Ramose.Attr(Schema.String),
  done: Ramose.Attr(Schema.Boolean),
  createdAt: Ramose.Attr(Ramose.Instant),
});

export const Todos = Ramose.Catalog({ todo: Todo });
```

One file, shared by your deploy script, your Worker, and your browser. Write
the wrong type and the build fails.

The **peer** is the Worker that serves your databases — one deploy, any number
of databases.

## Good fit, bad fit

**Reach for Ramose** on Cloudflare when you want a realtime UI, per-user rules
the database enforces, history you can query with `db.asOf` and `db.history`
(bounded by a retention window you set — 20 published roots by default), and
one database per customer without one deployment per customer.

**Look elsewhere** for analytics over enormous tables, for SQL, for more than a
few thousand writes per second in one database, or for a hosted console: Ramose
has no dashboard and no managed service.

**If you are comparing:** Ramose is closest to Convex and Instant in feel —
queries that re-run themselves — and closest to Supabase in that authorization
is part of the database rather than middleware. The difference is that it
deploys into your own Cloudflare account, and a per-customer database is a
function call rather than a provisioning step. The full trade is on the [home
page](/).

## Start here

- [Quickstart](/getting-started/quickstart/) — install the package, stand up a
  local peer, and get a live query.
- [Permissions in 10 minutes](/guides/permissions/) — watch a write get denied.
- [Define your data](/guides/catalog/) — the catalog in full.
- [Reef](https://github.com/tvanhens/ramose/tree/master/examples/reef) — a
  complete example: multi-tenant workspaces, JWT auth and a compiled policy in
  one app.
