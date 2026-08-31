import * as EffectSchema from "effect/Schema";
import {
  collectSchemaPolicy,
  type ApplyPolicy,
} from "../../../src/internal/authorization/index.ts";
import {
  Entity,
  Field,
  Ref,
  Schema,
  Trait,
  int,
  string,
} from "../../../src/db/internal.ts";

const Member = Entity("member", {
  subject: Field.unique(string(), "upsert"),
  displayName: string(),
  serial: Field.unique(int(), "strict"),
});
const Commentable = Trait("commentable", {
  commenters: Field.many(Ref(Member)),
});
const Project = Entity(
  "project",
  { owner: Ref(Member), title: string() },
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
const Other = Entity("other", { subject: string() });
const App = Schema("app", { member: Member, project: Project });

const claims = [
  {
    key: "organization",
    optional: false,
    shape: { _tag: "scalar" as const, valueType: "string" as const },
  },
  {
    key: "quota",
    optional: false,
    shape: { _tag: "scalar" as const, valueType: "long" as const },
  },
  {
    key: "teams",
    optional: true,
    shape: {
      _tag: "array" as const,
      items: { _tag: "scalar" as const, valueType: "string" as const },
    },
  },
] as const;

const apply: ApplyPolicy<typeof App.entities> = App.applyPolicy;
void apply;

const typeAssertions = () => {
  collectSchemaPolicy(
    App,
    {
      principal: Member.subject,
      roles: ["member", "admin"] as const,
      claims,
    },
    ({ policy, actor, session, allOf }) => {
      policy.member.read.where((member) => member.eq(actor));
      policy.project.read.where((project) =>
        allOf(project.owner.eq(actor), session.hasRole("member"))
      );
      policy.commentable.read.where((commentable) =>
        commentable.commenters.contains(actor)
      );
      policy.project.fields.title.read.always();
      policy.project.fields.title.read.where((project) => project.owner.eq(actor));
      policy.project.operations.rename.where(session.hasRole("admin"));
      session.subject.eq(session.claims.organization);
      session.claims.quota.eq(1);
      session.claims.teams.contains("platform");

      // @ts-expect-error — this role is not declared by the schema policy
      session.hasRole("owner");
      // @ts-expect-error — this claim is not declared by the schema policy
      session.claims.team;
      // @ts-expect-error — this claim contains strings
      session.claims.organization.eq(123);
      // @ts-expect-error — scalar claims are not collections
      session.claims.organization.contains("platform");
      // @ts-expect-error — this numeric claim does not contain strings
      session.claims.quota.eq("one");
      // @ts-expect-error — this claim is an array of strings
      session.claims.teams.contains(123);
      // @ts-expect-error — this entity is not in the schema
      policy.other;
      // @ts-expect-error — this field is not in the entity
      policy.project.fields.secret;
      // @ts-expect-error — this operation is not in the entity
      policy.project.operations.archive;
    },
  );

  collectSchemaPolicy(
    App,
    {
      // @ts-expect-error — the principal field is not in this schema
      principal: Other.subject,
    },
    () => {},
  );

  collectSchemaPolicy(
    App,
    {
      // @ts-expect-error — the principal field must be unique
      principal: Member.displayName,
    },
    () => {},
  );

  collectSchemaPolicy(
    App,
    {
      // @ts-expect-error — the principal field must be string-compatible
      principal: Member.serial,
    },
    () => {},
  );
};

void typeAssertions;
