/** Typed policy authoring → the compiled AST core parses. No peer I/O. */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { Connection, Index, filterDb, parsePolicy, type CompiledPolicy, type Principal } from "../../src/internal/core/index.ts";
import {
  Field,
  Schema as DbSchema,
  Entity,
  Policy as P,
  PolicyError,
  Q,
  Query,
  Ref,
} from "../../src/db/internal.ts";

const User = Entity("user", { sub: Field(Schema.String, { unique: "upsert" }) });
const Org = Entity("org", { members: Field(Ref(() => User), { cardinality: "many" }) });
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
    claims: Schema.Struct({ org: Schema.String }),
  },
  {
    doc: {
      read: [ownDoc, inOrg],
      create: inOrg,
      set: ownDoc,
      remove: ownDoc,
      delete: ownDoc,
      preset: [P.preset(Doc.owner, P.principal)],
      attrs: [P.field(Doc.audit, { read: P.class("admin") })],
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
    expect(c.attrs[":doc/audit"]!.read).toEqual([{ _tag: "allow", class: ["admin"], rule: true }]);
    expect(Object.keys(c.attrs[":doc/audit"]!)).toEqual(["read"]);
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
      { schema: App, principal: User.sub, classes: ["member"] },
      { doc: { read: true } },
    );
    const c = compiled(only);
    expect(c.ns!.doc!.read).toEqual([{ _tag: "allow", rule: true }]);
    expect(c.rules).toBeUndefined();
  });

  test("a namespace with no rule is absent — deny by default", () => {
    const only = P.policy(
      { schema: App, principal: User.sub, classes: ["member"] },
      { doc: { read: ownDoc } },
    );
    const c = compiled(only);
    expect(c.attrs[":org/members"]).toBeUndefined();
    expect(c.ns!.org).toBeUndefined();
    expect(c.claims).toBeUndefined();
  });
});

describe("deploy-time errors", () => {
  test("an undeclared class is a PolicyError", () => {
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"] },
        // @ts-expect-error — "admin" is not a declared class
        { doc: { read: P.class("admin") } },
      ),
    ).toThrow(/not a declared class/);
  });

  test("an attribute outside the catalog is a PolicyError", () => {
    const Other = Entity("other", { thing: Field(Schema.String) });
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"] },
        // @ts-expect-error — :other/thing is not a field of doc
        { doc: { read: () => Query.is(Other.thing, "x") } },
      ),
    ).toThrow(/not in the schema/);
  });

  test("a namespace key outside the catalog is a PolicyError", () => {
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"] },
        // @ts-expect-error — "nope" is not a catalog namespace key
        { nope: { read: P.class("member") } },
      ),
    ).toThrow(/is not in the schema/);
  });

  test("an attribute rule outside its namespace is a PolicyError", () => {
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"] },
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
        { schema: App, principal: User.sub, classes: ["member"] },
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

  test("an empty fragment is a PolicyError — public is `true`", () => {
    expect(() =>
      P.policy(
        { schema: App, principal: User.sub, classes: ["member"] },
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
      P.policy({ schema: AppComments, principal: User.sub, classes: ["member"] }, {
        doc: { read: ownDocHand },
        comment: { read: ownDocHand },
      }),
    ).toThrow(/ns\.comment\.read: rule never binds the focus as this entity/);
  });

  test("the same fragment on the wrong entity alone is a PolicyError", () => {
    expect(() =>
      P.policy({ schema: AppComments, principal: User.sub, classes: ["member"] }, {
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
      { schema: AppComments, principal: User.sub, classes: ["member"] },
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
      { schema: AppComments, principal: User.sub, classes: ["member"] },
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
        { schema: AppComments, principal: User.sub, classes: ["member"] },
        { doc: { read: viaSome } },
      ),
    ).not.toThrow();
  });

  test("Query.some as a FilterStage arm compiles", () => {
    const p = P.policy(
      { schema: AppComments, principal: User.sub, classes: ["member"] },
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
      P.policy({ schema: AppComments, principal: User.sub, classes: ["member"] }, {
        doc: { read: () => Query.byId(1) },
      }),
    ).not.toThrow();
    expect(() =>
      P.policy({ schema: AppComments, principal: User.sub, classes: ["member"] }, {
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
        { schema: AppComments, principal: User.sub, classes: ["member"] },
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
        { schema: AppComments, principal: User.sub, classes: ["member"] },
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
