import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as EffectSchema from "effect/Schema";
import {
  InvalidIR,
  bindPolicyTemplateResult,
  compileReadAuthorization,
  compileReadAuthorizationResult,
  decodePolicyTemplateResult,
  encodePolicyTemplate,
  installAuthorization,
  MAX_COLLECTION_SIZE,
  MAX_JSON_NODES,
  validateBoundAuthorizationResult,
  $,
  all,
  allow,
  any,
  claim,
  contains,
  deny,
  eq,
  hasClass,
  lit,
  me,
  not,
  path,
  read,
  invoke,
  subject,
  type AuthExpr,
  type PolicyTemplateIR,
  type ReadRule,
} from "../../../src/internal/authorization/index.ts";
import { Entity, OwnedOperations, Schema, string } from "../../../src/db/internal.ts";
import "./authoring-types.ts";
import {
  App,
  External,
  Issue,
  OrphanResource,
  OrphanResources,
  Taggable,
  User,
  Workspace,
  bindAndValidate,
  catalogDescriptor,
  compileRules,
  expectInvalid,
  expectOk,
  issueOwner,
  orgClaim,
  semanticAccepts,
  semanticRejects,
  target,
} from "./semantic-fixtures.ts";

const compile = compileRules;

const assertInert = (value: unknown, seen = new WeakSet<object>()): void => {
  if (value === null || typeof value !== "object") {
    expect(typeof value === "function").toBe(false);
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  const proto = Object.getPrototypeOf(value);
  expect(proto === Object.prototype || proto === Array.prototype).toBe(true);
  const tag = (value as { readonly _tag?: unknown })._tag;
  expect(tag).not.toBe("AuthPath");
  expect(tag).not.toBe("ReadRule");
  if (Array.isArray(value)) {
    for (const item of value) assertInert(item, seen);
    return;
  }
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    expect(typeof child).not.toBe("function");
    assertInert(child, seen);
  }
};

describe("compile common rules", () => {
  test("owned operations compile to principal-only exact decisions", () => {
    const Operated = Entity(
      "operated",
      { title: string() },
      {
        operations: (Operation) => ({
          rename: Operation({
            input: EffectSchema.Struct({ title: EffectSchema.String }),
            output: EffectSchema.Struct({}),
            run() {
              return {};
            },
          }),
        }),
      },
    );
    const OperatedSchema = Schema({ operated: Operated });
    const rename = Operated[OwnedOperations].rename;
    const template = Result.getOrThrow(
      compileReadAuthorizationResult({
        schema: OperatedSchema,
        classes: ["member"],
        rules: [invoke(rename).when(hasClass("member"))],
      }),
    );

    expect(template.rules[0]?.focus).toEqual({
      _tag: "operation",
      operation: {
        _tag: "RelativeOperationId",
        owner: { kind: "entity", name: "operated" },
        localName: "rename",
        target: "required",
      },
    });
    expect(template.decisions.operations).toHaveLength(1);
    expect(template.rules[0]).toMatchObject({
      usesResource: false,
      usesMe: false,
      usesSubject: false,
      traversalDepth: 0,
    });

    expectInvalid(
      compileReadAuthorizationResult({
        schema: OperatedSchema,
        rules: [invoke(rename).when(eq(Operated.title, "hidden"))],
      }),
      /principal classes, claims, and subject identity/,
    );
  });

  test("common entity, trait, and field rules compile, bind, and validate", () => {
    const template = expectOk(
      compile([
        read(Issue).when(
          any(
            eq(Issue.owner, me),
            contains(path(Issue.workspace, Workspace.members), me),
            hasClass("admin"),
          ),
        ),
        read(Issue).when(all(hasClass("member"), eq(subject, claim("org")))),
        read(Taggable).when(contains(Taggable.tags, me)),
        read(Issue.title).when(eq(Issue.title, lit("secret"))),
        read(Issue.owner).when(eq(Issue.owner, me)),
      ]),
    );
    const installed = bindAndValidate(template);
    if (Result.isFailure(installed)) throw installed.failure;
  });

  test("a JSON scalar is equivalent to an explicit literal", () => {
    const scalar = expectOk(compile([read(Issue.title).when(eq(Issue.title, "hello"))]));
    const explicit = expectOk(
      compile([read(Issue.title).when(eq(Issue.title, lit("hello")))]),
    );
    expect(scalar.rules[0]?.expr).toEqual(explicit.rules[0]?.expr);
  });

  test("composed trait fields and entity self-ref compile", () => {
    const issueTags = expectOk(compile([read(Issue).when(contains(Issue.tags, me))]));
    const traitTags = expectOk(compile([read(Issue).when(contains(Taggable.tags, me))]));
    expect(issueTags.rules[0]?.expr).toEqual(traitTags.rules[0]?.expr);
    expectOk(compile([read(Taggable).when(contains(Taggable.tags, me))]));
    expectOk(compile([read(Issue).when(eq(path(Issue.parent, Issue.owner), me))]));
  });
});

