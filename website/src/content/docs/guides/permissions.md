---
title: Permissions in 10 minutes
description: One policy, one denied write, one filtered read — how Ripple decides who may see and change each fact.
---

Ripple can decide, per fact, who may read it and who may change it. The rules
live with your catalog, compile at deploy time, and run inside the database —
so a query returns fewer rows rather than trusting your UI to filter, and a
forbidden write is refused rather than logged.

**Ripple verifies tokens; it never issues them.** Bring Clerk, Auth0, WorkOS,
Firebase Auth, or anything else that signs JWTs and publishes public keys.
Ripple checks the signature, the issuer, the audience, and the expiry, then
maps the token onto your rules. Login, refresh, and password reset stay in your
identity provider.

## The three modes

A peer picks its mode from two environment variables. Nothing else changes.

| mode | environment | who gets in |
| --- | --- | --- |
| **Open** | neither set | everyone, with full rights. Correct for your laptop, dangerous anywhere else |
| **Shared token** | `RIPPLE_TOKEN` | one bearer token, full rights on every database. Fits a backend that is itself the authority |
| **Policy** | `RIPPLE_POLICY` (plus a verifier) | every caller presents a JWT; reads are filtered and writes are checked per fact |

Setting `RIPPLE_POLICY` changes the meaning of `RIPPLE_TOKEN`: its holder gets
a class no rule can name, so it reaches `/health` and nothing else. That is
usually the surprise behind "my token stopped working when I turned on
permissions".

## A policy for the todos app

