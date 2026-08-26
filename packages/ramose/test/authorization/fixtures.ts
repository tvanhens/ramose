/** Shared Taggable catalog used across authorization tests. */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  bindAuthorization,
  catalogDescriptorFrom,
  operation,
  operations,
  Policy,
} from "../../src/authorization/index.ts";
import { Entity } from "../../src/db/Entity.ts";
import { Field, Ref, string } from "../../src/db/Field.ts";
import { Schema as DbSchema } from "../../src/db/Schema.ts";
import { Trait } from "../../src/db/Trait.ts";
import { AuthorizationHashLive } from "../../src/internal/authorization/services.ts";
import type { PolicyTemplateIR } from "../../src/internal/authorization/template.ts";
import type { SealedInstalledAuthorizationIR } from "../../src/internal/authorization/installed.ts";

export const User = Entity("user", {
  authId: Field.unique(Schema.String, "upsert"),
  name: string(),
});

export const Tag = Entity("tag", {
  name: string(),
});

export const Taggable = Trait("taggable", {
  tags: Field.many(Ref(() => Tag)),
});

export const Issue = Entity(
  "issue",
  {
    title: string(),
    owner: Ref(() => User),
    internalNotes: string({ optional: true }),
  },
  { traits: [Taggable] },
);

export const TagGrant = Entity("tagGrant", {
  user: Ref(() => User),
  tag: Ref(() => Tag),
});

export const App = DbSchema({
  user: User,
  tag: Tag,
  issue: Issue,
  tagGrant: TagGrant,
});

export const ClaimsSchema = Schema.Struct({
  org: Schema.String,
});

export const issueOps = operations(Issue, {
  rename: { input: Schema.Struct({ title: Schema.String }) },
  create: { self: false, input: Schema.Struct({ title: Schema.String }) },
});

export const taggableOps = operations(Taggable, {
  addTag: { input: Schema.Struct({ tag: Schema.String }) },
});

export const allOperations = [
  issueOps.rename,
  issueOps.create,
  taggableOps.addTag,
];

export const catalog = catalogDescriptorFrom({
  catalogId: "app",
  catalogVersion: "v1",
  schema: App,
  operations: allOperations,
});

export const compileLive = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): A => Effect.runSync(effect.pipe(Effect.provide(AuthorizationHashLive)) as Effect.Effect<A, E>);

export const compileTaggablePolicy = (): PolicyTemplateIR =>
  compileLive(
    Policy(App, {
      principal: { subjectClaim: "sub", entity: User.authId },
      claims: ClaimsSchema,
      classes: ["member", "support", "admin"],
    }, ({ rule, read, run, always, self, hasClass, exists, and }) => {
      const ownsIssue = rule(Issue, ({ me, resource }) => resource.owner.eq(me));
      const canReadTagged = rule(Taggable, ({ me, resource }) =>
        resource.tags.some((tag) =>
          exists(TagGrant, (grant) => and(grant.user.eq(me), grant.tag.eq(tag))),
        ),
      );
      const validRename = rule(issueOps.rename, ({ me, resource, input }) =>
        and(resource.owner.eq(me), input.title.has()),
      );
      return [
        read(User).allow(self),
        read(Tag).allow(always),
        read(Issue).allow(ownsIssue, canReadTagged),
        read(Taggable).allow(canReadTagged),
        read(Issue.internalNotes).allow(hasClass("support")),
        run(issueOps.rename).allow(validRename),
        run(taggableOps.addTag).allow(canReadTagged),
      ];
    }),
  );

export const installTaggablePolicy = (): SealedInstalledAuthorizationIR =>
  compileLive(bindAuthorization(compileTaggablePolicy(), catalog));

void operation;
