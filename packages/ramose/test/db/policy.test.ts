/** Typed policy authoring → the compiled AST core parses. No peer I/O. */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { parsePolicy, type CompiledPolicy } from "../../src/internal/core/index.ts";
import { Attr, Catalog, Namespace, Policy as P, PolicyError, Ref } from "../../src/db/internal.ts";

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

const inOrg = P.ref(Doc.project, P.ref(Project.org, Org.members));

/** The spec's example, verbatim (docs/AUTH_LAYER.md §2). */
const specPolicy = P.policy(App, {
  principal: User.sub,
  classes: ["anonymous", "member", "admin"],
  claims: Schema.Struct({ org: Schema.String }),
  ns: {
    doc: {
      read: P.allow(P.or(P.eq(Doc.owner, P.principal), inOrg)),
      create: P.allow(inOrg),
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

const compiled = (p: P.Policy = specPolicy, opts?: P.CompileOptions): CompiledPolicy =>
  parsePolicy(JSON.parse(P.compile(p, opts)));

describe("compile", () => {
  test("the spec example round-trips through core's parsePolicy", () => {
    const c = compiled();
    expect(c.version).toBe(1);
    expect(c.principal).toBe(":user/sub");
    expect(c.classes).toEqual(["anonymous", "member", "admin"]);
    expect(c.claims).toBeDefined();
  });

  test("namespace rules land on every attribute of the namespace", () => {
    const c = compiled();
    for (const ident of [":doc/title", ":doc/owner", ":doc/project", ":doc/audit"]) {
      expect(c.attrs[ident]).toBeDefined();
      expect(c.attrs[ident]!.add).toEqual(c.ns!.doc!.add!);
    }
    // and `ns` is emitted too, so a later `:doc/ssn` inherits rather than leaks
    expect(Object.keys(c.ns!).sort()).toEqual(["doc", "org", "project", "user"]);
    expect(c.ns!.doc!.read).toBeDefined();
  });

  test("an attribute rule is emitted alone; core ANDs it with the namespace rule", () => {
    const c = compiled();
    expect(c.attrs[":doc/audit"]!.read).toEqual([
      { _tag: "allow", expr: { _tag: "class", class: "admin" } },
    ]);
    // ops the attribute rule does not name still inherit the namespace rule
    expect(c.attrs[":doc/audit"]!.add).toEqual(c.ns!.doc!.add!);
    // the namespace read is still on `ns`, so the AND in `allowsOp` narrows
    expect(c.ns!.doc!.read).not.toEqual(c.attrs[":doc/audit"]!.read);
    expect(c.attrs[":doc/title"]!.read).toEqual(c.ns!.doc!.read!);
  });

  test("nested ref lowers to nested ref exprs; a bare attr target means the principal", () => {
    const c = compiled();
    const read = c.attrs[":doc/project"]!.read!;
    expect(read[0]!.expr).toEqual({
      _tag: "or",
      exprs: [
        { _tag: "eq", attr: ":doc/owner", operand: { _tag: "principal" } },
        {
          _tag: "ref",
          attr: ":doc/project",
          target: {
            _tag: "ref",
            attr: ":project/org",
            target: { _tag: "eq", attr: ":org/members", operand: { _tag: "principal" } },
          },
        },
      ],
    });
  });

  test("preset compiles to a principal operand keyed by ident", () => {
    expect(compiled().preset).toEqual({ ":doc/owner": { _tag: "principal" } });
  });

  test("claims lower to an opaque JSON description", () => {
    const c = compiled();
    expect(JSON.stringify(c.claims)).toContain("org");
  });

  test("a claim operand keeps its path", () => {
    const c = compiled();
    expect(c.attrs[":user/sub"]!.read![0]!.expr).toEqual({
      _tag: "eq",
      attr: ":user/sub",
      operand: { _tag: "claim", path: ["sub"] },
    });
  });

  test("P.claims.attrs.<key> is a claim under attrs", () => {
    expect(P.claims.attrs.org).toEqual({ _tag: "claim", path: ["attrs", "org"] });
    expect(P.claimsOf(Schema.Struct({ org: Schema.String })).attrs.org).toEqual({
      _tag: "claim",
      path: ["attrs", "org"],
    });
  });

  test("a namespace with no rule is absent — deny by default", () => {
    const only = P.policy(App, {
      principal: User.sub,
      classes: ["member"],
      ns: { doc: { read: P.allow(P.eq(Doc.owner, P.principal)) } },
    });
    const c = compiled(only);
    expect(c.attrs[":org/members"]).toBeUndefined();
    expect(c.ns!.org).toBeUndefined();
    expect(c.claims).toBeUndefined();
  });
});

describe("deploy-time errors", () => {
  test("ref depth 4 is a PolicyError", () => {
    const A = Namespace("a", { b: Attr(Ref) });
    const B = Namespace("b", { c: Attr(Ref) });
    const C = Namespace("c", { d: Attr(Ref) });
    const D = Namespace("d", { e: Attr(Ref, { cardinality: "many" }) });
    expect(() => P.ref(A.b, P.ref(B.c, P.ref(C.d, P.ref(D.e, D.e))))).toThrow(PolicyError);
    // depth 3 is fine
    expect(() => P.ref(B.c, P.ref(C.d, P.ref(D.e, D.e)))).not.toThrow();
  });

  test("an undeclared class is a PolicyError", () => {
    expect(() =>
      P.policy(App, {
        principal: User.sub,
        classes: ["member"],
        ns: { doc: { read: P.allow(P.class("admin")) } },
      }),
    ).toThrow(/not a declared class/);
  });

  test("an attribute outside the catalog is a PolicyError", () => {
    const Other = Namespace("other", { thing: Attr(Schema.String) });
    expect(() =>
      P.policy(App, {
        principal: User.sub,
        classes: ["member"],
        ns: { doc: { read: P.allow(P.eq(Other.thing, "x")) } },
      }),
    ).toThrow(/not in the catalog/);
  });

  test("a namespace key outside the catalog is a PolicyError", () => {
    expect(() =>
      P.policy(App, {
        principal: User.sub,
        classes: ["member"],
        // @ts-expect-error — "nope" is not a catalog namespace key
        ns: { nope: { read: P.allow(P.class("member")) } },
      }),
    ).toThrow(/is not in the catalog/);
  });

  test("an attribute rule outside its namespace is a PolicyError", () => {
    expect(() =>
      P.policy(App, {
        principal: User.sub,
        classes: ["member"],
        ns: { doc: { read: P.allow(P.class("member")), attrs: [P.attr(Org.members, { read: P.allow(P.class("member")) })] } },
      }),
    ).toThrow(/not under the doc namespace/);
  });

  test("a principal outside the catalog is a PolicyError", () => {
    const Other = Namespace("other", { sub: Attr(Schema.String) });
    expect(() =>
      P.policy(App, {
        // @ts-expect-error — :other/sub is not a catalog ident
        principal: Other.sub,
        classes: ["member"],
        ns: {},
      }),
    ).toThrow(/principal :other\/sub is not in the catalog/);
  });

  test("ref() on a non-ref attribute is a PolicyError", () => {
    // @ts-expect-error — :doc/title is not :db.type/ref
    expect(() => P.ref(Doc.title, Org.members)).toThrow(/db.type\/ref/);
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
    // …and the unmasked field next to it is still fine defaulted
    expect(() =>
      P.compile(specPolicy, { pulls: [{ title: Doc.title.orDefault("untitled") }] }),
    ).not.toThrow();
  });

  test("an unmasked attribute is fine required", () => {
    expect(() => P.compile(specPolicy, { pulls: [{ title: Doc.title }] })).not.toThrow();
    expect(() => P.checkPulls(specPolicy, [{ title: Doc.title }])).not.toThrow();
  });
});
