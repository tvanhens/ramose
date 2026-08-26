/** Shared catalog for authorization authoring / IR tests. */

import * as Schema from "effect/Schema";
import {
  Entity,
  Field,
  Operation,
  Ref,
  Schema as DbSchema,
  Trait,
} from "../../src/db/internal.ts";
import {
  and,
  eq,
  exists,
  hasClass,
  read,
  rule,
  run,
  some,
  withOperations,
} from "../../src/authorization/index.ts";

export const User = Entity("user", {
  sub: Field.unique(Schema.String, "upsert"),
});

export const Tag = Entity("tag", {
  name: Field(Schema.String),
});

export const TagGrant = Entity("tagGrant", {
  tag: Field(Ref(() => Tag)),
  user: Field(Ref(() => User)),
});

const TaggableFields = Trait("taggable", {
  tags: Field.many(Ref(() => Tag)),
});

export const addTag = Operation(
  "taggable/add-tag",
  {
    input: Schema.Struct({ tag: Schema.Number }),
    output: Schema.Struct({}),
  },
  () => ({}),
);

export const Taggable = withOperations(TaggableFields, { addTag });

const IssueFields = Entity(
  "issue",
  {
    title: Field(Schema.String),
    owner: Field(Ref(() => User)),
    internalNotes: Field(Schema.String, { optional: true }),
  },
  { traits: [Taggable] },
);

export const App = DbSchema({
  user: User,
  tag: Tag,
  tagGrant: TagGrant,
  issue: IssueFields,
});

const Op = Operation.for(App);

export const rename = Op.patch("issue/rename", IssueFields, ["title"]);
export const seed = Op(
  "issue/seed",
  {
    input: Schema.Struct({ title: Schema.String }),
    output: Schema.Struct({}),
  },
  () => ({}),
);

export const Issue = withOperations(IssueFields, { rename, seed });

export const ownsIssue = rule(Issue, ({ me, resource }) => eq(resource.owner, me));

export const canReadTagged = rule(Taggable, ({ me, resource }) =>
  some(resource.tags, (tag) =>
    exists(TagGrant, (grant) => and(eq(grant.tag, tag), eq(grant.user, me))),
  ),
);

export const supportNotes = hasClass("support");

export const head = {
  schema: App,
  principal: User.sub,
  classes: ["member", "support"] as const,
  claims: Schema.Struct({ org: Schema.String }),
  operations: [rename, addTag, seed],
};

export const taggableBindings = [
  read(Issue).allow(ownsIssue, canReadTagged),
  read(Taggable).allow(canReadTagged),
  read(Issue.internalNotes).allow(supportNotes),
  run(Issue.operations.rename).allow(ownsIssue, canReadTagged),
  run(Taggable.operations.addTag).allow(canReadTagged),
  run(Issue.operations.seed).allow(hasClass("member")),
];
