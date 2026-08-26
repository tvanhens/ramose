/** Compiler rejection: illegal, unbounded, mismatched, inaccessible. */

import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { Entity, Field, PolicyError, Ref, Schema as DbSchema, Trait, type AnyEntity } from "../../src/db/internal.ts";
import {
  and,
  compileAuthorization,
  eq,
  exists,
  hasClass,
  read,
  rule,
  run,
  some,
  type AuthPath,
} from "../../src/authorization/index.ts";
import { App, Issue, TagGrant, Taggable, User, canReadTagged, head, ownsIssue, rename, seed } from "./fixtures.ts";

const compileThrows = (bindings: Parameters<typeof compileAuthorization>[1], headArg = head) => {
  expect(() => compileAuthorization(headArg, bindings)).toThrow(PolicyError);
};

describe("compiler rejection", () => {
  test("resource-dependent rules on targetless operations", () => {
    compileThrows([run(seed).allow(ownsIssue)]);
  });

  test("input is inaccessible on read rules", () => {
    const usesInput = rule(Issue, ({ input, resource }) => eq(resource.title, input.title));
    compileThrows([read(Issue).allow(usesInput)]);
  });

  test("unknown input key on an operation", () => {
    const bad = rule(Issue, ({ input }) => eq(input.missing, "x"));
    compileThrows([run(rename).allow(bad)]);
  });

  test("undeclared claim key", () => {
    const bad = rule(Issue, ({ claims }) => eq(claims.team, "ops"));
    compileThrows([read(Issue).allow(bad)]);
  });

  test("exists() of an entity that is not in the schema", () => {
    const Ghost = Entity("ghost", { name: Field(Schema.String) });
    const bad = rule(Issue, ({ me }) => exists(Ghost, (row) => eq(row.id, me)));
    compileThrows([read(Issue).allow(bad)]);
  });

  test("trait rule on an entity that does not compose the trait", () => {
    compileThrows([read(User).allow(canReadTagged)]);
  });

  test("trait that is not in the catalog", () => {
    const Other = Trait("other", { note: Field(Schema.String) });
    compileThrows([read(Other).allow(hasClass("member"))]);
  });

  test("field that is not in the schema", () => {
    compileThrows([read({ ident: ":issue/missing" }).allow(hasClass("member"))]);
  });

  test("unsupported same-entity exists recursion", () => {
    const loop = rule(Issue, ({ me }) =>
      exists(TagGrant, (a) => exists(TagGrant, (b) => and(eq(a.user, me), eq(b.user, me)))),
    );
    compileThrows([read(Issue).allow(loop)]);
  });

  test("unbounded traversal depth", () => {
    const Deep: AnyEntity = Entity("deep", { next: Field(Ref(() => Deep)) });
    const Catalog = DbSchema({ user: User, deep: Deep });
    const tooDeep = rule(Deep, ({ resource }) => {
      const path = resource as unknown as AuthPath & { next: AuthPath & { next: AuthPath & { next: AuthPath & { next: AuthPath } } } };
      return eq(path.next.next.next.next, 1);
    });
    expect(() =>
      compileAuthorization(
        { schema: Catalog, principal: User.sub, classes: ["member"] },
        [read(Deep).allow(tooDeep)],
      ),
    ).toThrow(PolicyError);
  });

  test("eq() on a card-many path", () => {
    const bad = rule(Taggable, ({ resource, me }) => eq(resource.tags, me));
    compileThrows([read(Taggable).allow(bad)]);
  });

  test("some() on a card-one path", () => {
    const bad = rule(Issue, ({ resource }) => some(resource.owner, (owner) => eq(owner, 1)));
    compileThrows([read(Issue).allow(bad)]);
  });

  test("illegal async rule callback", () => {
    const bad = {
      _tag: "AuthRule" as const,
      focus: Issue,
      body: async () => hasClass("member"),
    };
    compileThrows([read(Issue).allow(bad as never)]);
  });

  test("ambiguous duplicate binding for the same target", () => {
    compileThrows([
      read(Issue).allow(ownsIssue),
      read(Issue).allow(canReadTagged),
    ]);
  });

  test("unknown entity is not in the schema", () => {
    const Extra = Entity("extra", { title: Field(Schema.String) });
    compileThrows([read(Extra).allow(hasClass("member"))]);
  });

  test("empty classes fail closed at compile", () => {
    expect(() =>
      compileAuthorization({ schema: App, principal: User.sub, classes: [] }, [
        read(Issue).allow(hasClass("member")),
      ]),
    ).toThrow(PolicyError);
  });
});
