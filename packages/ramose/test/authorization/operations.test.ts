import { describe, expect, test } from "bun:test";
import { Policy } from "../../src/authorization/compile.ts";
import { bindAuthorization } from "../../src/authorization/bind.ts";
import {
  App,
  catalog,
  compileLive,
  Issue,
  issueOps,
  taggableOps,
  User,
} from "./fixtures.ts";
import { InvalidTemplate } from "../../src/internal/authorization/errors.ts";
import {
  authorizeOperation,
  createBudget,
} from "../../src/internal/authorization/eval.ts";
import { Present, True } from "../../src/internal/authorization/truth.ts";

describe("owned operations", () => {
  test("targeted entity operations receive a resource", () => {
    const template = compileLive(
      Policy(App, { principal: { subjectClaim: "sub" } }, ({ rule, run }) => [
        run(issueOps.rename).allow(
          rule(issueOps.rename, ({ resource, input }) => {
            void resource;
            return input.title.has();
          }),
        ),
      ]),
    );
    const installed = compileLive(bindAuthorization(template, catalog));
    expect(
      authorizeOperation(
        installed,
        { owner: { kind: "entity", name: "issue" }, localName: "rename", target: "required" },
        {
          principal: {
            subject: "s",
            classes: new Set(),
            claims: new Map(),
            me: Present(1),
          },
          resource: {
            _tag: "Record",
            record: {
              id: 10,
              entity: "issue",
              traits: new Set(),
              fields: new Map(),
            },
          },
          input: new Map([["title", Present("x")]]),
          snapshot: { entities: new Map(), byId: new Map() },
          budget: createBudget(),
          bindings: new Map(),
        },
      ),
    ).toEqual(True);
  });

  test("targetless entity operations reject resource-dependent rules", () => {
    expect(() =>
      compileLive(
        Policy(App, { principal: { subjectClaim: "sub" } }, ({ rule, run }) => [
          run(issueOps.create).allow(
            rule(issueOps.create, () => ({
              _tag: "AuthExpr",
              expr: {
                _tag: "eq",
                left: {
                  _tag: "path",
                  path: { root: { _tag: "resource" }, steps: [] },
                },
                right: { _tag: "me" },
              },
            })),
          ),
        ]),
      ),
    ).toThrow(InvalidTemplate);
  });

  test("targetless trait operations require a reachable trait", () => {
    const template = compileLive(
      Policy(App, { principal: { subjectClaim: "sub" } }, ({ run, always }) => [
        run(taggableOps.addTag).allow(always),
      ]),
    );
    expect(template.decisions.operations["trait:taggable/addTag:required"]).toBeDefined();
  });

  test("self:false is target none, not ownerless", () => {
    expect(issueOps.create.target).toBe("none");
    expect(issueOps.create.owner).toBe(Issue);
    expect(issueOps.rename.target).toBe("required");
    expect(issueOps.rename.localName).toBe("rename");
    void User;
  });
});
