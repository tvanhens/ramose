/** Typed policy authoring → the compiled AST core parses. No peer I/O. */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { parsePolicy, type CompiledPolicy } from "../../src/internal/core/index.ts";
import {
  Attr,
  Catalog,
  Namespace,
  Policy as P,
  PolicyError,
  Q,
  Query,
  Ref,
} from "../../src/db/internal.ts";

const User = Namespace("user", { sub: Attr(Schema.String, { unique: "identity" }) });
const Org = Namespace("org", { members: Attr(Ref, { cardinality: "many" }) });
const Project = Namespace("project", { org: Attr(Ref) });
const Doc = Namespace("doc", {
  title: Attr(Schema.String),
  owner: Attr(Ref),
  project: Attr(Ref),
  audit: Attr(Schema.String),
});
const App = Catalog({ user: User, org: Org, project: Project, doc: Doc });

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
  };

const inProjectOrg = (me: P.Me<typeof User>) =>
  function* (project: Query.Var) {
    const org = yield* Query.follow(Project.org)(project);
    yield* Query.is(Org.members, me)(org);
  };

/** The policy reference's example, rewritten as fragments. */
const specPolicy = P.policy(
  {
    catalog: App,
    principal: User.sub,
    classes: ["anonymous", "member", "admin"],
    claims: Schema.Struct({ org: Schema.String }),
  },
  {
    doc: {
      read: [ownDoc, inOrg],
      create: inOrg,
      add: ownDoc,
      retract: ownDoc,
      retractEntity: ownDoc,
      preset: [P.preset(Doc.owner, P.principal)],
      attrs: [P.attr(Doc.audit, { read: P.class("admin") })],
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

  test("P.claims.attrs.<key> is a claim under attrs", () => {
    expect(P.claims.attrs.org).toEqual({ _tag: "claim", path: ["attrs", "org"] });
    expect(P.claimsOf(Schema.Struct({ org: Schema.String })).attrs.org).toEqual({
      _tag: "claim",
      path: ["attrs", "org"],
    });
  });

  test("true is the empty fragment — public, no rule emitted", () => {
    const only = P.policy(
      { catalog: App, principal: User.sub, classes: ["member"] },
      { doc: { read: true } },
    );
    const c = compiled(only);
    expect(c.ns!.doc!.read).toEqual([{ _tag: "allow", rule: true }]);
    expect(c.rules).toBeUndefined();
  });

  test("a namespace with no rule is absent — deny by default", () => {
    const only = P.policy(
      { catalog: App, principal: User.sub, classes: ["member"] },
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
        { catalog: App, principal: User.sub, classes: ["member"] },
        { doc: { read: P.class("admin") } },
      ),
    ).toThrow(/not a declared class/);
  });

  test("an attribute outside the catalog is a PolicyError", () => {
    const Other = Namespace("other", { thing: Attr(Schema.String) });
    expect(() =>
      P.policy(
        { catalog: App, principal: User.sub, classes: ["member"] },
        { doc: { read: () => Query.is(Other.thing, "x") } },
      ),
    ).toThrow(/not in the catalog/);
  });

  test("a namespace key outside the catalog is a PolicyError", () => {
    expect(() =>
      P.policy(
        { catalog: App, principal: User.sub, classes: ["member"] },
        // @ts-expect-error — "nope" is not a catalog namespace key
        { nope: { read: P.class("member") } },
      ),
    ).toThrow(/is not in the catalog/);
  });

  test("an attribute rule outside its namespace is a PolicyError", () => {
    expect(() =>
      P.policy(
        { catalog: App, principal: User.sub, classes: ["member"] },
        {
          doc: {
            read: P.class("member"),
            attrs: [P.attr(Org.members, { read: P.class("member") })],
          },
        },
      ),
    ).toThrow(/not under the doc namespace/);
  });

  test("a principal outside the catalog is a PolicyError", () => {
    const Other = Namespace("other", { sub: Attr(Schema.String) });
    expect(() =>
      P.policy(
        {
          catalog: App,
          // @ts-expect-error — :other/sub is not a catalog ident
          principal: Other.sub,
          classes: ["member"],
        },
        {},
      ),
    ).toThrow(/principal :other\/sub is not in the catalog/);
  });

  test("an empty fragment is a PolicyError — public is `true`", () => {
    expect(() =>
      P.policy(
        { catalog: App, principal: User.sub, classes: ["member"] },
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
    const Wrapper = Namespace("wrap", { doc: Attr(Ref) });
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
