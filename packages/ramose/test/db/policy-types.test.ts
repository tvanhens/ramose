/**
 * Compile-time fixtures for the typed policy surface.
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused. The fixtures live
 * in an uncalled function so the deploy-time throws stay type-level.
 */

import { test } from "bun:test";
import * as Schema from "effect/Schema";
import {
  Field,
  Schema as DbSchema,
  type Eid,
  type Equal,
  type Expect,
  type Extends,
  Entity,
  Policy as P,
  Query,
  Ref,
  type Claims,
} from "../../src/db/internal.ts";
import type { Var } from "../../src/db/query/kernel.ts";

const User = Entity("user", {
  sub: Field(Schema.String, { unique: "upsert" }),
  age: Field(Schema.Number),
});
const Org = Entity("org", { members: Field(Ref(() => User), { cardinality: "many" }) });
const Doc = Entity("doc", { title: Field(Schema.String), owner: Field(Ref(() => User)) });
const App = DbSchema({ user: User, org: Org, doc: Doc });

const Other = Entity("other", { sub: Field(Schema.String) });

// ── claims ─────────────────────────────────────────────────────────────────

type _claimSub = Expect<Equal<typeof P.claim.sub, P.ClaimOperand>>;
type _claimsShape = Expect<
  Extends<
    {
      readonly iss?: string;
      readonly sub?: string;
      readonly aud?: string | readonly string[];
      readonly exp?: number;
      readonly ramose?: { readonly db?: string; readonly class?: string };
    },
    Claims
  >
>;

const typedClaims = P.claimOf(Schema.Struct({ org: Schema.String }));
type _typedAttrKeys = Expect<Equal<keyof (typeof typedClaims)["attrs"], "org">>;

// ── compile surface ────────────────────────────────────────────────────────

type _compileReturnsJson = Expect<Equal<ReturnType<typeof P.compile>, string>>;

type _me = Expect<Equal<P.PrincipalMe<typeof App, ":user/sub">, P.Me<typeof User>>>;
type _meIsVar = Expect<Extends<P.Me<typeof User>, Var<Eid<typeof User>>>>;

const _fixtures = () => {
  // typed claim keys
  typedClaims.attrs.org;
  // @ts-expect-error — `team` is not a declared claim
  typedClaims.attrs.team;

  // inline arm: `me` is the principal token, no annotation
  P.policy({ schema: App, principal: User.sub, classes: ["anonymous", "member"] }, {
    doc: { read: (me) => Query.is(Doc.owner, me) },
  });

  // record-form class gate: `me` is still contextually typed
  P.policy({ schema: App, principal: User.sub, classes: ["member"] }, {
    doc: { read: { class: "member", rule: (me) => Query.is(Doc.owner, me) } },
  });

  P.policy({ schema: App, principal: User.sub, classes: ["member"] }, {
    // @ts-expect-error — "nope" is not a catalog namespace key
    nope: { read: P.class("member") },
  });

  P.policy(
    {
      schema: App,
      // @ts-expect-error — :other/sub is not a catalog ident
      principal: Other.sub,
      classes: ["member"],
    },
    {},
  );

  const pol = P.policy({ schema: App, principal: User.sub, classes: ["member"] }, {
    doc: { read: P.class("member") },
  });
  type _schema = Expect<Equal<(typeof pol)["schema"], typeof App>>;
  const json: string = P.compile(pol, { pulls: [{ title: Doc.title }] });
  return json;
};

test("policy type fixtures compile", () => {
  void _fixtures;
});
