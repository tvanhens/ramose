/** Typed policy authoring → the compiled AST core parses. No peer I/O. */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { Connection, Index, filterDb, parsePolicy, type CompiledPolicy, type Principal } from "../../src/internal/core/index.ts";
import { checkTx } from "../../src/internal/core/policy/check.ts";
import {
  Field,
  Schema as DbSchema,
  Entity,
  Policy as P,
  PolicyError,
  Q,
  Query,
  Ref,
  stored,
} from "../../src/db/internal.ts";

const User = Entity("user", { sub: Field.unique(Schema.String, "upsert") });
const Org = Entity("org", { members: Field.many(Ref(() => User)) });
const Project = Entity("project", { org: Field(Ref(() => Org)) });
const Doc = Entity("doc", {
  title: Field(Schema.String),
  owner: Field(Ref(() => User)),
  project: Field(Ref(() => Project)),
  audit: Field(Schema.String),
});
const App = DbSchema({ user: User, org: Org, project: Project, doc: Doc });

const Comment = Entity("comment", {
  body: Field(Schema.String),
  doc: Field(Ref(() => Doc)),
  author: Field(Ref(() => User)),
});
const AppComments = DbSchema({ user: User, org: Org, project: Project, doc: Doc, comment: Comment });

/** Handwritten so the FragFn brand does not reject reuse on a second entity. */
const ownDocHand = (me: P.Me<typeof User>) =>
  function* (e: Query.Var) {
    yield* Query.is(Doc.owner, me)(e);
  };

/** doc → project → org → members contains the caller. */
const inOrg = (me: P.Me<typeof User>) =>
  function* (doc: Query.Var) {
    const project = yield* Query.follow(Doc.project)(doc);
    const org = yield* Query.follow(Project.org)(project);
    yield* Query.is(Org.members, me)(org);
  };

const ownDoc = (me: P.Me<typeof User>) => Query.is(Doc.owner, me);

const myself = (me: P.Me<typeof User>) =>
  function* (e: Query.Var) {
    yield* Q.eq(e, me);
    yield* Query.has(User.sub)(e);
  };

const inProjectOrg = (me: P.Me<typeof User>) =>
  function* (project: Query.Var) {
    const org = yield* Query.follow(Project.org)(project);
    yield* Query.is(Org.members, me)(org);
  };

/** The policy reference's example, rewritten as fragments. */
const specPolicy = P.policy(
  {
    schema: App,
    principal: User.sub,
    classes: ["anonymous", "member", "admin"],
    schemaClasses: ["admin"],
    claims: Schema.Struct({ org: Schema.String }),
  },
  {
    doc: {
      read: [ownDoc, inOrg],
      create: inOrg,
      write: ownDoc,
      preset: [P.preset(Doc.owner, P.principal)],
      attrs: [P.field(Doc.audit, P.only("admin"))],
    },
    project: { read: inProjectOrg },
    org: { read: (me) => Query.is(Org.members, me) },
    user: { read: myself },
  },
);

const compiled = (p: P.Policy = specPolicy, opts?: P.CompileOptions): CompiledPolicy =>
  parsePolicy(JSON.parse(P.compile(p, opts)));

const ruleNamed = (c: CompiledPolicy, name: string): unknown[] | undefined =>
  (c.rules as unknown[][] | undefined)?.find((r) => (r[0] as unknown[])[0] === name);

