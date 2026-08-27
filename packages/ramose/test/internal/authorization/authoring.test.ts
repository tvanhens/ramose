/**
 * Read-authorization authoring language (#406).
 *
 * Compile lowers `read` / `$` / `path` into Schema-decoded PolicyTemplateIR
 * and reuses the core-v1 bind → validate → install pipeline.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  CatalogId,
  CatalogVersion,
  DatabaseId,
  EntityId,
  FieldId,
  InvalidIR,
  OperationId,
  SchemaFingerprint,
  TraitId,
  bindPolicyTemplateResult,
  compileReadAuthorization,
  compileReadAuthorizationResult,
  decodePolicyTemplateResult,
  encodePolicyTemplate,
  hashRelativeRule,
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
  subject,
  type AuthExpr,
  type CatalogBindingTarget,
  type CatalogDescriptor,
  type FieldRefTarget,
  type OwnerRef,
  type PolicyTemplateIR,
  type ReadRule,
} from "../../../src/internal/authorization/index.ts";
import { Entity, Field, Ref, Schema, Trait, string } from "../../../src/db/internal.ts";
import "./authoring-types.ts";

const User = Entity("user", {
  authId: Field.unique(string(), "upsert"),
});
const Workspace = Entity("workspace", {
  members: Field.many(Ref(User)),
});
const Tag = Entity("tag", { name: string() });
const Taggable = Trait("taggable", { tags: Field.many(Ref(User)) });
const Issue = Entity(
  "issue",
  {
    owner: Ref(User),
    workspace: Ref(Workspace),
    title: string(),
    parent: Ref.self,
  },
  { traits: [Taggable] },
);
const App = Schema({ user: User, workspace: Workspace, tag: Tag, issue: Issue });

const orgClaim = {
  key: "org",
  optional: false,
  shape: { _tag: "scalar" as const, valueType: "string" as const },
};

const compile = (
  rules: readonly ReadRule[],
  extras: Omit<Partial<Parameters<typeof compileReadAuthorizationResult>[0]>, "rules"> = {},
) =>
  compileReadAuthorizationResult({
    schema: extras.schema ?? App,
    rules,
    claims: extras.claims ?? [orgClaim],
    principal: extras.principal ?? { entity: User.authId },
    ...(extras.classes === undefined ? {} : { classes: extras.classes }),
  });

const expectInvalid = (result: Result.Result<unknown, InvalidIR>, pattern: RegExp) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(InvalidIR);
    expect(result.failure._tag).toBe("InvalidIR");
    expect(result.failure.message).toMatch(pattern);
  }
};

const expectOk = (result: Result.Result<PolicyTemplateIR, InvalidIR>): PolicyTemplateIR => {
  if (Result.isFailure(result)) {
    throw new Error(`expected success, got ${result.failure.message}`);
  }
  return result.success;
};

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

const catalog = CatalogId.make("app");
const database = DatabaseId.make("todos");
const version = CatalogVersion.make("1");
const fingerprint = SchemaFingerprint.make("schema");
const issueOwner = { kind: "entity" as const, name: "issue" };
const userOwner = { kind: "entity" as const, name: "user" };
const taggableOwner = { kind: "trait" as const, name: "taggable" };
const workspaceOwner = { kind: "entity" as const, name: "workspace" };

const target: CatalogBindingTarget = {
  database,
  catalog,
  catalogVersion: version,
  schemaFingerprint: fingerprint,
};

const entityId = (name: string) => EntityId.make({ catalog, name });
const traitId = (name: string) => TraitId.make({ catalog, name });
const fieldId = (owner: OwnerRef, localName: string) => FieldId.make({ catalog, owner, localName });

const scalarField = (
  owner: OwnerRef,
  localName: string,
  options: { readonly unique?: "upsert" | "strict" } = {},
): CatalogDescriptor["fields"][number] => ({
  id: fieldId(owner, localName),
  valueType: "string",
  cardinality: "one",
  ...(options.unique === undefined ? {} : { unique: options.unique }),
  index: options.unique !== undefined,
  optional: false,
  owned: false,
});

const refField = (
  owner: OwnerRef,
  localName: string,
  refTarget: FieldRefTarget,
  cardinality: "one" | "many" = "one",
): CatalogDescriptor["fields"][number] => ({
  id: fieldId(owner, localName),
  valueType: "ref",
  refTarget,
  cardinality,
  index: false,
  optional: false,
  owned: false,
});

const catalogDescriptor = (): CatalogDescriptor => ({
  id: catalog,
  database,
  version,
  fingerprint,
  entities: [
    { id: entityId("user"), traits: [] },
    { id: entityId("workspace"), traits: [] },
    { id: entityId("issue"), traits: [traitId("taggable")] },
    { id: entityId("tag"), traits: [] },
  ],
  traits: [{ id: traitId("taggable"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    refField(issueOwner, "owner", { _tag: "entity", entity: entityId("user") }),
    refField(issueOwner, "workspace", { _tag: "entity", entity: entityId("workspace") }),
    scalarField(issueOwner, "title"),
    refField(issueOwner, "parent", { _tag: "self" }),
    refField(workspaceOwner, "members", { _tag: "entity", entity: entityId("user") }, "many"),
    refField(taggableOwner, "tags", { _tag: "entity", entity: entityId("user") }, "many"),
    scalarField({ kind: "entity", name: "tag" }, "name"),
  ],
  operations: [
    {
      id: OperationId.make({ catalog, owner: issueOwner, localName: "rename", target: "required" }),
      input: {
        _tag: "struct",
        fields: [{ key: "title", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
      },
    },
  ],
  traitComposition: [
    {
      composer: entityId("issue"),
      trait: traitId("taggable"),
      transitive: [traitId("taggable")],
    },
  ],
});

describe("compile common rules", () => {
  test("owner eq(me), workspace contains, hasClass, claim+subject, trait, field-narrow", () => {
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

    expect(template._tag).toBe("PolicyTemplateIR");
    expect(template.version).toBe(1);
    expect(template.languageVersion).toBe("v1");
    expect(template.classes).toEqual(["admin", "member"]);
    expect(template.principal.entity).toEqual({
      _tag: "RelativeFieldId",
      owner: { kind: "entity", name: "user" },
      localName: "authId",
    });

    const owner = template.rules.find((rule) => rule.expr._tag === "or");
    expect(owner?.focus).toEqual({ _tag: "entity", entity: { _tag: "RelativeEntityId", name: "issue" } });
    expect(owner?.usesResource).toBe(true);
    expect(owner?.usesMe).toBe(true);
    expect(owner?.usesSubject).toBe(false);
    expect(owner?.traversalDepth).toBe(2);
    expect(owner?.expr).toEqual({
      _tag: "or",
      exprs: [
        {
          _tag: "eq",
          left: {
            _tag: "ref",
            root: { _tag: "resource" },
            steps: [{ field: { _tag: "RelativeFieldId", owner: issueOwner, localName: "owner" } }],
          },
          right: { _tag: "me" },
        },
        {
          _tag: "in",
          value: { _tag: "me" },
          collection: {
            _tag: "ref",
            root: { _tag: "resource" },
            steps: [
              { field: { _tag: "RelativeFieldId", owner: issueOwner, localName: "workspace" } },
              { field: { _tag: "RelativeFieldId", owner: workspaceOwner, localName: "members" } },
            ],
          },
        },
        { _tag: "hasClass", class: "admin" },
      ],
    });

    const tenant = template.rules.find((rule) => rule.expr._tag === "and");
    expect(tenant?.usesResource).toBe(false);
    expect(tenant?.usesMe).toBe(false);
    expect(tenant?.usesSubject).toBe(true);
    expect(tenant?.traversalDepth).toBe(0);
    expect(tenant?.expr).toEqual({
      _tag: "and",
      exprs: [
        { _tag: "hasClass", class: "member" },
        { _tag: "eq", left: { _tag: "subject" }, right: { _tag: "claim", key: "org" } },
      ],
    });

    const trait = template.rules.find((rule) => rule.focus._tag === "trait");
    expect(trait?.focus).toEqual({ _tag: "trait", trait: { _tag: "RelativeTraitId", name: "taggable" } });
    expect(trait?.expr).toEqual({
      _tag: "in",
      value: { _tag: "me" },
      collection: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [{ field: { _tag: "RelativeFieldId", owner: taggableOwner, localName: "tags" } }],
      },
    });
    expect(Issue.tags.ident).toBe(":taggable/tags");

    const title = template.rules.find(
      (rule) => rule.focus._tag === "field" && rule.focus.field.localName === "title",
    );
    expect(title?.focus._tag).toBe("field");
    expect(template.decisions.fields).toHaveLength(2);
  });

  test("auto-boxes JSON scalars in eq", () => {
    const template = expectOk(compile([read(Issue.title).when(eq(Issue.title, "hello"))]));
    expect(template.rules[0]?.expr).toEqual({
      _tag: "eq",
      left: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [{ field: { _tag: "RelativeFieldId", owner: issueOwner, localName: "title" } }],
      },
      right: { _tag: "lit", value: "hello" },
    });
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

describe("InvalidIR failures", () => {
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

  test("eq on card-many", () => {
    expectInvalid(compile([read(Workspace).when(eq(Workspace.members, me))]), /card-many|contains/);
    expectInvalid(compile([read(Issue).when(eq(Issue.tags, me))]), /card-many|contains/);
  });

  test("contains on card-one", () => {
    expectInvalid(compile([read(Issue).when(contains(Issue.owner, me))]), /card-many|card-one/);
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

  test("intermediate non-ref", () => {
    expectInvalid(
      compile([read(Issue).when(eq(path(Issue.title, User.authId), me))]),
      /not a ref/,
    );
  });

  test("intermediate many hop", () => {
    expectInvalid(
      compile([
        read(Issue).when(eq(path(Issue.workspace, Workspace.members, User.authId), "x")),
      ]),
      /intermediate many/,
    );
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

  test("principal field must be entity-owned, unique, and string-compatible", () => {
    expectInvalid(
      compileReadAuthorizationResult({
        schema: App,
        rules: [read(Issue).when(allow)],
        principal: { entity: Taggable.tags },
      }),
      /principal field must be entity-owned/,
    );
    expectInvalid(
      compileReadAuthorizationResult({
        schema: App,
        rules: [read(Issue).when(allow)],
        principal: { entity: Issue.title },
      }),
      /principal field is not unique/,
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

  test("rejects paths unreachable from the rule focus", () => {
    expectInvalid(
      compile([read(Issue).when(eq(User.authId, "x"))]),
      /wrong owner for field 'entity:user\.authId'/,
    );
    expectInvalid(
      compile([read(Issue).when(contains(path(Issue.owner, Workspace.members), me))]),
      /wrong owner for field 'entity:workspace\.members'/,
    );
    expectInvalid(
      compile([read(Issue.title).when(eq(User.authId, "x"))]),
      /wrong owner/,
    );
  });

  test("composed trait fields stay reachable from the entity focus", () => {
    const issueTags = expectOk(compile([read(Issue).when(contains(Issue.tags, me))]));
    const traitTags = expectOk(compile([read(Issue).when(contains(Taggable.tags, me))]));
    expect(issueTags.rules[0]?.expr).toEqual(traitTags.rules[0]?.expr);
    expectOk(compile([read(Taggable).when(contains(Taggable.tags, me))]));
    expectOk(compile([read(Issue).when(eq(path(Issue.parent, Issue.owner), me))]));
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

  test("rejects incompatible equality operands at compile", () => {
    expectInvalid(compile([read(Issue).when(eq(Issue.title, me))]), /incompatible equality/);
    expectInvalid(compile([read(Issue).when(eq(Issue.title, 1))]), /incompatible equality/);
    expectOk(compile([read(Issue).when(eq(Issue.owner, me))]));
    expectOk(compile([read(Issue).when(eq(subject, claim("org")))]));
    expectOk(compile([read(Issue).when(eq(Issue.title, "hello"))]));
  });

  test("rejects incompatible membership operands at compile", () => {
    const Labeled = Trait("labeled", { labels: Field.many(Ref(Tag)) });
    const Note = Entity("note", { title: string() }, { traits: [Labeled] });
    const LabeledApp = Schema({ user: User, tag: Tag, note: Note });
    expectInvalid(
      compileReadAuthorizationResult({
        schema: LabeledApp,
        rules: [read(Labeled).when(contains(Labeled.labels, me))],
        claims: [],
        principal: { entity: User.authId },
      }),
      /incompatible membership/,
    );
    expectInvalid(compile([read(Issue).when(contains(me, Issue.owner))]), /membership requires a collection/);
    expectInvalid(compile([read(Workspace).when(contains(Workspace.members, "x"))]), /incompatible membership/);
    expectInvalid(compile([read(Issue).when(contains(claim("org"), "x"))]), /membership requires a collection/);
    expectInvalid(
      compileReadAuthorizationResult({
        schema: App,
        rules: [read(Issue).when(contains(claim("teams"), me))],
        claims: [
          orgClaim,
          {
            key: "teams",
            optional: true,
            shape: { _tag: "array", items: { _tag: "scalar", valueType: "string" } },
          },
        ],
        principal: { entity: User.authId },
      }),
      /incompatible membership/,
    );
    expectOk(
      compileReadAuthorizationResult({
        schema: App,
        rules: [read(Issue).when(contains(claim("teams"), "admin"))],
        claims: [
          orgClaim,
          {
            key: "teams",
            optional: true,
            shape: { _tag: "array", items: { _tag: "scalar", valueType: "string" } },
          },
        ],
        principal: { entity: User.authId },
      }),
    );
    expectOk(compile([read(Workspace).when(contains(Workspace.members, me))]));
    expectOk(compile([read(Issue).when(contains(path(Issue.workspace, Workspace.members), me))]));
    expectOk(compile([read(Taggable).when(contains(Taggable.tags, me))]));
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

    const eqField = {
      _tag: "RelativeFieldId" as const,
      owner: { kind: "entity" as const, name: "thing" },
      localName: "eq",
    };
    expect(dollars.rules[0]?.expr).toEqual({
      _tag: "eq",
      left: { _tag: "ref", root: { _tag: "resource" }, steps: [{ field: eqField }] },
      right: { _tag: "lit", value: "x" },
    });
    expect(method.rules[0]?.expr).toEqual(dollars.rules[0]?.expr);
    expect(callback.rules[0]?.expr).toEqual(dollars.rules[0]?.expr);
    expect(collidingCall.rules[0]?.expr).toEqual(dollars.rules[0]?.expr);
    expect(conciseField.rules[0]?.expr).toEqual(dollars.rules[0]?.expr);
    expect(thenField.rules[0]?.expr).toEqual({
      _tag: "eq",
      left: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [{ field: { ...eqField, localName: "then" } }],
      },
      right: { _tag: "lit", value: "x" },
    });
    expect(toJsonField.rules[0]?.expr).toEqual({
      _tag: "eq",
      left: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [{ field: { ...eqField, localName: "toJSON" } }],
      },
      right: { _tag: "lit", value: "x" },
    });
    expect(containsField.rules[0]?.expr).toEqual({
      _tag: "eq",
      left: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [{ field: { ...eqField, localName: "contains" } }],
      },
      right: { _tag: "lit", value: "c" },
    });
    expect(stepsField.rules[0]?.expr).toEqual({
      _tag: "eq",
      left: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [{ field: { ...eqField, localName: "steps" } }],
      },
      right: { _tag: "lit", value: "s" },
    });
    expectOk(compile([read(Issue).when($(Issue).owner.eq(me))]));
    expectInvalid(compileThing([read(Thing).when($(Thing)("x"))]), /malformed eq/);
  });
});

describe("hashed compile", () => {
  test("compileReadAuthorization restamps ids to hashRelativeRule", async () => {
    const template = await Effect.runPromise(
      compileReadAuthorization({
        schema: App,
        rules: [read(Issue).when(eq(Issue.owner, me)), read(Taggable).when(contains(Taggable.tags, me))],
        claims: [orgClaim],
        principal: { entity: User.authId },
      }),
    );
    expect(template.rules.length).toBe(2);
    for (const rule of template.rules) {
      const hashed = await Effect.runPromise(hashRelativeRule(rule));
      expect(hashed).toBe(rule.id);
    }
    const placeholders = template.rules.map((_, i) => i.toString(16).padStart(64, "0"));
    for (const rule of template.rules) {
      expect(placeholders.includes(rule.id)).toBe(false);
    }
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

describe("self-ref hops from the field owner", () => {
  const Linkable = Trait("linkable", {
    parent: Ref.self,
    label: string(),
  });
  const LinkedIssue = Entity("issue", { owner: Ref(User) }, { traits: [Linkable] });
  const LinkedApp = Schema({ user: User, issue: LinkedIssue });

  test("trait self-ref then entity field is the wrong owner", () => {
    expectInvalid(
      compileReadAuthorizationResult({
        schema: LinkedApp,
        rules: [read(LinkedIssue).when(eq(path(Linkable.parent, LinkedIssue.owner), me))],
        claims: [],
        principal: { entity: User.authId },
      }),
      /wrong owner/,
    );
  });

  test("entity self-ref stays on the entity", () => {
    expectOk(compile([read(Issue).when(eq(path(Issue.parent, Issue.owner), me))]));
  });

  test("after a trait self-ref, a trait-owned field stays reachable", () => {
    expectOk(
      compileReadAuthorizationResult({
        schema: LinkedApp,
        rules: [read(LinkedIssue).when(eq(path(Linkable.parent, Linkable.label), "x"))],
        claims: [],
        principal: { entity: User.authId },
      }),
    );
  });
});

describe("trait composition in principal-ref / ref-ref equality", () => {
  const Member = Trait("member", {});
  const Base = Trait("base", {});
  const Extra = Trait("extra", {}, { traits: [Base] });
  const Person = Entity("person", { authId: Field.unique(string(), "upsert") }, { traits: [Member] });
  const Guest = Entity("guest", { authId: Field.unique(string(), "upsert") });
  const Holder = Entity("holder", { authId: Field.unique(string(), "upsert") }, { traits: [Extra] });
  const Bag = Entity("bag", {
    holder: Ref(Member),
    owner: Ref(Person),
    guest: Ref(Guest),
    base: Ref(Base),
    extra: Ref(Extra),
  });
  const Bags = Schema({ person: Person, guest: Guest, holder: Holder, bag: Bag });

  const compileBag = (
    rules: readonly ReadRule[],
    principal: { readonly entity: typeof Person.authId | typeof Guest.authId | typeof Holder.authId },
  ) =>
    compileReadAuthorizationResult({
      schema: Bags,
      rules,
      claims: [],
      principal,
    });

  test("me matches a ref to a trait the principal entity composes", () => {
    expectOk(compileBag([read(Bag).when(eq(Bag.holder, me))], { entity: Person.authId }));
  });

  test("me does not match a trait the principal entity does not compose", () => {
    expectInvalid(
      compileBag([read(Bag).when(eq(Bag.holder, me))], { entity: Guest.authId }),
      /incompatible equality/,
    );
  });

  test("two refs are compatible when an entity composes the trait target", () => {
    expectOk(compileBag([read(Bag).when(eq(Bag.holder, Bag.owner))], { entity: Person.authId }));
    expectInvalid(
      compileBag([read(Bag).when(eq(Bag.holder, Bag.guest))], { entity: Person.authId }),
      /incompatible equality/,
    );
  });

  test("two trait refs are compatible when one trait composes the other", () => {
    expectOk(compileBag([read(Bag).when(eq(Bag.base, Bag.extra))], { entity: Holder.authId }));
  });

  test("two distinct entity refs stay incompatible", () => {
    expectInvalid(compile([read(Issue).when(eq(Issue.owner, Issue.workspace))]), /incompatible equality/);
  });
});

describe("entity vs composed-trait ref targets (Resource.userRef / actorRef)", () => {
  const Actor = Trait("actor", {});
  const User = Entity("user", { authId: Field.unique(string(), "upsert") }, { traits: [Actor] });
  const Stranger = Entity("stranger", { authId: Field.unique(string(), "upsert") });
  const Resource = Entity("resource", {
    userRef: Ref(User),
    actorRef: Ref(Actor),
    manyActorRefs: Field.many(Ref(Actor)),
    strangerRef: Ref(Stranger),
  });
  const Resources = Schema({ user: User, stranger: Stranger, resource: Resource });
  const compileResource = (rules: readonly ReadRule[]) =>
    compileReadAuthorizationResult({
      schema: Resources,
      rules,
      claims: [],
      principal: { entity: User.authId },
    });

  test("eq(userRef, actorRef) compiles in both directions when User composes Actor", () => {
    expectOk(compileResource([read(Resource).when(eq(Resource.userRef, Resource.actorRef))]));
    expectOk(compileResource([read(Resource).when(eq(Resource.actorRef, Resource.userRef))]));
  });

  test("contains(manyActorRefs, userRef) is compatible via eqCompatible", () => {
    expectOk(compileResource([read(Resource).when(contains(Resource.manyActorRefs, Resource.userRef))]));
  });

  test("eq fails when the entity does not compose the trait", () => {
    expectInvalid(
      compileResource([read(Resource).when(eq(Resource.strangerRef, Resource.actorRef))]),
      /incompatible equality/,
    );
    expectInvalid(
      compileResource([read(Resource).when(eq(Resource.actorRef, Resource.strangerRef))]),
      /incompatible equality/,
    );
  });
});

describe("targeted vs untargeted refs", () => {
  const Resource = Entity("resource", {
    userRef: Ref(User),
    looseRef: Field(Ref),
    otherLoose: Field(Ref),
  });
  const Resources = Schema({ user: User, resource: Resource });
  const compileResource = (rules: readonly ReadRule[]) =>
    compileReadAuthorizationResult({
      schema: Resources,
      rules,
      claims: [],
      principal: { entity: User.authId },
    });

  test("exactly one untargeted ref is incompatible", () => {
    expectInvalid(
      compileResource([read(Resource).when(eq(Resource.looseRef, Resource.userRef))]),
      /incompatible equality/,
    );
  });

  test("two untargeted refs are compatible", () => {
    expectOk(compileResource([read(Resource).when(eq(Resource.looseRef, Resource.looseRef))]));
    expectOk(compileResource([read(Resource).when(eq(Resource.looseRef, Resource.otherLoose))]));
  });

  test("two targeted refs to the same entity are compatible", () => {
    expectOk(compileResource([read(Resource).when(eq(Resource.userRef, Resource.userRef))]));
  });

  test("untargeted ref is incompatible with me", () => {
    expectInvalid(
      compileResource([read(Resource).when(eq(Resource.looseRef, me))]),
      /incompatible equality/,
    );
  });
});

describe("ref targets must be in the catalog", () => {
  const External = Entity("external", { name: string() });
  const OrphanTrait = Trait("orphan", {});
  const Resource = Entity("resource", {
    userRef: Ref(User),
    external: Ref(External),
    externals: Field.many(Ref(External)),
    orphan: Ref(OrphanTrait),
    looseRef: Field(Ref),
    parent: Ref.self,
  });
  const Resources = Schema({ user: User, resource: Resource });
  const compileResource = (rules: readonly ReadRule[]) =>
    compileReadAuthorizationResult({
      schema: Resources,
      rules,
      claims: [],
      principal: { entity: User.authId },
    });

  test("terminal ref to an entity outside the schema is InvalidIR", () => {
    expectInvalid(
      compileResource([read(Resource).when(eq(Resource.external, Resource.external))]),
      /invalid path: 'external' is not in this catalog/,
    );
    expectInvalid(
      compileResource([read(Resource).when(eq(Resource.external, me))]),
      /invalid path: 'external' is not in this catalog/,
    );
  });

  test("contains of an out-of-catalog collection is InvalidIR", () => {
    expectInvalid(
      compileResource([read(Resource).when(contains(Resource.externals, Resource.userRef))]),
      /invalid path: 'external' is not in this catalog/,
    );
    expectInvalid(
      compileResource([read(Resource).when(contains(Resource.externals, me))]),
      /invalid path: 'external' is not in this catalog/,
    );
  });

  test("$() terminal to an out-of-catalog ref is InvalidIR", () => {
    expectInvalid(
      compileResource([read(Resource).when($(Resource).external.eq(me))]),
      /invalid path: 'external' is not in this catalog/,
    );
    expectInvalid(
      compileResource([read(Resource).when($(Resource).external.eq($(Resource).external))]),
      /invalid path: 'external' is not in this catalog/,
    );
  });

  test("field-target read(Resource.external) is InvalidIR", () => {
    expectInvalid(
      compileResource([read(Resource.external).when((external) => external(me))]),
      /invalid path: 'external' is not in this catalog/,
    );
    expectInvalid(
      compileResource([read(Resource.external).when(eq(Resource.external, me))]),
      /invalid path: 'external' is not in this catalog/,
    );
  });

  test("trait ref target omitted from the schema is InvalidIR", () => {
    expectInvalid(
      compileResource([read(Resource).when(eq(Resource.orphan, Resource.orphan))]),
      /invalid path: 'orphan' is not in this catalog/,
    );
    expectInvalid(
      compileResource([read(Resource).when(eq(Resource.orphan, me))]),
      /invalid path: 'orphan' is not in this catalog/,
    );
  });

  test("intermediate hop through an out-of-schema ref is InvalidIR", () => {
    expectInvalid(
      compileResource([read(Resource).when(eq(path(Resource.external, External.name), "x"))]),
      /invalid path: 'external' is not in this catalog/,
    );
  });

  test("self-ref and untargeted Field(Ref) stay in-schema", () => {
    expectOk(compileResource([read(Resource).when(eq(Resource.parent, Resource.parent))]));
    expectOk(compileResource([read(Resource).when(eq(Resource.looseRef, Resource.looseRef))]));
    expectOk(compileResource([read(Resource).when(eq(Resource.userRef, Resource.userRef))]));
  });
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
    const template = expectOk(
      compile([read(Issue.owner).when((owner) => owner.authId.eq(subject))]),
    );
    expect(template.rules[0]?.expr).toEqual({
      _tag: "eq",
      left: {
        _tag: "ref",
        root: { _tag: "resource" },
        steps: [
          { field: { _tag: "RelativeFieldId", owner: issueOwner, localName: "owner" } },
          { field: { _tag: "RelativeFieldId", owner: userOwner, localName: "authId" } },
        ],
      },
      right: { _tag: "subject" },
    });
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
});

describe("public barrels stay closed", () => {
  test("authoring names are not on ramose or ramose/db", async () => {
    const root = await import("../../../src/index.ts");
    const db = await import("../../../src/db/index.ts");
    expect("compileReadAuthorization" in root).toBe(false);
    expect("compileReadAuthorizationResult" in root).toBe(false);
    expect("compileReadAuthorization" in db).toBe(false);
    expect("hasClass" in db).toBe(false);
    expect("compileReadAuthorization" in (await import("../../../src/internal/authorization/index.ts"))).toBe(
      true,
    );
  });
});
