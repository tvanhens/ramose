---
title: Auth and policy
description: The full policy reference — modes, claims, combinators, how rules combine, and exactly where each check runs.
---

This page is the deep reference for Ripple's authorization layer. If you have
not written a policy yet, start with [Permissions in 10
minutes](/guides/permissions/) and come back for the details.

Ripple verifies tokens; it never issues them. Signing, login, refresh, and
identity-provider integration belong to your auth provider.

## Modes

| mode | environment | who gets in |
| --- | --- | --- |
| Open | neither variable set | everyone, as a full-rights service caller |
| Shared token | `RIPPLE_TOKEN` | one bearer token, full rights on every database |
| Policy | `RIPPLE_POLICY` plus a verifier | JWT-verified callers, each bound to one database |

Under a policy, `RIPPLE_TOKEN`'s holder is given the class `$token`, which no
policy can declare, so every rule denies it; it reaches `/health` and the
no-op schema case only. A configured policy also disables the demo console the
peer serves at `/`.

Three class names carry special meaning:

| class | meaning |
| --- | --- |
| `admin` | **skips every check** — the filtered read path and both write checks are bypassed. Also the only class allowed to call `explain` and the `/admin/*` routes |
| `anonymous` | a caller with no token gets this class, and only if the policy declares it. Otherwise tokenless requests are `Unauthorized` |
| `$token` | assigned to the `RIPPLE_TOKEN` holder under a policy; undeclarable, so it can do nothing |

## The token

```json title="a decoded Ripple JWT"
{
  "iss": "https://auth.acme.example",
  "sub": "user_01HQ8ZK",
  "aud": "ripple:peer:prod",
  "exp": 1755500000,
  "ripple": { "db": "acme", "class": "member", "attrs": { "org": "org_42" } }
}
```

- `iss` must be in `RIPPLE_JWT_ISS`; `aud` must equal `RIPPLE_JWT_AUD`;
  `exp - iat` is capped by `RIPPLE_JWT_MAX_TTL` (900 seconds by default).
- Signature algorithms are pinned to RS256, ES256, and EdDSA — never taken
  from the token's own header.
- `ripple.db` must equal the database in the request path. A token is bound to
  one database; it cannot be pointed at another with a query parameter.
- `ripple.class` must be a class the policy declares, or the request is
  `Unauthorized`.
- `ripple.attrs` carries your app's own claims, shaped by the policy's
  `claims` struct and readable in rules as `P.claims.attrs.<key>`.

Verified principals are memoized per isolate for 60 seconds.

## Combinators

`Ripple.Policy` is deploy-time only: import it from `@ripple/alchemy`, not
from `@ripple/alchemy/db`.

| combinator | means |
| --- | --- |
| `P.policy(catalog, spec)` | build and validate a policy against its catalog |
| `P.allow(expr)` / `P.deny(expr)` | one arm of one operation |
| `P.eq(attr, value)` | a fact `[e attr value]` exists; on a many-valued attribute, membership |
| `P.ref(refAttr, target)` | follow the reference and evaluate `target` there; nesting depth ≤ 3 |
| `P.class(c)` | the caller's class is `c` |
| `P.and` / `P.or` / `P.not` | boolean composition inside one arm |
| `P.constant(true \| false)` | a fixed verdict |
| `P.principal` | the caller's resolved entity |
| `P.lit(value)` | an explicit literal (bare values are wrapped for you) |
| `P.claims` | `.sub` `.iss` `.aud` `.exp` `.attrs.<key>` |
| `P.claimsOf(struct)` | the same accessor, typed by your claims struct |
| `P.preset(attr, operand)` | the peer sets `attr` itself on create; a client-supplied value is refused |
| `P.attr(a, rules)` | an attribute rule, which only ever narrows its namespace rule |
| `P.compile(policy, { pulls })` | lower to the JSON the Worker reads, checking pull patterns |
| `P.checkPulls(policy, pulls)` | the same pull check on its own |
| `P.Claims` | the JWT struct Ripple verifies |

