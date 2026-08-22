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
  Attr,
  Catalog,
  type Eid,
  type Equal,
  type Expect,
  type Extends,
  Namespace,
  Policy as P,
  Query,
  Ref,
} from "../../src/db/internal.ts";
import type { Var } from "../../src/db/query/kernel.ts";

const User = Namespace("user", {
  sub: Attr(Schema.String, { unique: "identity" }),
  age: Attr(Schema.Number),
});
const Org = Namespace("org", { members: Attr(Ref, { cardinality: "many" }) });
const Doc = Namespace("doc", { title: Attr(Schema.String), owner: Attr(Ref) });
const App = Catalog({ user: User, org: Org, doc: Doc });

const Other = Namespace("other", { sub: Attr(Schema.String) });

// ── claims ─────────────────────────────────────────────────────────────────

type _claimSub = Expect<Equal<typeof P.claims.sub, P.ClaimOperand>>;
type _claimsShape = Expect<
  Extends<
    P.Claims,
    {
      readonly iss: string;
      readonly sub: string;
      readonly aud: string;
      readonly exp: number;
      readonly ramose: { readonly db: string; readonly class: string };
    }
  >
>;

const typedClaims = P.claimsOf(Schema.Struct({ org: Schema.String }));
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
  P.policy({ catalog: App, principal: User.sub, classes: ["anonymous", "member"] }, {
    doc: { read: (me) => Query.is(Doc.owner, me) },
  });

  // record-form class gate: `me` is still contextually typed
  P.policy({ catalog: App, principal: User.sub, classes: ["member"] }, {
    doc: { read: { class: "member", rule: (me) => Query.is(Doc.owner, me) } },
  });

  P.policy({ catalog: App, principal: User.sub, classes: ["member"] }, {
    // @ts-expect-error — "nope" is not a catalog namespace key
    nope: { read: P.class("member") },
  });

  P.policy(
    {
      catalog: App,
      // @ts-expect-error — :other/sub is not a catalog ident
      principal: Other.sub,
      classes: ["member"],
    },
    {},
  );

  const pol = P.policy({ catalog: App, principal: User.sub, classes: ["member"] }, {
    doc: { read: P.class("member") },
  });
  type _catalog = Expect<Equal<(typeof pol)["catalog"], typeof App>>;
  const json: string = P.compile(pol, { pulls: [{ title: Doc.title }] });
  return json;
};

test("policy type fixtures compile", () => {
  void _fixtures;
});
