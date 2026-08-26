import { describe, expect, test } from "bun:test";
import { Policy } from "../../src/authorization/compile.ts";
import { bindAuthorization } from "../../src/authorization/bind.ts";
import { App, catalog, compileLive, User } from "./fixtures.ts";
import {
  authorizeRow,
  createBudget,
  type EvalContext,
} from "../../src/internal/authorization/eval.ts";
import { Absent, Present, True } from "../../src/internal/authorization/truth.ts";

const evalCtx = (over: Partial<EvalContext["principal"]> = {}): EvalContext => ({
  principal: {
    subject: "svc-1",
    classes: new Set(["member"]),
    claims: new Map([["org", Present("acme")]]),
    me: Absent,
    ...over,
  },
  resource: { _tag: "Record", record: {
    id: 1,
    entity: "user",
    traits: new Set(),
    fields: new Map([["entity:user/name", Present("Ada")]]),
  } },
  input: new Map(),
  snapshot: { entities: new Map(), byId: new Map() },
  budget: createBudget(),
  bindings: new Map(),
});

describe("optional principal row", () => {
  test("service JWT principals work without an application row", () => {
    const template = compileLive(
      Policy(App, {
        principal: { subjectClaim: "sub" },
        claims: undefined,
        classes: ["member"],
      }, ({ read, hasClass }) => [read(User).allow(hasClass("member"))]),
    );
    const installed = compileLive(bindAuthorization(template, catalog));
    expect(authorizeRow(installed, "user", evalCtx())).toEqual(True);
  });

  test("a rule that requires me is incomplete when no row resolves", () => {
    const template = compileLive(
      Policy(App, {
        principal: { subjectClaim: "sub", entity: User.authId },
        classes: [],
      }, ({ rule, read }) => [
        read(User).allow(rule(User, ({ me, resource }) => resource.id.eq(me))),
      ]),
    );
    const installed = compileLive(bindAuthorization(template, catalog));
    const truth = authorizeRow(installed, "user", evalCtx({ me: Absent }));
    expect(truth._tag).toBe("Incomplete");
    expect(truth).not.toEqual(True);
  });

  test("claims and class-only rules work without me", () => {
    const template = compileLive(
      Policy(App, {
        principal: { subjectClaim: "sub" },
        classes: ["support"],
      }, ({ read, hasClass }) => [read(User).allow(hasClass("support"))]),
    );
    const installed = compileLive(bindAuthorization(template, catalog));
    expect(
      authorizeRow(
        installed,
        "user",
        evalCtx({ classes: new Set(["support"]), me: Absent }),
      ),
    ).toEqual(True);
  });

  test("declared class vocabularies may be empty", () => {
    const template = compileLive(
      Policy(App, { principal: { subjectClaim: "sub" }, classes: [] }, ({ read, always }) => [
        read(User).allow(always),
      ]),
    );
    expect(template.classes).toEqual([]);
  });
});