describe("compile", () => {
  test("the spec example round-trips through core's parsePolicy", () => {
    const c = compiled();
    expect(c.version).toBe(2);
    expect(c.principal).toBe(":user/sub");
    expect(c.classes).toEqual(["anonymous", "member", "admin"]);
    expect(c.schemaClasses).toEqual(["admin"]);
    expect(c.superuser).toBeUndefined();
    expect(c.claims).toBeDefined();
    expect(c.rules).toBeDefined();
    expect((c.rules as unknown[]).length).toBeGreaterThan(0);
  });

  test("namespace rules are emitted once, under `ns`", () => {
    const c = compiled();
    expect(Object.keys(c.ns!).sort()).toEqual(["doc", "org", "project", "user"]);
    expect(c.ns!.doc!.read).toBeDefined();
    for (const ident of [":doc/title", ":doc/owner", ":doc/project"]) {
      expect(c.attrs[ident]).toBeUndefined();
    }
  });

  test("an attribute rule is emitted alone; core ANDs it with the namespace rule", () => {
    const c = compiled();
    const owner = [{ _tag: "allow" as const, class: ["admin"], rule: true as const }];
    expect(c.attrs[":doc/audit"]!.read).toEqual(owner);
    expect(c.attrs[":doc/audit"]!.add).toEqual(owner);
    expect(c.attrs[":doc/audit"]!.retract).toEqual(owner);
    expect(c.attrs[":doc/audit"]!.retractEntity).toEqual(owner);
    expect(c.attrs[":doc/audit"]!.create).toEqual(owner);
    expect(c.ns!.doc!.read).not.toEqual(c.attrs[":doc/audit"]!.read);
    expect(Object.keys(c.attrs)).toEqual([":doc/audit"]);
  });

  test("fragment arms promote to named rules with ?me and ?e in the head", () => {
    const c = compiled();
    const read = c.ns!.doc!.read!;
    expect(read).toHaveLength(2);
    expect(read[0]).toEqual({ _tag: "allow", rule: expect.any(String) });
    expect(read[1]).toEqual({ _tag: "allow", rule: expect.any(String) });
    const name = (read[0] as { rule: string }).rule;
    const def = ruleNamed(c, name);
    expect(def).toBeDefined();
    const head = def![0] as unknown[];
    expect(head[0]).toBe(name);
    expect(head).toHaveLength(3);
    expect(typeof head[1]).toBe("string");
    expect(typeof head[2]).toBe("string");
  });

  test("the same fragment is compiled once and reused across verbs", () => {
    const c = compiled();
    const add = (c.ns!.doc!.add![0] as { rule: string }).rule;
    expect(c.ns!.doc!.retract![0]).toEqual({ _tag: "allow", rule: add });
    expect(c.ns!.doc!.retractEntity![0]).toEqual({ _tag: "allow", rule: add });
    expect(c.ns!.doc!.read![0]).toEqual({ _tag: "allow", rule: add });
    const hits = (c.rules as unknown[][]).filter((r) => (r[0] as unknown[])[0] === add);
    expect(hits).toHaveLength(1);
  });

  test("write: expands to add, retract, and retractEntity", () => {
    const p = P.policy(
      { schema: App, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
      { doc: { write: ownDoc } },
    );
    const c = compiled(p);
    const arm = { _tag: "allow" as const, rule: expect.any(String) };
    expect(c.ns!.doc!.add).toEqual([arm]);
    expect(c.ns!.doc!.retract).toEqual(c.ns!.doc!.add);
    expect(c.ns!.doc!.retractEntity).toEqual(c.ns!.doc!.add);
    expect(c.ns!.doc!.create).toBeUndefined();
    expect(c.ns!.doc!.read).toBeUndefined();
    const name = (c.ns!.doc!.add![0] as { rule: string }).rule;
    const hits = (c.rules as unknown[][]).filter((r) => (r[0] as unknown[])[0] === name);
    expect(hits).toHaveLength(1);
  });

  test("P.only puts the same class gate on every op", () => {
    const p = P.policy(
      { schema: App, principal: User.sub, classes: ["admin", "member"], schemaClasses: ["admin"] },
      { doc: { read: true, create: P.class("member"), write: P.class("member"), attrs: [P.field(Doc.audit, P.only("admin"))] } },
    );
    const c = compiled(p);
    const owner = [{ _tag: "allow" as const, class: ["admin"], rule: true as const }];
    expect(c.attrs[":doc/audit"]).toEqual({
      read: owner,
      add: owner,
      retract: owner,
      retractEntity: owner,
      create: owner,
    });
  });

  test("P.only(arm) applies that arm on every op", () => {
    const p = P.policy(
      { schema: App, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
      { doc: { write: ownDoc, create: ownDoc, attrs: [P.field(Doc.audit, P.only(ownDoc))] } },
    );
    const c = compiled(p);
    const name = (c.attrs[":doc/audit"]!.read![0] as { rule: string }).rule;
    const arm = { _tag: "allow" as const, rule: name };
    expect(c.attrs[":doc/audit"]!.add).toEqual([arm]);
    expect(c.attrs[":doc/audit"]!.retract).toEqual([arm]);
    expect(c.attrs[":doc/audit"]!.retractEntity).toEqual([arm]);
    expect(c.attrs[":doc/audit"]!.create).toEqual([arm]);
  });

  test("a follow-chain fragment lowers to joined facts, not a depth-capped ref", () => {
    const c = compiled();
    const name = (c.ns!.doc!.read![1] as { rule: string }).rule;
    const def = ruleNamed(c, name)!;
    const body = JSON.stringify(def.slice(1));
    expect(body).toContain(":doc/project");
    expect(body).toContain(":project/org");
    expect(body).toContain(":org/members");
  });

  test("preset compiles to a principal operand keyed by ident", () => {
    expect(compiled().preset).toEqual({ ":doc/owner": { _tag: "principal" } });
  });

  test("claims lower to an opaque JSON description", () => {
    const c = compiled();
    expect(JSON.stringify(c.claims)).toContain("org");
  });

  test("P.claim.attrs.<key> is a claim under attrs", () => {
    expect(P.claim.attrs.org).toEqual({ _tag: "claim", path: ["attrs", "org"] });
    expect(P.claimOf(Schema.Struct({ org: Schema.String })).attrs.org).toEqual({
      _tag: "claim",
      path: ["attrs", "org"],
    });
  });

  test("true is the empty fragment — public, no rule emitted", () => {
    const only = P.policy(
      { schema: App, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
      { doc: { read: true } },
    );
    const c = compiled(only);
    expect(c.ns!.doc!.read).toEqual([{ _tag: "allow", rule: true }]);
    expect(c.rules).toBeUndefined();
  });

  test("a namespace with no rule is absent — deny by default", () => {
    const only = P.policy(
      { schema: App, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
      { doc: { read: ownDoc } },
    );
    const c = compiled(only);
    expect(c.attrs[":org/members"]).toBeUndefined();
    expect(c.ns!.org).toBeUndefined();
    expect(c.claims).toBeUndefined();
  });
});

describe("deploy-time errors", () => {
  test("omitting superuser and schemaClasses is a PolicyError", () => {
    expect(() =>
      P.policy({ schema: App, principal: User.sub, classes: ["member"] }, { doc: { read: true } }),
    ).toThrow(/no class can install schema/);
  });

  test("empty schemaClasses is a PolicyError", () => {
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"], schemaClasses: [] },
        { doc: { read: true } },
      ),
    ).toThrow(/schemaClasses must not be empty/);
  });

  test("P.class(superuser) is a PolicyError", () => {
    expect(() =>
      P.policy(
        {
          schema: App,
          principal: User.sub,
          classes: ["owner", "member"],
          superuser: "owner",
        },
        // @ts-expect-error — superuser is unreachable in an arm
        { doc: { read: P.class("owner") } },
      ),
    ).toThrow(/unreachable/);
  });

  test("schemaClasses defaults to [superuser] on the wire", () => {
    const p = P.policy(
      {
        schema: App,
        principal: User.sub,
        classes: ["owner", "member"],
        superuser: "owner",
      },
      { doc: { read: P.class("member") } },
    );
    expect(p.superuser).toBe("owner");
    expect(p.schemaClasses).toEqual(["owner"]);
    const c = compiled(p);
    expect(c.superuser).toBe("owner");
    expect(c.schemaClasses).toEqual(["owner"]);
  });

  test("write: plus an explicit write verb is a PolicyError", () => {
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
        // @ts-expect-error — write already names set / remove / delete
        { doc: { write: ownDoc, set: ownDoc } },
      ),
    ).toThrow(/write: expands to set, remove, and delete/);
  });

  test("an undeclared class is a PolicyError", () => {
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
        // @ts-expect-error — "admin" is not a declared class
        { doc: { read: P.class("admin") } },
      ),
    ).toThrow(/not a declared class/);
  });

  test("an attribute outside the catalog is a PolicyError", () => {
    const Other = Entity("other", { thing: Field(Schema.String) });
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
        // @ts-expect-error — :other/thing is not a field of doc
        { doc: { read: () => Query.is(Other.thing, "x") } },
      ),
    ).toThrow(/not in the schema/);
  });

  test("a namespace key outside the catalog is a PolicyError", () => {
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
        // @ts-expect-error — "nope" is not a catalog namespace key
        { nope: { read: P.class("member") } },
      ),
    ).toThrow(/is not in the schema/);
  });

  test("an attribute rule outside its namespace is a PolicyError", () => {
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
        {
          doc: {
            read: P.class("member"),
            attrs: [P.field(Org.members, { read: P.class("member") })],
          },
        },
      ),
    ).toThrow(/not a field of the doc entity/);
  });

  test("a rule that never binds the focus as its entity is a PolicyError", () => {
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
        {
          doc: {
            read: (me) =>
              function* (e: Query.Var) {
                yield* Query.is(Org.members, me)(e);
              },
          },
        },
      ),
    ).toThrow(/never binds the focus as this entity/);
  });

  test("a principal outside the catalog is a PolicyError", () => {
    const Other = Entity("other", { sub: Field(Schema.String) });
    expect(() =>
      P.policy(
        {
          schema: App,
          // @ts-expect-error — :other/sub is not a catalog ident
          principal: Other.sub,
          classes: ["member"],
        },
        {},
      ),
    ).toThrow(/principal :other\/sub is not in the schema/);
  });

  test("a principal entity with an unprovisionable required field is a PolicyError", () => {
    const Named = Entity("user", {
      sub: Field.unique(Schema.String, "upsert"),
      name: Field(Schema.String),
    });
    const Catalog = DbSchema({ user: Named });
    expect(() =>
      P.policy({ schema: Catalog, principal: Named.sub, classes: ["member"] }, {}),
    ).toThrow(PolicyError);
    expect(() =>
      P.policy({ schema: Catalog, principal: Named.sub, classes: ["member"] }, {}),
    ).toThrow(/required field.*:user\/name.*optional: true or first login is tx\/required/);
    expect(() =>
      P.checkPrincipalProvisioning(Catalog, ":user/sub"),
    ).toThrow(/:user\/name/);
  });

  test("a required non-string role is not provisionable", () => {
    const Role = Entity("role", { name: Field(Schema.String) });
    const RefUser = Entity("user", {
      sub: Field.unique(Schema.String, "upsert"),
      role: Field(Ref(() => Role)),
    });
    const RefCatalog = DbSchema({ user: RefUser, role: Role });
    expect(() =>
      P.policy({ schema: RefCatalog, principal: RefUser.sub, classes: ["member"] }, {}),
    ).toThrow(PolicyError);
    expect(() => P.checkPrincipalProvisioning(RefCatalog, ":user/sub")).toThrow(/:user\/role/);

    const Numbered = Entity("user", {
      sub: Field.unique(Schema.String, "upsert"),
      role: Field(Schema.Number),
    });
    const NumberedCatalog = DbSchema({ user: Numbered });
    expect(() =>
      P.checkPrincipalProvisioning(NumberedCatalog, ":user/sub"),
    ).toThrow(/:user\/role/);
  });

  test("principal sub, string role, optional fields, and card-many are provisionable", () => {
    const Account = Entity("user", {
      sub: Field.unique(Schema.String, "upsert"),
      role: Field(Schema.String),
      name: Field(Schema.String, { optional: true }),
      email: Field(stored(Schema.UndefinedOr(Schema.String), "string")),
      tags: Field.many(Schema.String),
    });
    const Catalog = DbSchema({ user: Account });
    expect(() =>
      P.policy({ schema: Catalog, principal: Account.sub, classes: ["member"], schemaClasses: ["member"] }, {}),
    ).not.toThrow();
    expect(() =>
      P.compile(P.policy({ schema: Catalog, principal: Account.sub, classes: ["member"], schemaClasses: ["member"] }, {})),
    ).not.toThrow();
  });

  test("an empty fragment is a PolicyError — public is `true`", () => {
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
        {
          doc: {
            read: () =>
              function* () {
                /* no clauses */
              },
          },
        },
      ),
    ).toThrow(/empty fragment/);
  });

  test("reusing a fragment on a second entity is a PolicyError", () => {
    expect(() =>
      P.policy({ schema: AppComments, principal: User.sub, classes: ["member"], schemaClasses: ["member"] }, {
        doc: { read: ownDocHand },
        comment: { read: ownDocHand },
      }),
    ).toThrow(/ns\.comment\.read: rule never binds the focus as this entity/);
  });

  test("the same fragment on the wrong entity alone is a PolicyError", () => {
    expect(() =>
      P.policy({ schema: AppComments, principal: User.sub, classes: ["member"], schemaClasses: ["member"] }, {
        comment: { read: ownDocHand },
      }),
    ).toThrow(/ns\.comment\.read: rule never binds the focus as this entity/);
  });
});