The five operations are `read`, `add`, `retract`, `retractEntity`, and
`create` — `create` being the first `add` for an entity that has no facts yet.
`asOf` and `history` are `read`; there is no separate history operation.

`P.policy` validates at deploy time and throws on: an ident that is not in the
catalog, a class that is not declared, a namespace key the catalog does not
have, an attribute or preset outside its namespace's prefix, empty or
duplicated classes, and reference nesting deeper than three.

## A larger policy

This is the repository's own worked example (`docs/AUTH_LAYER.md`) — documents
owned by users, shared through projects and organizations:

```ts title="policy.ts"
import * as Ripple from "@ripple/alchemy";
import * as Schema from "effect/Schema";

const User = Ripple.Namespace("user", {
  sub: Ripple.Attr(Schema.String, { unique: "identity" }),
});
const Org = Ripple.Namespace("org", {
  members: Ripple.Attr(Ripple.Ref(() => User), { cardinality: "many" }),
});
const Project = Ripple.Namespace("project", {
  org: Ripple.Attr(Ripple.Ref(() => Org)),
});
const Doc = Ripple.Namespace("doc", {
  title: Ripple.Attr(Schema.String),
  owner: Ripple.Attr(Ripple.Ref(() => User)),
  project: Ripple.Attr(Ripple.Ref(() => Project)),
  audit: Ripple.Attr(Schema.String),
});

export const App = Ripple.Catalog({
  user: User,
  org: Org,
  project: Project,
  doc: Doc,
});

const P = Ripple.Policy;
// doc → project → org → members contains the caller
const inOrg = P.ref(Doc.project, P.ref(Project.org, Org.members));

export const policy = P.policy(App, {
  principal: User.sub,
  classes: ["anonymous", "member", "admin"],
  claims: Schema.Struct({ org: Schema.String }), // shape of `ripple.attrs`
  ns: {
    doc: {
      read: P.allow(P.or(P.eq(Doc.owner, P.principal), inOrg)),
      create: P.allow(inOrg), // the parent reference is asserted in the same write
      add: P.allow(P.eq(Doc.owner, P.principal)),
      retract: P.allow(P.eq(Doc.owner, P.principal)),
      retractEntity: P.allow(P.eq(Doc.owner, P.principal)),
      preset: [P.preset(Doc.owner, P.principal)],
      attrs: [P.attr(Doc.audit, { read: P.allow(P.class("admin")) })],
    },
    project: { read: P.allow(P.ref(Project.org, Org.members)) },
    org: { read: P.allow(P.eq(Org.members, P.principal)) },
    user: { read: P.allow(P.eq(User.sub, P.claims.sub)) },
  },
});
```

Membership, ownership, and sharing are facts in the database, not claims in
the token. Revoking access is a write, and it takes effect on the next version
of the database — you never wait for a token to expire.

## How rules combine

Rules attach to attributes. A namespace rule is shorthand for "every attribute
the catalog declares under this prefix", so an attribute you add later inherits
it instead of becoming world-readable.

| situation | verdict |
| --- | --- |
| the namespace has no rule for this operation | **denied** |
| one `allow` arm holds | allowed |
| several `allow` arms, any one holds | allowed |
| a `deny` arm holds | **denied**, whatever the allow arms say |
| an attribute rule and its namespace rule | both must allow — the attribute rule only narrows |

Four one-liners, with the verdict:

```ts title="policy.ts"
// 1. no rule at all for :doc/* → nothing about a document is readable
ns: { }

// 2. one arm: the owner may read their own documents
ns: { doc: { read: P.allow(P.eq(Doc.owner, P.principal)) } }

// 3. two arms: the owner *or* anyone in the document's org may read it
ns: { doc: { read: [P.allow(P.eq(Doc.owner, P.principal)), P.allow(inOrg)] } }

// 4. narrowed: everything above, except :doc/audit, which is admins only
ns: {
  doc: {
    read: P.allow(P.or(P.eq(Doc.owner, P.principal), inOrg)),
    attrs: [P.attr(Doc.audit, { read: P.allow(P.class("admin")) })],
  },
}
```

