---
title: Introduction
description: Ripple in one page — the mental model, what it is good for, what it is not, and how to run it today.
---

Ripple is a database for apps you deploy on Cloudflare. You describe your data
in TypeScript, write it through a typed API, and read it with queries that
update themselves when the data changes. Who may read or write each field is
part of the database, not middleware you remember to add.

## The mental model

A Ripple database is a set of **facts**. One fact says one thing: this
**entity** has this **attribute** with this value — todo 17 has the title
`"buy milk"`. You add facts, and nothing is overwritten: renaming that todo
adds a new fact and retires the old one, so last week's answer is still there
when you need it.

Queries ask about facts, live queries keep asking for you, and permissions
decide which facts a person can see. You declare the attributes in a
**catalog** — plain TypeScript, checked by the compiler:

```ts title="schema.ts"
import * as Ripple from "@ripple/alchemy/db";
import * as Schema from "effect/Schema";

export const Todo = Ripple.Namespace("todo", {
  title: Ripple.Attr(Schema.String),
  done: Ripple.Attr(Schema.Boolean),
  createdAt: Ripple.Attr(Ripple.Instant),
});

export const Todos = Ripple.Catalog({ todo: Todo });
```

One file, shared by your deploy script, your Worker, and your browser. Write
the wrong type and the build fails.

## Good fit, bad fit

**Reach for Ripple** on Cloudflare when you want a realtime UI, per-user rules
the database enforces, a free audit trail, and one database per customer
without one deployment per customer.

**Look elsewhere** for analytics over enormous tables, for SQL, for more than a
few thousand writes per second in one database, or for a hosted console: Ripple
has no dashboard and no managed service.

## Status: pre-release

Nothing is published to npm yet: the packages are private and point at
TypeScript source, so today you clone the repository and work inside it. The
Quickstart does that in ten minutes.

## Start here

- [Quickstart](/getting-started/quickstart/) — a running app and a live query.
- [Permissions in 10 minutes](/guides/permissions/) — watch a write get denied.
- [Define your data](/guides/catalog/) — the catalog in full.
