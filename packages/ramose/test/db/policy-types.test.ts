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
  type Equal,
  type Expect,
  type Extends,
  Long,
  Namespace,
  Policy as P,
  Ref,
} from "../../src/db/internal.ts";

const User = Namespace("user", {
  sub: Attr(Schema.String, { unique: "identity" }),
  age: Attr(Long),
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

const _fixtures = () => {
  // eq: a literal must match the attribute's value type
  P.eq(User.age, 41);
  P.eq(User.sub, "user_01HQ8ZK");
  P.eq(User.sub, P.claims.sub);
  P.eq(Doc.owner, P.principal);
  // @ts-expect-error — :user/age is a number, not a string
  P.eq(User.age, "old");
  // @ts-expect-error — :user/sub is a string, not a number
  P.eq(User.sub, 41);

  // typed claim keys
  typedClaims.attrs.org;
  // @ts-expect-error — `team` is not a declared claim
  typedClaims.attrs.team;

  // ref: the first argument must be a :db.type/ref attribute
  P.ref(Doc.owner, Org.members);
  // @ts-expect-error — :user/age is not :db.type/ref
  P.ref(User.age, Org.members);

  P.policy(App, {
    principal: User.sub,
    classes: ["anonymous", "member"],
    ns: { doc: { read: P.allow(P.eq(Doc.owner, P.principal)) } },
  });

  P.policy(App, {
    principal: User.sub,
    classes: ["member"],
    // @ts-expect-error — "nope" is not a catalog namespace key
    ns: { nope: { read: P.allow(P.class("member")) } },
  });

  P.policy(App, {
    // @ts-expect-error — :other/sub is not a catalog ident
    principal: Other.sub,
    classes: ["member"],
    ns: {},
  });

  const pol = P.policy(App, {
    principal: User.sub,
    classes: ["member"],
    ns: { doc: { read: P.allow(P.class("member")) } },
  });
  type _catalog = Expect<Equal<(typeof pol)["catalog"], typeof App>>;
  const json: string = P.compile(pol, { pulls: [{ title: Doc.title }] });
  return json;
};

test("policy type fixtures compile", () => {
  void _fixtures;
});