Rules are written against the catalog attributes you already have, using the
[grown todos catalog](/guides/catalog/#growing-the-catalog):

```ts title="policy.ts"
// `Policy` is deploy-time, so it comes from the root entry, not `/db`
import * as Ripple from "@ripple/alchemy";
import { Todo, Todos, User } from "./schema.ts";

const P = Ripple.Policy;

/** this todo belongs to the caller */
const mine = P.eq(Todo.owner, P.principal);

export const policy = P.policy(Todos, {
  // the token's `sub` names the user entity carrying that value
  principal: User.sub,
  classes: ["member", "support"],
  ns: {
    todo: {
      read: P.allow(mine),
      create: P.allow(P.class("member")),
      add: P.allow(mine),
      retract: P.allow(mine),
      retractEntity: P.allow(mine),
      // the server stamps the owner; a client that sends one is refused
      preset: [P.preset(Todo.owner, P.principal)],
    },
    user: {
      read: P.allow(P.eq(User.sub, P.claims.sub)),
      // narrower than the namespace rule above: support staff only
      attrs: [P.attr(User.email, { read: P.allow(P.class("support")) })],
    },
  },
});
```

Read it as: a member may see and change the todos they own; the server decides
who owns a new todo; everyone may read their own user record; only the
`support` class may read an email address.

Two rules of the road:

- **Deny by default.** A namespace with no rule is invisible and unwritable.
  You never have to remember to lock something down; you have to remember to
  open it.
- **The principal is an entity.** `principal: User.sub` means the token's `sub`
  is looked up through `:user/sub`. Write that user row before the caller's
  first todo, or every rule that mentions the principal has nothing to match.

:::caution[`admin` and `anonymous` are magic names]
A token whose class is `admin` skips every check — declare that class only if
you mean it. A caller with no token at all is refused unless your policy
declares a class literally named `anonymous`, which is how you build a
public-read app.
:::

The repository's larger worked example — documents, projects, and org
membership — is on [Auth and policy](/guides/auth/#a-larger-policy).

## Running it locally

Ripple ships no token minter and no CLI, so a local loop is: generate a key
pair, hand the public half to the peer, and sign your own tokens with it. That
is about fifteen lines of [`jose`](https://github.com/panva/jose), and it is
exactly what Ripple's own tests do.

```ts title="scripts/local-jwt.ts"
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const { privateKey, publicKey } = await generateKeyPair("ES256", {
  extractable: true,
});

// 1. the peer's verifier — set this as RIPPLE_JWKS_JSON
console.log(
  JSON.stringify({
    keys: [{ ...(await exportJWK(publicKey)), alg: "ES256", kid: "local" }],
  }),
);

// 2. a token for one user of one database — set this as VITE_RIPPLE_TOKEN
console.log(
  await new SignJWT({ ripple: { db: "todos", class: "member" } })
    .setProtectedHeader({ alg: "ES256", kid: "local" })
    .setIssuer("https://local.test")
    .setAudience("ripple:local")
    .setSubject("user_ada")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey),
);
```

Wire the policy and that key set into the peer Worker:

```ts title="resources.ts"
import * as Ripple from "@ripple/alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { policy } from "./policy.ts";
import { todoDetail } from "./src/queries.ts";

const Store = Cloudflare.R2.Bucket("Store");
const Transactor = Cloudflare.DurableObject("TransactorDO", {
  className: "TransactorDO",
});
const Replica = Cloudflare.DurableObject("QueryReplicaDO", {
  className: "QueryReplicaDO",
});

export const RippleWorker = Cloudflare.Worker("Peer", {
  main: "./packages/worker/src/index.ts",
  compatibility: { date: "2025-06-01", flags: ["nodejs_compat"] },
  env: {
    STORE: Store,
    TRANSACTOR: Transactor,
    REPLICA: Replica,
    ...Ripple.authEnv({
      policy: Ripple.Policy.compile(policy, { pulls: [todoDetail] }),
      issuers: "https://local.test",
      aud: "ripple:local",
    }),
    // local only: a literal key set instead of a URL to fetch
    RIPPLE_JWKS_JSON: process.env.RIPPLE_JWKS_JSON ?? "",
  },
});

export const Server = Ripple.Server("Ripple", { worker: RippleWorker });
```

Then run the app with the token:

```sh title="Terminal 2 — the app"
VITE_RIPPLE_URL=http://localhost:1337 \
  VITE_RIPPLE_TOKEN="$(bun run scripts/local-jwt.ts | tail -1)" \
  bunx vite examples/todos
```

:::note[Deploying, not just running]
Passing `auth` to `Ripple.Server` turns on a deploy-time check: a policy with
no `jwksUrl`, `issuers`, or `aud` fails the deploy rather than silently denying
every request at runtime. The local recipe above uses `RIPPLE_JWKS_JSON`, which
that check does not know about, so it configures the Worker's environment
directly. For a real deployment, publish a JWKS URL and pass the same `auth`
object to both the Worker and `Ripple.Server`.
:::

## What a denial looks like

Writes are checked twice, and the two checks fail differently. Handle both:

```ts title="src/todos.ts"
import * as Effect from "effect/Effect";
import type { Db } from "@ripple/alchemy/db";
import { Todo, type Todos } from "../schema.ts";

export const tryFinish = (db: Db<typeof Todos>, id: number) =>
  db
    .transact(function* (tx) {
      yield* tx.add(id, Todo.done, true);
    })
    .pipe(
      Effect.catchTags({
        // 1. the edge check, before the write is sent: HTTP 403
        Unauthorized: (e) =>
          Effect.succeed(`refused at the edge: ${e.code} on ${e.attr}`),
        // 2. the authority, inside the commit loop: HTTP 409, no version spent
        TxRejected: (e) => Effect.succeed(`refused by the writer: ${e.code}`),
      }),
    );
```

| where | when | you get |
| --- | --- | --- |
| Worker ingress | fast, best-effort, against a slightly stale view | `Unauthorized` (403) carrying `code` and the attribute that failed |
| the commit loop | authoritative, against the exact data the write applies to | `TxRejected` (409); no version number is consumed |

The edge check can occasionally refuse a write the commit loop would have
allowed, when its view of the data is behind. It never allows one the commit
loop would refuse — that check is the authority.

## What a filtered read looks like

Reads do not fail. They shrink.

```ts title="src/reads.ts"
import * as Effect from "effect/Effect";
import type { Db } from "@ripple/alchemy/db";
import type { Todos } from "../schema.ts";
import { openTodos, todoDetail } from "./queries.ts";

export const asAda = (db: Db<typeof Todos>) =>
  Effect.gen(function* () {
    // only Ada's todos come back — no error, just fewer rows
    const rows = yield* db.q(openTodos);
    // a todo owned by someone else, pulled by id
    const other = yield* db.pull({ id: 4242 }, todoDetail); // → null
    return { rows, other };
  });
```

A fact you may not read is simply absent. If you pulled it as a **required**
field, the whole row disappears — `pull` resolves to `null` and a list query
drops that entity. That is deliberate: an error message that distinguishes
"forbidden" from "does not exist" is itself a leak.

## The deploy-time leak check

Because a masked required field deletes the row instead of hiding the field,
Ripple can catch the mistake before it ships — if you hand your pull patterns
to the compiler:

```ts title="resources.ts"
const userCard = { name: User.name, email: User.email } as const;

Ripple.Policy.compile(policy, { pulls: [todoDetail, userCard] });
// ripple/policy: pulls[1].email: :user/email has a narrowed read rule
// and must be pulled as `.optional`
```

The fix is to say what you meant — `email: User.email.optional` — so a caller
without permission sees a row with no email instead of no row at all.

:::caution[The check is opt-in]
`Ripple.Policy.compile(policy)` with no `pulls` skips it entirely. Pass every
shape your app pulls, from one module, so the list cannot fall behind.
:::

## Next

- [Auth and policy](/guides/auth/) — every combinator, how rules combine, and
  what enforcement covers.
- [Before production](/guides/before-production/) — the rest of the checklist:
  origins, token lifetimes, retention, and error handling.