## Where the checks run

**Reads become a filtered database.** The peer builds the view at the
requested version and wraps it: a fact `[e a v t]` is visible only if the read
rule for `a` holds for `e`. The query engine, `pull`, and `live` all reach
storage through that wrapper, so coverage is structural rather than
remembered. Rules themselves evaluate against the *unfiltered* data — a rule
may follow `:doc/owner` even when the caller cannot read it — and always at the
current version, so a retracted grant cannot be resurrected by reading the
past.

**Writes are checked twice.**

| stage | where | on refusal |
| --- | --- | --- |
| pre-check | Worker ingress, against a possibly stale view | `Unauthorized`, HTTP 403, with `code` and the attribute |
| authority | inside the writer's commit loop, after upserts, `retractEntity` expansion, and implicit retractions are resolved | `TxRejected`, HTTP 409, and no version number is consumed |

The pre-check is best-effort: it exists to fail fast and can occasionally
refuse a write the commit loop would have allowed. The commit loop is the
authority, and it sees the exact data the write applies to.

**Refusals do not leak values.** A filtered list is simply shorter, possibly
empty, and never an error. A masked fact is absent from a `pull` result; if it
was requested as a required field, the client drops the row and `db.pull`
resolves to `null` — indistinguishable from an entity that does not exist. A
refused write names the attribute and a code, never a value.

**Ripple fails closed.** A malformed policy, or a policy with an incomplete
verifier, denies every database request and logs once at startup; the writer
substitutes a deny-everything policy rather than falling open.

:::caution[Required pulls of masked attributes]
Because a masked required field removes the whole row, hand your pull patterns
to the compiler: `Ripple.Policy.compile(policy, { pulls: [shapeA, shapeB] })`
fails the deploy with the offending key. Called without `pulls`, `compile`
skips the check entirely.
:::

## Wiring it up

```ts title="alchemy.run.ts"
import * as Ripple from "@ripple/alchemy";
import { policy } from "./policy.ts";
import { docShape } from "./src/queries.ts";

const auth: Ripple.PeerAuth = {
  policy: Ripple.Policy.compile(policy, { pulls: [docShape] }),
  jwksUrl: process.env.RIPPLE_JWKS_URL,
  issuers: process.env.RIPPLE_JWT_ISS, // one, or comma-separated
  aud: process.env.RIPPLE_JWT_AUD,
  maxTtl: Number(process.env.RIPPLE_JWT_MAX_TTL ?? 900),
  allowedOrigins: process.env.RIPPLE_ALLOWED_ORIGINS,
  // only a configured policy arms the Worker→writer gate; pin the secret so it
  // does not change on every deploy
  internalSecret:
    process.env.RIPPLE_POLICY === undefined
      ? undefined
      : Ripple.internalSecret(process.env.RIPPLE_INTERNAL_SECRET),
};
```

Spread `...Ripple.authEnv(auth)` into the peer Worker's `env`, and pass the
same `auth` object to `Ripple.Server`. The Server does not push the
environment onto the Worker for you; it uses `auth` for a deploy-time check
that fails the deploy when a policy is set without `jwksUrl`, `issuers`, or
`aud`.

Leaving `internalSecret` unpinned mints a fresh random secret on every deploy.
That is harmless in the single-script layout the examples use, but pin it once
you split the Worker out.

Every variable is listed in the [configuration
reference](/reference/configuration/).

## Limits worth knowing

- **One policy per deployed Worker**, over one catalog. Per-database policy
  variants are not supported today.
- **No cross-database rules.** A rule can only follow references inside the
  database it is evaluating.
- **`estimate` is not policy-filtered**, and both 413 bodies and timing
  headers remain a known, unclosed side channel about data you cannot read.
- **Reference nesting is capped at depth 3**, which bounds the cost of a rule.