describe("callback and $() match eq/path/contains", () => {
  test("three authoring forms produce the same IR", () => {
    const concise = expectOk(
      compile([
        read(Issue).when(
          any(
            eq(Issue.owner, me),
            contains(path(Issue.workspace, Workspace.members), me),
            hasClass("admin"),
          ),
        ),
      ]),
    );
    const dollars = expectOk(
      compile([
        read(Issue).when(
          any($(Issue).owner.eq(me), $(Issue).workspace.members.contains(me), hasClass("admin")),
        ),
      ]),
    );
    const callback = expectOk(
      compile([
        read(Issue).when((issue) =>
          any(issue.owner.eq(me), issue.workspace.members.contains(me), hasClass("admin")),
        ),
      ]),
    );

    const stripIds = (template: PolicyTemplateIR) => {
      const encoded = encodePolicyTemplate(template);
      return {
        ...encoded,
        rules: encoded.rules.map(({ id: _id, ...rule }) => rule),
        decisions: {
          operations: [],
          entities: encoded.decisions.entities.map((entry) => ({
            ...entry,
            decision: { allow: entry.decision.allow.map(() => "id"), deny: entry.decision.deny },
          })),
          traits: encoded.decisions.traits,
          fields: encoded.decisions.fields,
        },
      };
    };

    expect(stripIds(dollars)).toEqual(stripIds(concise));
    expect(stripIds(callback)).toEqual(stripIds(concise));
  });
});

describe("decision merge", () => {
  test("two .when on the same entity OR together; .deny goes to deny", () => {
    const template = expectOk(
      compile([
        read(Issue).when(eq(Issue.owner, me)),
        read(Issue).when(hasClass("admin")),
        read(Issue).deny(hasClass("banned")),
      ]),
    );
    expect(template.rules).toHaveLength(3);
    expect(template.decisions.entities).toHaveLength(1);
    const decision = template.decisions.entities[0]!.decision;
    expect(decision.allow).toEqual([template.rules[0]!.id, template.rules[1]!.id]);
    expect(decision.deny).toEqual([template.rules[2]!.id]);
    expect(template.classes).toEqual(["admin", "banned"]);
  });
});

describe("artifact inertness", () => {
  test("JSON round-trip, decode, and no authoring objects", () => {
    const template = expectOk(
      compile([
        read(Issue).when(any(eq(Issue.owner, me), not(deny), allow)),
        read(Taggable).when(contains(Taggable.tags, me)),
      ]),
    );
    const encoded = encodePolicyTemplate(template);
    const roundTrip = JSON.parse(JSON.stringify(encoded));
    const decoded = decodePolicyTemplateResult(roundTrip);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(encodePolicyTemplate(decoded.success)).toEqual(encoded);
    }
    assertInert(encoded);
    assertInert(template);
  });
});

