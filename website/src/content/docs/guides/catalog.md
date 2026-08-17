---
title: Define your data
description: The catalog is your schema — attributes, uniqueness, cardinality, and references in plain TypeScript, checked when you build.
---

Your data model lives in one TypeScript file. You get autocomplete on every
attribute, a compile error when you write the wrong type, and no code
generation step to run. That file is the catalog, and the deploy script, the
browser, and any server code all import the same one.

The Quickstart's app ships this catalog:

```ts title="examples/todos/schema.ts"
import * as Ripple from "@ripple/alchemy/db";
import * as Schema from "effect/Schema";

export const Todo = Ripple.Namespace("todo", {
  title: Ripple.Attr(Schema.String),
  done: Ripple.Attr(Schema.Boolean),
  createdAt: Ripple.Attr(Ripple.Instant),
});

export const Todos = Ripple.Catalog({ todo: Todo });
```

Three pieces, and that is the whole vocabulary:

- **`Attr`** declares one attribute and the values it accepts.
- **`Namespace`** groups attributes under a prefix. `Todo.title` is
  `:todo/title` on the wire; you always write `Todo.title`.
- **`Catalog`** collects namespaces into the thing a database installs.

The value types come from [Effect Schema](https://effect.website), a runtime
type library — `Schema.String`, `Schema.Boolean`, and so on. Ripple adds a few
of its own for values TypeScript cannot describe on its own, such as
`Ripple.Instant` for a point in time.

## Growing the catalog

The rest of these guides use the same todos catalog with two more attributes
and a second namespace, so the examples have something to filter, sort, and
own. Add them and you have the version every later page assumes:

```ts title="schema.ts"
import * as Ripple from "@ripple/alchemy/db";
import * as Schema from "effect/Schema";

export const User = Ripple.Namespace("user", {
  /** the `sub` claim of your identity provider's token */
  sub: Ripple.Attr(Schema.String, { unique: "identity" }),
  name: Ripple.Attr(Schema.String),
  email: Ripple.Attr(Schema.String, { unique: "identity" }),
});

export const Todo = Ripple.Namespace("todo", {
  title: Ripple.Attr(Schema.String),
  done: Ripple.Attr(Schema.Boolean),
  createdAt: Ripple.Attr(Ripple.Instant),
  due: Ripple.Attr(Ripple.Instant),
  owner: Ripple.Attr(Ripple.Ref(() => User)),
});

export const Todos = Ripple.Catalog({ user: User, todo: Todo });
```

`Ripple.Ref(() => User)` is a reference: `Todo.owner` holds another entity, and
naming the target is what lets a query walk `Todo.owner.name` in one hop. The
arrow function is there so two namespaces can point at each other.

## Value types

Most attributes are ordinary Effect `Schema` values. Ripple ships branded ones
for the database types that cannot be inferred from TypeScript alone:

| schema | stores |
| --- | --- |
| `Ripple.Instant` | a point in time — you pass and receive `Date` |
| `Ripple.Long` | a 64-bit integer (plain `Schema.Number` is a double) |
| `Ripple.Uuid` / `Ripple.UuidString` | a UUID, as bytes or as a string |
| `Ripple.Ref(() => Namespace)` | a reference to an entity of that namespace |
| `Ripple.Ref.self` | a reference to the enclosing namespace (friends of a user) |
| `Ripple.Ref` | an untargeted reference — it stores fine, but queries cannot navigate through it |
| `Ripple.Bytes` | binary data |

:::caution
`String`, `Number`, and `Boolean` are inferred; everything else is not. If you
declare an attribute with a schema Ripple cannot map — a `Schema.Struct`, say —
pass the database type yourself with
`Ripple.Attr(mySchema, { valueType: ":db.type/string" })`, or the call throws
when the module loads.
:::

## Options

```ts title="schema.ts"
export const Todo = Ripple.Namespace("todo", {
  // …
  tags: Ripple.Attr(Schema.String, { cardinality: "many" }),
  notes: Ripple.Attr(Schema.String, { doc: "visible to admins only" }),
});
```

| option | default | effect |
| --- | --- | --- |
| `unique` | none | `"identity"` makes the attribute a key: writing an existing value updates that entity instead of making a new one, and `[User.email, "grace@acme.dev"]` addresses it |
| `cardinality` | `"one"` | `"many"` makes the attribute a set; a second value adds rather than replaces |
| `index` | true when `unique` is set, otherwise false | keeps a value-ordered index, which is what lets you look an entity up by value |
| `isComponent` | `false` | the referenced entity belongs to its parent and is retracted with it |
| `doc` | none | a docstring stored with the attribute |
| `valueType` | inferred | the database type, when it cannot be inferred |

## Types flow out of the catalog

Nothing downstream needs a type annotation:

```ts title="rows.ts"
import * as Ripple from "@ripple/alchemy/db";
import { Todo, Todos, User } from "./schema.ts";

const shape = {
  title: Todo.title,
  due: Todo.due.optional,
  owner: Todo.owner.select({ name: User.name }),
} as const;

export type TodoRow = Ripple.Pull<typeof Todos, typeof shape>;
// { title: string; due: Date | undefined; owner: { name: string } }
```

That type is a fine prop type for a React component: your UI types are your
database types, and they cannot drift.

## Changing a catalog later

Installing a catalog is an idempotent update — `Ripple.Database` does it at
deploy, `db.install()` does it when you mint a tenant (see [A database is a
name](/concepts/databases-are-names/#installing-a-catalog)). Adding attributes
or namespaces is just another install.

There is no destructive migration to fear, because facts are never rewritten:
old data keeps the attribute it was written with, and reads of the past keep
working. Removing an attribute from the catalog does not delete the facts that
used it.

Next: [write some data](/guides/transactions/).
