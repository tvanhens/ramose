/**
 * Type-level fixtures for the authoring API.
 * `bun run typecheck` compiles this file.
 */

import { test } from "bun:test";
import * as Schema from "effect/Schema";
import type { Expect, Equal, Extends } from "../../src/db/equal.ts";
import type {
  EntityRuleContext,
  ResourceSnapshot,
  RuleContext,
  TargetedOpContext,
  TargetlessOpContext,
} from "../../src/authorization/authoring.ts";
import type { ClaimCell, PathCell } from "../../src/authorization/expr.ts";
import { Policy } from "../../src/authorization/compile.ts";
import {
  App,
  ClaimsSchema,
  Issue,
  Taggable,
  User,
  issueOps,
  taggableOps,
} from "./fixtures.ts";

type IssueResource = ResourceSnapshot<typeof Issue>;
type _issueTitle = Expect<Extends<IssueResource["title"], PathCell>>;
type _issueOwner = Expect<Extends<IssueResource["owner"], PathCell>>;
type _issueId = Expect<Extends<IssueResource["id"], PathCell>>;

type Claims = { readonly org: ClaimCell };
type EntityCtx = EntityRuleContext<typeof Issue, Claims>;
type _entityHasResource = Expect<Extends<EntityCtx["resource"], IssueResource>>;
type _entityHasMe = Expect<Equal<keyof EntityCtx, "me" | "subject" | "claims" | "resource">>;

type Targeted = TargetedOpContext<typeof Issue, { title: string }, Claims>;
type _targetedHasResource = Expect<Extends<"resource", keyof Targeted>>;
type _targetedHasInput = Expect<Extends<"input", keyof Targeted>>;

type Targetless = TargetlessOpContext<{ title: string }, Claims>;
type _targetlessKeys = Expect<Equal<keyof Targetless, "me" | "subject" | "claims" | "input">>;
type _targetlessNoResource = Expect<
  Equal<Extends<"resource", keyof Targetless>, false>
>;

type RenameCtx = RuleContext<typeof issueOps.rename, Claims>;
type _renameIsTargeted = Expect<Extends<RenameCtx, TargetedOpContext<typeof Issue, { title: string }, Claims>>>;

type CreateCtx = RuleContext<typeof issueOps.create, Claims>;
type _createIsTargetless = Expect<Equal<Extends<"resource", keyof CreateCtx>, false>>;

const _fixtures = () => {
  Policy(App, {
    principal: { subjectClaim: "sub", entity: User.authId },
    claims: ClaimsSchema,
    classes: ["member", "support"],
  }, ({ rule, read, run, always, self, hasClass, and }) => {
    const ownsIssue = rule(Issue, ({ me, resource, claims }) => {
      resource.title.eq("x");
      resource.owner.eq(me);
      claims.org.eq("acme");
      // @ts-expect-error — `team` is not a declared claim
      claims.team;
      return resource.owner.eq(me);
    });

    const tagged = rule(Taggable, ({ resource }) => resource.tags.has());

    const validRename = rule(issueOps.rename, ({ resource, input }) => {
      input.title.has();
      resource.owner.has();
      // @ts-expect-error — `body` is not an input key
      input.body;
      return and(resource.owner.has(), input.title.has());
    });

    const createOnly = rule(issueOps.create, (ctx) => {
      ctx.input.title.has();
      // @ts-expect-error — targetless operation context has no resource
      ctx.resource;
      return ctx.input.title.has();
    });

    return [
      read(Issue).allow(ownsIssue, tagged),
      read(User).allow(self),
      read(Issue.internalNotes).allow(hasClass("support")),
      run(issueOps.rename).allow(validRename),
      run(issueOps.create).allow(createOnly),
      run(taggableOps.addTag).allow(tagged),
      read(Taggable).allow(always),
    ];
  });
};

test("authorization type fixtures compile", () => {
  expectType(_fixtures);
});

const expectType = (_fn: () => unknown): void => undefined;