describe("structural InvalidIR", () => {
  test("unknown field path", () => {
    expectInvalid(
      compile([read(Issue).when(eq({ ident: ":issue/missing", cardinality: "one" }, me))]),
      /unknown field path/,
    );
  });

  test("field from another schema/catalog", () => {
    const Outsider = Entity("outsider", { name: string() });
    expectInvalid(compile([read(Issue).when(eq(Outsider.name, "x"))]), /not in this catalog/);
    const OtherIssue = Entity("issue", { secret: string() });
    expectInvalid(compile([read(Issue).when(eq(OtherIssue.secret, "x"))]), /not in this catalog/);
  });

  test("reverse path", () => {
    expectInvalid(compile([read(Issue).when(eq(Issue.owner.reverse, me))]), /reverse/);
  });

  test(":db/id", () => {
    expectInvalid(compile([read(Issue).when(eq(Issue.id, me))]), /engine-owned|:db\/id/);
    expectInvalid(compile([read(Issue.id).when(allow)]), /engine-owned|:db\/id/);
  });

  test("undeclared claim", () => {
    expectInvalid(
      compileReadAuthorizationResult({
        schema: App,
        rules: [read(Issue).when(eq(subject, claim("org")))],
        claims: [],
      }),
      /undeclared claim/,
    );
  });

  test("empty all/any", () => {
    expectInvalid(compile([read(Issue).when(all())]), /empty all/);
    expectInvalid(compile([read(Issue).when(any())]), /empty any/);
  });

  test("depth greater than 3", () => {
    expectInvalid(
      compile([
        read(Issue).when(eq(path(Issue.parent, Issue.parent, Issue.parent, Issue.owner), me)),
      ]),
      /traversal depth 4 exceeds 3/,
    );
  });

  test("duplicate identical rule bodies", () => {
    expectInvalid(
      compile([read(Issue).when(eq(Issue.owner, me)), read(Issue).when(eq(Issue.owner, me))]),
      /duplicate identical rule body/,
    );
  });

  test("deny callback form compiles", () => {
    const template = expectOk(
      compile([read(Issue).deny((issue) => eq(issue.owner, me))]),
    );
    expect(template.decisions.entities[0]?.decision.deny).toHaveLength(1);
    expect(template.decisions.entities[0]?.decision.allow).toHaveLength(0);
  });

  test("unsupported smuggled tag", () => {
    expectInvalid(
      compile([
        read(Issue).when({
          _tag: "exists",
          entity: { _tag: "RelativeEntityId", name: "issue" },
          bind: "row",
          pred: allow,
        } as unknown as AuthExpr),
      ]),
      /unsupported expression tag 'exists'/,
    );
    expectInvalid(
      compile([
        read(Issue).when({
          _tag: "some",
          collection: me,
          bind: "tag",
          pred: allow,
        } as unknown as AuthExpr),
      ]),
      /unsupported expression tag 'some'/,
    );
  });

  test("malformed operand payloads return InvalidIR", () => {
    expectInvalid(compile([read(Issue).when(eq({ _tag: "claim" }, me))]), /malformed claim/);
    expectInvalid(
      compile([read(Issue).when(eq({ _tag: "claim", key: "" }, me))]),
      /blank claim key/,
    );
    expectInvalid(compile([read(Issue).when(eq({ _tag: "path" }, me))]), /malformed path/);
    expectInvalid(
      compile([read(Issue).when(eq({ _tag: "path", steps: [] }, me))]),
      /malformed path/,
    );
    expectInvalid(
      compile([read(Issue).when(eq({ _tag: "path", steps: [{}] }, me))]),
      /malformed path/,
    );
    expectInvalid(
      compile([read(Issue).when(eq({ _tag: "lit", value: { nested: true } }, me))]),
      /JSON scalar/,
    );
  });

  test("malformed recognized tags return InvalidIR and do not throw", () => {
    const cases: ReadonlyArray<{ readonly expr: unknown; readonly pattern: RegExp }> = [
      { expr: { _tag: "hasClass" }, pattern: /malformed hasClass/ },
      { expr: { _tag: "hasClass", class: undefined }, pattern: /malformed hasClass/ },
      { expr: { _tag: "hasClass", class: 1 }, pattern: /malformed hasClass/ },
      { expr: { _tag: "const" }, pattern: /malformed const/ },
      { expr: { _tag: "const", value: "yes" }, pattern: /malformed const/ },
      { expr: { _tag: "and" }, pattern: /malformed all/ },
      { expr: { _tag: "and", exprs: "nope" }, pattern: /malformed all/ },
      { expr: { _tag: "or" }, pattern: /malformed any/ },
      { expr: { _tag: "or", exprs: 1 }, pattern: /malformed any/ },
      { expr: { _tag: "not" }, pattern: /malformed not/ },
      { expr: { _tag: "not", expr: "nope" }, pattern: /malformed not/ },
      { expr: { _tag: "eq" }, pattern: /malformed eq/ },
      { expr: { _tag: "eq", left: me }, pattern: /malformed eq/ },
      { expr: { _tag: "in" }, pattern: /malformed contains/ },
      { expr: { _tag: "in", value: me }, pattern: /malformed contains/ },
      { expr: contains(undefined, me), pattern: /malformed contains/ },
      { expr: contains(Issue.tags, undefined), pattern: /malformed contains/ },
      { expr: hasClass(undefined as unknown as string), pattern: /blank class name/ },
    ];
    for (const { expr, pattern } of cases) {
      let result: Result.Result<unknown, InvalidIR>;
      try {
        result = compile([read(Issue).when(expr as AuthExpr)]);
      } catch (cause) {
        throw new Error(`compile threw for ${JSON.stringify(expr)}: ${String(cause)}`);
      }
      expectInvalid(result, pattern);
    }
  });

  test("rejects expression depth above 64", () => {
    let tooDeep: AuthExpr = allow;
    for (let i = 0; i < 65; i++) tooDeep = not(tooDeep);
    expectInvalid(compile([read(Issue).when(tooDeep)]), /expression depth 65 exceeds 64/);
  });

  test("wide all still fails on a deep child", () => {
    let tooDeep: AuthExpr = allow;
    for (let i = 0; i < 65; i++) tooDeep = not(tooDeep);
    expectInvalid(compile([read(Issue).when(all(allow, tooDeep))]), /expression depth .* exceeds 64/);
  });

  test("intermediate hop through an out-of-schema ref target field is InvalidIR", () => {
    expectInvalid(
      compileRules([read(OrphanResource).when(eq(path(OrphanResource.external, External.name), "x"))], {
        schema: OrphanResources,
        claims: [],
        principal: { entity: User.authId },
      }),
      /invalid path: 'external' is not in this catalog/,
    );
  });
});

