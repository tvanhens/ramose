/**
 * Compile-time fixtures for the authorization authoring API.
 * `bun run typecheck` compiles this file.
 */

import { test } from "bun:test";
import type { Equal, Expect } from "../../src/db/internal.ts";
import {
  compileAuthorization,
  eq,
  hasClass,
  read,
  rule,
  run,
  type AuthorizationIR,
  type Snapshot,
} from "../../src/authorization/index.ts";
import { Issue, Taggable, User, canReadTagged, head, ownsIssue, seed } from "./fixtures.ts";

type _compileReturnsIR = Expect<Equal<ReturnType<typeof compileAuthorization>, AuthorizationIR>>;
type _issueOwner = Expect<
  Equal<keyof Snapshot<typeof Issue>, "title" | "owner" | "internalNotes" | "tags" | "id">
>;
type _taggableTags = Expect<Equal<keyof Snapshot<typeof Taggable>, "tags">>;

const _fixtures = () => {
  read(Issue).allow(ownsIssue, canReadTagged);
  read(Taggable).allow(canReadTagged);
  read(Issue.internalNotes).allow(hasClass("support"));
  run(Issue.operations.rename).allow(ownsIssue, canReadTagged);
  run(Taggable.operations.addTag).allow(canReadTagged);
  run(seed).allow(hasClass("member"));

  rule(Issue, ({ me, resource }) => eq(resource.owner, me));
  rule(Issue, ({ resource }) => eq(resource.title, "x"));
  rule(User, ({ me, resource }) => eq(resource.id, me));

  // @ts-expect-error — not a field of Issue
  (null as unknown as Snapshot<typeof Issue>).missing;

  return compileAuthorization(head, [read(Issue).allow(ownsIssue)]);
};

test("authorization type fixtures compile", () => {
  void _fixtures;
});
