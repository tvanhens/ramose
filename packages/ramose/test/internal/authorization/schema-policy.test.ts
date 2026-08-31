import { describe, expect, test } from "bun:test";
import * as EffectSchema from "effect/Schema";
import * as Result from "effect/Result";
import {
  all,
  allow,
  any,
  collectSchemaPolicy,
  compileReadAuthorizationResult,
  eq,
  hasClass,
  invoke,
  me,
  read,
  subject,
} from "../../../src/internal/authorization/index.ts";
import {
  Entity,
  Field,
  OwnedOperations,
  Ref,
  Schema,
  Trait,
  string,
} from "../../../src/db/internal.ts";
import "./schema-policy-types.ts";

const Member = Entity("member", {
  subject: Field.unique(string(), "upsert"),
});

const Commentable = Trait("commentable", {
  commenters: Field.many(Ref(Member)),
});

const Project = Entity(
  "project",
  {
    owner: Ref(Member),
    title: string(),
    privateNote: string(),
  },
  {
    traits: [Commentable],
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

const App = Schema("app", { member: Member, project: Project });

const organizationClaim = {
  key: "organization",
  optional: false,
  shape: { _tag: "scalar" as const, valueType: "string" as const },
};

describe("schema policy authoring", () => {
  test("collects typed entity, trait, field, and operation rules", () => {
    const input = collectSchemaPolicy(
      App,
      {
        principal: Member.subject,
        roles: ["member", "admin"] as const,
        claims: [organizationClaim] as const,
      },
      ({ policy, actor, session, allOf }) => {
        policy.member.read.where((member) => member.eq(actor));
        policy.project.read.where((project) =>
          allOf(
            project.owner.eq(actor),
            session.hasRole("member"),
            session.subject.eq(session.claims.organization),
          )
        );
        policy.commentable.read.where((commentable) =>
          commentable.commenters.contains(actor)
        );
        policy.project.fields.privateNote.read.never();
        policy.project.fields.title.read.always();
        policy.project.operations.rename.where(session.roles.admin);
      },
    );

    expect(input.classes).toEqual(["member", "admin"]);
    expect(input.claims).toEqual([organizationClaim]);
    expect(input.principal).toEqual({ entity: Member.subject });
    expect(input.rules).toHaveLength(6);

    const compiled = compileReadAuthorizationResult(input);
    if (Result.isFailure(compiled)) throw compiled.failure;
    expect(compiled.success.decisions.entities).toHaveLength(2);
    expect(compiled.success.decisions.traits).toHaveLength(1);
    expect(compiled.success.decisions.fields).toHaveLength(2);
    expect(compiled.success.decisions.operations).toHaveLength(1);
    expect(compiled.success.rules[0]).toMatchObject({
      expr: {
        _tag: "eq",
        left: { _tag: "ref", root: { _tag: "resource" }, steps: [] },
        right: { _tag: "me" },
      },
      usesResource: true,
      usesMe: true,
      traversalDepth: 0,
    });

    const privateNote = input.rules[3];
    expect(privateNote).toMatchObject({
      _tag: "ReadRule",
      target: Project.privateNote,
      kind: "deny",
      expr: { _tag: "const", value: true },
    });
    expect(input.rules[4]).toMatchObject({
      _tag: "ReadRule",
      target: Project.title,
      kind: "allow",
      expr: { _tag: "const", value: true },
    });
    expect(input.rules[5]).toMatchObject({
      _tag: "InvokeRule",
      target: Project[OwnedOperations].rename,
      kind: "allow",
      expr: { _tag: "hasClass", class: "admin" },
    });
  });

  test("supports the callback-only form", () => {
    const input = collectSchemaPolicy(App, ({ policy }) => {
      policy.project.read.always();
    });
    expect(input.rules).toHaveLength(1);
    expect(input.classes).toEqual([]);
    expect(input.claims).toEqual([]);
  });

  test("combines repeated decisions into one normalized OR rule", () => {
    const roles = ["member", "admin"] as const;
    const collected = collectSchemaPolicy(
      App,
      { roles },
      ({ policy, session }) => {
        policy.project.read.where(session.roles.member);
        policy.project.read.where(session.roles.admin);
        policy.project.read.denyWhere(session.roles.member);
        policy.project.read.denyWhere(session.subject.eq("blocked"));
        policy.project.operations.rename.where(session.roles.member);
        policy.project.operations.rename.where(session.roles.admin);
      },
    );
    const authored = {
      schema: App,
      classes: roles,
      claims: [],
      rules: [
        read(Project).when(any(hasClass("member"), hasClass("admin"))),
        read(Project).deny(
          any(hasClass("member"), eq(subject, "blocked")),
        ),
        invoke(Project[OwnedOperations].rename).when(
          any(hasClass("member"), hasClass("admin")),
        ),
      ],
    };

    const collectedResult = compileReadAuthorizationResult(collected);
    const authoredResult = compileReadAuthorizationResult(authored);
    if (Result.isFailure(collectedResult)) throw collectedResult.failure;
    if (Result.isFailure(authoredResult)) throw authoredResult.failure;
    expect(collectedResult.success).toEqual(authoredResult.success);
  });

  test("field rules receive the owning resource row", () => {
    const input = collectSchemaPolicy(App, ({ policy, actor }) => {
      policy.project.fields.privateNote.read.where((project) =>
        project.owner.eq(actor)
      );
    });
    const compiled = compileReadAuthorizationResult(input);
    if (Result.isFailure(compiled)) throw compiled.failure;
    expect(compiled.success.rules[0]).toMatchObject({
      focus: {
        _tag: "field",
        field: { owner: { kind: "entity", name: "project" }, localName: "privateNote" },
      },
      expr: {
        _tag: "eq",
        left: {
          _tag: "ref",
          root: { _tag: "resource" },
          steps: [{ field: { owner: { kind: "entity", name: "project" }, localName: "owner" } }],
        },
        right: { _tag: "me" },
      },
    });
  });

  test("snapshots role and claim declarations", () => {
    const roles = ["member"];
    const mutableClaim = {
      key: "organization",
      optional: false,
      shape: { _tag: "scalar" as const, valueType: "string" as const },
    };
    const claims = [mutableClaim];
    const input = collectSchemaPolicy(
      App,
      { roles, claims },
      ({ policy, session }) => {
        policy.project.read.where(session.hasRole("member"));
      },
    );

    roles.push("admin");
    mutableClaim.key = "changed";
    claims.push({ ...mutableClaim });

    expect(input.classes).toEqual(["member"]);
    expect(input.claims).toEqual([organizationClaim]);
  });

  test("creates the same normalized policy as the existing compiler input", () => {
    const config = {
      principal: Member.subject,
      roles: ["member", "admin"] as const,
      claims: [organizationClaim] as const,
    };
    const collected = collectSchemaPolicy(
      App,
      config,
      ({ policy, actor, session, allOf }) => {
        policy.project.read.where((project) =>
          allOf(project.owner.eq(actor), session.hasRole("member"))
        );
        policy.project.fields.privateNote.read.never();
        policy.project.operations.rename.where(session.hasRole("admin"));
      },
    );
    const authored = {
      schema: App,
      principal: { entity: Member.subject },
      classes: config.roles,
      claims: config.claims,
      rules: [
        read(Project).when(all(eq(Project.owner, me), hasClass("member"))),
        read(Project.privateNote).deny(allow),
        invoke(Project[OwnedOperations].rename).when(hasClass("admin")),
      ],
    };

    const collectedResult = compileReadAuthorizationResult(collected);
    const authoredResult = compileReadAuthorizationResult(authored);
    if (Result.isFailure(collectedResult)) throw collectedResult.failure;
    if (Result.isFailure(authoredResult)) throw authoredResult.failure;
    expect(collectedResult.success).toEqual(authoredResult.success);
  });

  test("rejects invalid rules before deployment", () => {
    const External = Entity("external", { name: string() });
    expect(() =>
      collectSchemaPolicy(App, ({ policy }) => {
        policy.project.read.where(eq(External.name, "outside"));
      })
    ).toThrow(/not in this catalog/);

    expect(() =>
      collectSchemaPolicy(App, ({ policy }) => {
        policy.project.operations.rename.where(eq(Project.owner, "outside"));
      })
    ).toThrow(/principal classes, claims, and subject identity/);

    expect(() =>
      collectSchemaPolicy(
        App,
        { roles: ["member"] as const },
        ({ session }) => {
          session.hasRole("admin" as "member");
        },
      )
    ).toThrow(/undeclared role/);
  });

  test("a failed callback still consumes the policy registration", () => {
    const Broken = Schema("broken-policy", { member: Member });
    expect(() =>
      Broken.applyPolicy(() => {
        throw new Error("broken callback");
      })
    ).toThrow(/broken callback/);
    expect(() => Broken.applyPolicy(() => {})).toThrow(/already applied/);
  });

  test("rejects asynchronous policy callbacks", () => {
    expect(() =>
      collectSchemaPolicy(App, async ({ policy }) => {
        policy.project.read.always();
        await Promise.resolve();
      })
    ).toThrow(/policy callback must be synchronous/);
  });
});