describe("schema field names reserved by $()", () => {
  const Thing = Entity("thing", {
    eq: string(),
    contains: string(),
    steps: string(),
    then: string(),
    toJSON: string(),
  });
  const Things = Schema({ thing: Thing });
  const compileThing = (rules: readonly ReadRule[]) =>
    compileReadAuthorizationResult({
      schema: Things,
      rules,
      claims: [],
      principal: {},
    });

  test("proxy navigates real eq/contains/steps fields", () => {
    const dollars = expectOk(compileThing([read(Thing).when(eq($(Thing).eq, "x"))]));
    const method = expectOk(compileThing([read(Thing).when($(Thing).eq.eq("x"))]));
    const callback = expectOk(compileThing([read(Thing).when((thing) => eq(thing.eq, "x"))]));
    const collidingCall = expectOk(compileThing([read(Thing).when((thing) => thing.eq("x"))]));
    const conciseField = expectOk(compileThing([read(Thing).when(eq(Thing.eq, "x"))]));
    const containsField = expectOk(compileThing([read(Thing).when(eq($(Thing).contains, "c"))]));
    const stepsField = expectOk(compileThing([read(Thing).when(eq($(Thing).steps, "s"))]));
    const thenField = expectOk(compileThing([read(Thing).when($(Thing).then.eq("x"))]));
    const toJsonField = expectOk(compileThing([read(Thing).when($(Thing).toJSON.eq("x"))]));

    const conciseContains = expectOk(
      compileThing([read(Thing).when(eq(Thing.contains, "c"))]),
    );
    const conciseSteps = expectOk(
      compileThing([read(Thing).when(eq(Thing.steps, "s"))]),
    );
    const conciseThen = expectOk(
      compileThing([read(Thing).when(eq(Thing.then, "x"))]),
    );
    const conciseToJson = expectOk(
      compileThing([read(Thing).when(eq(Thing.toJSON, "x"))]),
    );

    expect(dollars.rules[0]?.expr).toEqual(conciseField.rules[0]?.expr);
    expect(method.rules[0]?.expr).toEqual(dollars.rules[0]?.expr);
    expect(callback.rules[0]?.expr).toEqual(dollars.rules[0]?.expr);
    expect(collidingCall.rules[0]?.expr).toEqual(dollars.rules[0]?.expr);
    expect(conciseField.rules[0]?.expr).toEqual(dollars.rules[0]?.expr);
    expect(thenField.rules[0]?.expr).toEqual(conciseThen.rules[0]?.expr);
    expect(toJsonField.rules[0]?.expr).toEqual(conciseToJson.rules[0]?.expr);
    expect(containsField.rules[0]?.expr).toEqual(conciseContains.rules[0]?.expr);
    expect(stepsField.rules[0]?.expr).toEqual(conciseSteps.rules[0]?.expr);
    expectOk(compile([read(Issue).when($(Issue).owner.eq(me))]));
    expectInvalid(compileThing([read(Thing).when($(Thing)("x"))]), /malformed eq/);
  });
});