describe("focus binding — backlink and named rules", () => {
  const commentedByMe = (me: P.Me<typeof User>) =>
    function* (doc: Query.Var) {
      const c = yield* Query.backlink(Comment.doc)(doc);
      yield* Query.is(Comment.author, me)(c);
    };

  const ownedBy = Query.rule("app/ownedBy", function* (doc: Query.Var, owner: Query.Var) {
    yield* Query.is(Doc.owner, owner)(doc);
  });

  const viaNamed = (me: P.Me<typeof User>) =>
    function* (e: Query.Var) {
      yield* ownedBy(e, me);
    };

  const viaSome = (me: P.Me<typeof User>) =>
    function* (e: Query.Var) {
      yield* Query.some(Comment.doc, Query.is(Comment.author, me))(e);
    };

  test("a backlink-bound arm compiles", () => {
    const p = P.policy(
      { schema: AppComments, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
      { doc: { read: commentedByMe } },
    );
    const c = compiled(p);
    const name = (c.ns!.doc!.read![0] as { rule: string }).rule;
    const def = ruleNamed(c, name)!;
    const body = JSON.stringify(def.slice(1));
    expect(body).toContain(":comment/doc");
    expect(body).toContain(":comment/author");
    expect(body).not.toMatch(/:doc\//);
  });

  test("an arm that only invokes a named Query.rule compiles", () => {
    const p = P.policy(
      { schema: AppComments, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
      { doc: { read: viaNamed } },
    );
    const c = compiled(p);
    const name = (c.ns!.doc!.read![0] as { rule: string }).rule;
    const arm = ruleNamed(c, name)!;
    expect(JSON.stringify(arm.slice(1))).toContain("app/ownedBy");
    expect(JSON.stringify(arm.slice(1))).not.toContain(":doc/owner");
    const callee = ruleNamed(c, "app/ownedBy")!;
    expect(JSON.stringify(callee.slice(1))).toContain(":doc/owner");
  });

  test("Query.some over a reverse ref compiles", () => {
    expect(() =>
      P.policy(
        { schema: AppComments, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
        { doc: { read: viaSome } },
      ),
    ).not.toThrow();
  });

  test("Query.some as a FilterStage arm compiles", () => {
    const p = P.policy(
      { schema: AppComments, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
      { doc: { read: (me) => Query.some(Comment.doc, Query.is(Comment.author, me)) } },
    );
    const c = compiled(p);
    const name = (c.ns!.doc!.read![0] as { rule: string }).rule;
    const body = JSON.stringify(ruleNamed(c, name)!.slice(1));
    expect(body).toContain(":comment/doc");
    expect(body).toContain(":comment/author");
  });

  test("byId and updatedSince arms compile", () => {
    expect(() =>
      P.policy({ schema: AppComments, principal: User.sub, classes: ["member"], schemaClasses: ["member"] }, {
        doc: { read: () => Query.byId(1) },
      }),
    ).not.toThrow();
    expect(() =>
      P.policy({ schema: AppComments, principal: User.sub, classes: ["member"], schemaClasses: ["member"] }, {
        doc: { read: () => Query.updatedSince(0) },
      }),
    ).not.toThrow();
  });

  test("a backlink arm grants the docs the caller commented on", async () => {
    const conn = await Connection.create({ now: () => 1_700_000_000_000 });
    await conn.transact([
      { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity", ":db/optional": true },
      { ":db/ident": ":doc/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":comment/body", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":comment/doc", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":comment/author", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);
    const { tempids } = await conn.transact([
      { ":db/id": "alice", ":user/sub": "u_alice" },
      { ":db/id": "bob", ":user/sub": "u_bob" },
      { ":db/id": "d1", ":doc/title": "D1" },
      { ":db/id": "d2", ":doc/title": "D2" },
      { ":db/id": "c1", ":comment/body": "hi", ":comment/doc": "d1", ":comment/author": "alice" },
    ]);
    const db = conn.db();
    const policy = compiled(
      P.policy(
        { schema: AppComments, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
        { doc: { read: commentedByMe } },
      ),
    );
    const who = (sub: string, eid: number): Principal => ({
      kind: "user",
      class: "member",
      sub,
      eid,
      claims: { sub },
      db: "acme",
    });
    const titles = async (p: Principal, e: number) =>
      (await filterDb(db, db, policy, p).datomsArray(Index.EAVT, { e })).map((d) => db.attr(d.a)!.ident);
    expect(await titles(who("u_alice", tempids.alice), tempids.d1)).toEqual([":doc/title"]);
    expect(await titles(who("u_alice", tempids.alice), tempids.d2)).toEqual([]);
    expect(await titles(who("u_bob", tempids.bob), tempids.d1)).toEqual([]);
  });

  test("a named-rule arm grants the owner", async () => {
    const conn = await Connection.create({ now: () => 1_700_000_000_000 });
    await conn.transact([
      { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity", ":db/optional": true },
      { ":db/ident": ":doc/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":doc/owner", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);
    const { tempids } = await conn.transact([
      { ":db/id": "alice", ":user/sub": "u_alice" },
      { ":db/id": "bob", ":user/sub": "u_bob" },
      { ":db/id": "d1", ":doc/title": "D1", ":doc/owner": "alice" },
      { ":db/id": "d2", ":doc/title": "D2", ":doc/owner": "bob" },
    ]);
    const db = conn.db();
    const policy = compiled(
      P.policy(
        { schema: AppComments, principal: User.sub, classes: ["member"], schemaClasses: ["member"] },
        { doc: { read: viaNamed } },
      ),
    );
    const who = (sub: string, eid: number): Principal => ({
      kind: "user",
      class: "member",
      sub,
      eid,
      claims: { sub },
      db: "acme",
    });
    const titles = async (p: Principal, e: number) =>
      (await filterDb(db, db, policy, p).datomsArray(Index.EAVT, { e })).map((d) => db.attr(d.a)!.ident).sort();
    expect(await titles(who("u_alice", tempids.alice), tempids.d1)).toEqual([":doc/owner", ":doc/title"]);
    expect(await titles(who("u_alice", tempids.alice), tempids.d2)).toEqual([]);
  });
});

describe("read narrower than writes", () => {
  const captureWarn = (fn: () => void): string[] => {
    const messages: string[] = [];
    const orig = console.warn;
    console.warn = (message: unknown) => {
      messages.push(String(message));
    };
    try {
      fn();
    } finally {
      console.warn = orig;
    }
    return messages;
  };

  test("compile warns when a field read is narrower than inherited writes", () => {
    const p = P.policy(
      { schema: App, principal: User.sub, classes: ["admin", "member"], schemaClasses: ["admin"] },
      {
        doc: {
          read: true,
          write: P.class("member"),
          attrs: [P.field(Doc.audit, { read: P.class("admin") })],
        },
      },
    );
    expect(P.checkReadWriteMasks(p).join("\n")).toMatch(/:doc\/audit/);
    expect(P.checkReadWriteMasks(p).join("\n")).toMatch(/inherits the namespace/);
    const warned = captureWarn(() => {
      P.compile(p);
    });
    expect(warned.some((m) => m.includes(":doc/audit") && m.includes("narrower"))).toBe(true);
  });

  test("compile does not warn when writes are denied or equally gated", () => {
    const denied = P.policy(
      { schema: App, principal: User.sub, classes: ["admin", "member"], schemaClasses: ["admin"] },
      { doc: { read: true, attrs: [P.field(Doc.audit, { read: P.class("admin") })] } },
    );
    expect(P.checkReadWriteMasks(denied)).toEqual([]);

    const only = P.policy(
      { schema: App, principal: User.sub, classes: ["admin", "member"], schemaClasses: ["admin"] },
      {
        doc: {
          read: true,
          create: P.class("member"),
          write: P.class("member"),
          attrs: [P.field(Doc.audit, P.only("admin"))],
        },
      },
    );
    expect(P.checkReadWriteMasks(only)).toEqual([]);
    expect(captureWarn(() => P.compile(only))).toEqual([]);
  });

  test("P.only on a read-only namespace emits only the read arm — writes would grant", async () => {
    const p = P.policy(
      { schema: App, principal: User.sub, classes: ["admin", "member"], schemaClasses: ["admin"] },
      { doc: { read: ownDoc, attrs: [P.field(Doc.audit, P.only("admin"))] } },
    );
    const c = compiled(p);
    expect(c.attrs[":doc/audit"]).toEqual({
      read: [{ _tag: "allow" as const, class: ["admin"], rule: true as const }],
    });
    expect(c.ns!.doc!.add).toBeUndefined();
    expect(P.checkReadWriteMasks(p).join("\n")).toMatch(/would grant rather than narrow/);

    const conn = await Connection.create({ now: () => 1_700_000_000_000 });
    await conn.transact([
      { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity", ":db/optional": true },
      { ":db/ident": ":doc/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":doc/audit", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":doc/owner", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);
    const { tempids } = await conn.transact([
      { ":db/id": "alice", ":user/sub": "u_alice" },
      { ":db/id": "d1", ":doc/title": "D1", ":doc/owner": "alice", ":doc/audit": "who" },
    ]);
    const admin: Principal = {
      kind: "user",
      class: "admin",
      sub: "u_alice",
      eid: tempids.alice,
      claims: { sub: "u_alice" },
      db: "acme",
    };
    const denied = await checkTx(
      [[":db/add", tempids.d1, ":doc/audit", "x"]],
      conn.db(),
      c,
      admin,
    );
    expect(denied.ok).toBe(false);
  });

  test("compile warns when an explicit write arm is more open than read", () => {
    const p = P.policy(
      { schema: App, principal: User.sub, classes: ["admin", "member"], schemaClasses: ["admin"] },
      {
        doc: {
          read: true,
          write: P.class("member"),
          attrs: [P.field(Doc.audit, { read: P.class("admin"), write: P.class("admin", "member") })],
        },
      },
    );
    expect(P.checkReadWriteMasks(p).join("\n")).toMatch(/more open than read/);
  });
});

describe("masked attributes in pull patterns", () => {
  const masked = { title: Doc.title, audit: Doc.audit };
  const ok = { title: Doc.title, audit: Doc.audit.optional };

  test("a masked attribute pulled as required fails at compile", () => {
    expect(() => P.compile(specPolicy, { pulls: [masked] })).toThrow(PolicyError);
    expect(() => P.compile(specPolicy, { pulls: [masked] })).toThrow(/must be pulled as/);
  });

  test("`.optional` passes", () => {
    expect(() => P.compile(specPolicy, { pulls: [ok] })).not.toThrow();
  });

  test("nested patterns are walked", () => {
    expect(() =>
      P.compile(specPolicy, { pulls: [{ org: Project.org.select({ members: Org.members }) }] }),
    ).not.toThrow();
    const Wrapper = Entity("wrap", { doc: Field(Ref(() => Doc)) });
    expect(() =>
      P.compile(specPolicy, { pulls: [{ doc: Wrapper.doc.select({ audit: Doc.audit }) }] }),
    ).toThrow(/:doc\/audit/);
  });

  test("`.orDefault` does not qualify — the default would stand in for the redaction", () => {
    const defaulted = { title: Doc.title, audit: Doc.audit.orDefault("—") };
    expect(() => P.compile(specPolicy, { pulls: [defaulted] })).toThrow(PolicyError);
    expect(() => P.compile(specPolicy, { pulls: [defaulted] })).toThrow(
      /must be pulled as `\.optional` — `\.orDefault` does not qualify/,
    );
    expect(() =>
      P.compile(specPolicy, { pulls: [{ title: Doc.title.orDefault("untitled") }] }),
    ).not.toThrow();
  });

  test("an unmasked attribute is fine required", () => {
    expect(() => P.compile(specPolicy, { pulls: [{ title: Doc.title }] })).not.toThrow();
    expect(() => P.checkPulls(specPolicy, [{ title: Doc.title }])).not.toThrow();
  });
});

describe("compiled fragments evaluate through the engine", () => {
  test("P.compile output grants the owner and hides audit", async () => {
    const conn = await Connection.create({ now: () => 1_700_000_000_000 });
    await conn.transact([
      { ":db/ident": ":user/sub", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity", ":db/optional": true },
      { ":db/ident": ":org/members", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/many" },
      { ":db/ident": ":project/org", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":doc/title", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":doc/owner", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":doc/project", ":db/valueType": ":db.type/ref", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
      { ":db/ident": ":doc/audit", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/optional": true },
    ]);
    const { tempids } = await conn.transact([
      { ":db/id": "alice", ":user/sub": "u_alice" },
      { ":db/id": "bob", ":user/sub": "u_bob" },
      { ":db/id": "org1", ":org/members": ["alice"] },
      { ":db/id": "p1", ":project/org": "org1" },
      { ":db/id": "d1", ":doc/title": "D1", ":doc/owner": "alice", ":doc/project": "p1", ":doc/audit": "who" },
      { ":db/id": "d2", ":doc/title": "D2", ":doc/owner": "bob" },
    ]);
    const db = conn.db();
    const policy = compiled();
    const who = (sub: string, eid: number): Principal => ({
      kind: "user",
      class: "member",
      sub,
      eid,
      claims: { sub },
      db: "acme",
    });
    const idents = async (p: Principal, e: number) =>
      (await filterDb(db, db, policy, p).datomsArray(Index.EAVT, { e })).map((d) => db.attr(d.a)!.ident).sort();
    expect(await idents(who("u_alice", tempids.alice), tempids.d1)).toEqual([
      ":doc/owner",
      ":doc/project",
      ":doc/title",
    ]);
    expect(await idents(who("u_alice", tempids.alice), tempids.d2)).toEqual([]);
    expect(await idents(who("u_bob", tempids.bob), tempids.d2)).toEqual([":doc/owner", ":doc/title"]);
  });
});
