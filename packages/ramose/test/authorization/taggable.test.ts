import { describe, expect, test } from "bun:test";
import { Policy } from "../../src/authorization/compile.ts";
import { App, compileLive, compileTaggablePolicy, Issue, TagGrant, User } from "./fixtures.ts";
import { analyzeExpr } from "../../src/internal/authorization/expr.ts";
import { InvalidTemplate } from "../../src/internal/authorization/errors.ts";

describe("Taggable traversal and hidden policy input", () => {
  test("compiled exists over TagGrant does not require special runtime code", () => {
    const template = compileTaggablePolicy();
    const tagged = template.rules.find((rule) =>
      rule.focus._tag === "trait" && rule.focus.name === "taggable",
    );
    expect(tagged).toBeDefined();
    expect(tagged?.dependencies).toContain("tagGrant");
    expect(tagged?.usesResource).toBe(true);
    expect(tagged?.usesMe).toBe(true);
    const meta = analyzeExpr(tagged!.expr);
    expect(meta.existsNesting).toBe(1);
    expect(meta.traversalDepth).toBeGreaterThanOrEqual(1);
  });

  test("same-entity existential self-joins are allowed", () => {
    const template = compileLive(
      Policy(App, { principal: { subjectClaim: "sub" } }, ({ rule, read, exists, and }) => [
        read(Issue).allow(
          rule(Issue, ({ resource }) =>
            exists(TagGrant, (a) =>
              exists(TagGrant, (b) => and(a.user.eq(resource.owner), b.tag.has())),
            ),
          ),
        ),
      ]),
    );
    const rule = template.rules[0]!;
    expect(rule.existsNesting).toBe(2);
    expect(rule.dependencies).toEqual(["tagGrant"]);
  });

  test("actual recursive named rules are unsupported", () => {
    expect(JSON.stringify(compileTaggablePolicy())).not.toContain("ruleRef");
  });

  test("hidden policy-input facts are named only as rule dependencies", () => {
    const template = compileTaggablePolicy();
    expect(template.decisions.rows.tagGrant).toBeUndefined();
    const tagged = template.rules.find((rule) => rule.dependencies.includes("tagGrant"));
    expect(tagged).toBeDefined();
    void User;
    void InvalidTemplate;
  });
});