describe("hashed compile", () => {
  test("equal policies have stable rule ids and semantic changes rotate them", async () => {
    const compilePolicy = (rules: readonly ReadRule[]) => Effect.runPromise(
      compileReadAuthorization({
        schema: App,
        rules,
        claims: [orgClaim],
        principal: { entity: User.authId },
      }),
    );
    const rules = [
      read(Issue).when(eq(Issue.owner, me)),
      read(Taggable).when(contains(Taggable.tags, me)),
    ];
    const first = await compilePolicy(rules);
    const again = await compilePolicy(rules);
    const changed = await compilePolicy([
      read(Issue).when(all(eq(Issue.owner, me), hasClass("member"))),
      rules[1]!,
    ]);

    expect(first.rules.map((rule) => rule.id))
      .toEqual(again.rules.map((rule) => rule.id));
    expect(changed.rules[0]?.id).not.toBe(first.rules[0]?.id);
    expect(changed.rules[1]?.id).toBe(first.rules[1]?.id);
  });
});

describe("core-v1 integration", () => {
  test("compiled template binds, validates, and installs", async () => {
    const template = await Effect.runPromise(
      compileReadAuthorization({
        schema: App,
        rules: [
          read(Issue).when(eq(Issue.owner, me)),
          read(Issue).when(all(hasClass("member"), eq(subject, claim("org")))),
          read(Taggable).when(contains(Taggable.tags, me)),
        ],
        claims: [orgClaim],
        principal: { entity: User.authId },
      }),
    );

    const descriptor = catalogDescriptor();
    const binding = { target, descriptor, template };
    const bound = bindPolicyTemplateResult(binding);
    expect(Result.isSuccess(bound)).toBe(true);
    if (Result.isFailure(bound)) throw new Error(bound.failure.message);

    const validated = validateBoundAuthorizationResult({ bound: bound.success, descriptor });
    expect(Result.isSuccess(validated)).toBe(true);
    if (Result.isFailure(validated)) throw new Error(validated.failure.message);

    const installed = await Effect.runPromise(installAuthorization(binding));
    expect(installed._tag).toBe("InstalledAuthorizationIR");
    expect(installed.rules).toHaveLength(3);
    expect(installed.decisions.entities).toHaveLength(1);
    expect(installed.decisions.traits).toHaveLength(1);
    expect(installed.accessPlans).toHaveLength(3);
  });
});

describe("installation owns semantic compatibility", () => {
  test.each(semanticRejects.map((scenario) => [scenario.name, scenario] as const))(
    "%s: compile succeeds, bind/validate fails",
    (_name, scenario) => {
      const template = expectOk(scenario.compile());
      const installed = bindAndValidate(template, scenario.descriptor());
      expect(Result.isFailure(installed)).toBe(true);
      if (Result.isFailure(installed)) {
        expect(installed.failure.message).toMatch(scenario.installFails);
      }
    },
  );

  test.each(semanticAccepts.map((scenario) => [scenario.name, scenario] as const))(
    "%s: compile and bind/validate succeed",
    (_name, scenario) => {
      const template = expectOk(scenario.compile());
      const installed = bindAndValidate(template, scenario.descriptor());
      if (Result.isFailure(installed)) throw new Error(installed.failure.message);
    },
  );
});

describe("field-target callbacks use the same proxy", () => {
  test("owner(me) compiles the same as eq(Issue.owner, me)", () => {
    const viaCallback = expectOk(compile([read(Issue.owner).when((owner) => owner(me))]));
    const viaEq = expectOk(compile([read(Issue.owner).when(eq(Issue.owner, me))]));
    expect(viaCallback.rules[0]?.expr).toEqual(viaEq.rules[0]?.expr);
    expect(viaCallback.rules[0]?.focus).toEqual({
      _tag: "field",
      field: { _tag: "RelativeFieldId", owner: issueOwner, localName: "owner" },
    });
  });

  test("owner.authId.eq(subject) hops to the ref target", () => {
    const viaCallback = expectOk(
      compile([read(Issue.owner).when((owner) => owner.authId.eq(subject))]),
    );
    const viaPath = expectOk(
      compile([read(Issue.owner).when(eq(path(Issue.owner, User.authId), subject))]),
    );
    expect(viaCallback.rules[0]?.expr).toEqual(viaPath.rules[0]?.expr);
  });

  test("self-ref callback hops stay on the field's owning row", () => {
    const viaCallback = expectOk(
      compile([read(Issue.parent).when((parent) => parent.title.eq("x"))]),
    );
    const viaPath = expectOk(compile([read(Issue.parent).when(eq(path(Issue.parent, Issue.title), "x"))]));
    expect(viaCallback.rules[0]?.expr).toEqual(viaPath.rules[0]?.expr);
    expectOk(compile([read(Issue.parent).when((parent) => parent.parent.title.eq("x"))]));
  });
});

describe("expression-size bounds before iterating", () => {
  test("wide all exceeding MAX_COLLECTION_SIZE fails without iterating", () => {
    const oversized = all(...Array(MAX_COLLECTION_SIZE + 1).fill(allow));
    expectInvalid(compile([read(Issue).when(oversized)]), /collection size/);
  });

  test("wide all exceeding MAX_JSON_NODES fails at compile with a node-budget message", () => {
    const chunk = all(...Array(256).fill(allow));
    const wide = all(...Array(16).fill(chunk));
    expectInvalid(
      compile([read(Issue).when(wide)]),
      new RegExp(`node budget .* exceeds ${MAX_JSON_NODES}`),
    );
  });

  test("oversized smuggled path fails collection-size before traversal", () => {
    expectInvalid(
      compile([
        read(Issue).when(
          eq(
            {
              _tag: "path",
              steps: Array.from({ length: MAX_COLLECTION_SIZE + 1 }, () => ({
                ident: ":issue/owner",
                localName: "owner",
              })),
            },
            me,
          ),
        ),
      ]),
      /collection size/,
    );
  });

  test("oversized rule list fails before lowering any rule", () => {
    const rules: ReadRule[] = [];
    rules[MAX_COLLECTION_SIZE] = read(Issue).when(allow);
    expectInvalid(compile(rules), /rule collection size .* exceeds 1024/);

    let indexed = 0;
    const proxied = new Proxy([] as ReadRule[], {
      get(_target, prop) {
        if (prop === "length") return MAX_COLLECTION_SIZE + 1;
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          indexed += 1;
          return read(Issue).when(allow);
        }
        return undefined;
      },
    });
    expectInvalid(compile(proxied), /rule collection size .* exceeds 1024/);
    expect(indexed).toBe(0);
  });

  test("document-wide node budget fails before lowering every rule", () => {
    let indexed = 0;
    const count = 800;
    const proxied = new Proxy([] as ReadRule[], {
      get(_target, prop) {
        if (prop === "length") return count;
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          indexed += 1;
          return read(Issue).when(all(allow, eq(Issue.title, lit(`x${prop}`))));
        }
        return undefined;
      },
    });
    expectInvalid(
      compile(proxied),
      new RegExp(`node budget .* exceeds ${MAX_JSON_NODES}`),
    );
    expect(indexed).toBeGreaterThan(0);
    expect(indexed).toBeLessThan(count);
  });
});

describe("public barrels stay closed", () => {
  test("authoring is root-only behind the Policy namespace", async () => {
    const root = await import("../../../src/index.ts");
    const db = await import("../../../src/db/index.ts");
    expect("Policy" in root).toBe(true);
    expect("compileReadAuthorization" in root.Policy).toBe(true);
    expect("invoke" in root.Policy).toBe(true);
    expect("compileReadAuthorizationResult" in root.Policy).toBe(false);
    expect("seededPath" in root.Policy).toBe(false);
    expect("lowerOwnedOperations" in root.Policy).toBe(false);
    expect("lowerOperationSchema" in root.Policy).toBe(false);
    expect("compileReadAuthorization" in root).toBe(false);
    expect("compileReadAuthorizationResult" in root).toBe(false);
    expect("Policy" in db).toBe(false);
    expect("compileReadAuthorization" in db).toBe(false);
    expect("hasClass" in db).toBe(false);
    expect("compileReadAuthorization" in (await import("../../../src/internal/authorization/index.ts"))).toBe(
      true,
    );
  });
});
