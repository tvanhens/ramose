import { describe, expect, test } from "bun:test";
import {
  authorizeField,
  authorizeOperation,
  authorizeRow,
  authorizeTrait,
  createBudget,
  evaluateDecision,
  evaluateExpr,
  type EvalContext,
  type RuleRecord,
} from "../../src/internal/authorization/eval.ts";
import {
  Absent,
  False,
  Incomplete,
  Present,
  True,
  Unavailable,
} from "../../src/internal/authorization/truth.ts";
import { isPolicyTemplateIR } from "../../src/internal/authorization/template.ts";
import { isSealedInstalled } from "../../src/internal/authorization/installed.ts";
import {
  compileTaggablePolicy,
  installTaggablePolicy,
  Issue,
} from "./fixtures.ts";
import { relativeOperationKey } from "../../src/internal/authorization/identity.ts";

const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({
  principal: {
    subject: "user-1",
    classes: new Set(),
    claims: new Map(),
    me: Present(1),
  },
  resource: { _tag: "Record", record: {
    id: 10,
    entity: "issue",
    traits: new Set(["taggable"]),
    fields: new Map([
      ["entity:issue/owner", Present(1)],
      ["entity:issue/title", Present("Bug")],
      ["trait:taggable/tags", { _tag: "PresentMany", values: [20] }],
    ]),
  } },
  input: new Map([["title", Present("Renamed")]]),
  snapshot: {
    entities: new Map([
      [
        "tagGrant",
        {
          _tag: "Loaded",
          records: [
            {
              id: 30,
              entity: "tagGrant",
              traits: new Set(),
              fields: new Map([
                ["entity:tagGrant/user", Present(1)],
                ["entity:tagGrant/tag", Present(20)],
              ]),
            } satisfies RuleRecord,
          ],
        },
      ],
    ]),
    byId: new Map([
      [1, {
        id: 1,
        entity: "user",
        traits: new Set(),
        fields: new Map([["entity:user/name", Present("Ada")]]),
      }],
      [20, {
        id: 20,
        entity: "tag",
        traits: new Set(),
        fields: new Map([["entity:tag/name", Present("urgent")]]),
      }],
    ]),
  },
  budget: createBudget(),
  bindings: new Map(),
  ...over,
});

describe("three-valued evaluator", () => {
  test("eq truth table", () => {
    expect(evaluateExpr(
      { _tag: "eq", left: { _tag: "lit", value: 1 }, right: { _tag: "lit", value: 1 } },
      ctx(),
    )).toEqual(True);
    expect(evaluateExpr(
      { _tag: "eq", left: { _tag: "lit", value: 1 }, right: { _tag: "lit", value: 2 } },
      ctx(),
    )).toEqual(False);
    const absentEq = evaluateExpr(
      { _tag: "eq", left: { _tag: "claim", key: "missing" }, right: { _tag: "claim", key: "missing" } },
      ctx({
        principal: {
          subject: "s",
          classes: new Set(),
          claims: new Map([
            ["missing", Absent],
          ]),
          me: Absent,
        },
      }),
    );
    expect(absentEq).toEqual(True);
    const unavailable = evaluateExpr(
      { _tag: "eq", left: { _tag: "claim", key: "a" }, right: { _tag: "claim", key: "b" } },
      ctx({
        principal: {
          subject: "s",
          classes: new Set(),
          claims: new Map(),
          me: Absent,
        },
      }),
    );
    expect(unavailable._tag).toBe("Incomplete");
  });

  test("comparing two unavailable values never returns true", () => {
    const truth = evaluateExpr(
      { _tag: "eq", left: { _tag: "claim", key: "a" }, right: { _tag: "claim", key: "b" } },
      ctx({
        principal: {
          subject: "s",
          classes: new Set(),
          claims: new Map([
            ["a", Unavailable({ _tag: "NotLoaded", detail: "a" })],
            ["b", Unavailable({ _tag: "NotLoaded", detail: "b" })],
          ]),
          me: Absent,
        },
      }),
    );
    expect(truth._tag).toBe("Incomplete");
    expect(truth).not.toEqual(True);
  });

  test("negation does not turn incomplete into allow", () => {
    const truth = evaluateExpr(
      {
        _tag: "not",
        expr: { _tag: "eq", left: { _tag: "claim", key: "a" }, right: { _tag: "lit", value: 1 } },
      },
      ctx({
        principal: {
          subject: "s",
          classes: new Set(),
          claims: new Map(),
          me: Absent,
        },
      }),
    );
    expect(truth._tag).toBe("Incomplete");
    expect(truth).not.toEqual(True);
  });

  test("incomplete deny arm denies the overall decision", () => {
    const truth = evaluateDecision(
      { allow: ["allow"], deny: ["deny"] },
      new Map([
        ["allow", { _tag: "const", value: true }],
        ["deny", { _tag: "eq", left: { _tag: "claim", key: "x" }, right: { _tag: "lit", value: 1 } }],
      ]),
      ctx({
        principal: {
          subject: "s",
          classes: new Set(),
          claims: new Map(),
          me: Absent,
        },
      }),
    );
    expect(truth).toEqual(False);
  });

  test("incomplete allow arm cannot authorize", () => {
    const truth = evaluateDecision(
      { allow: ["allow"], deny: [] },
      new Map([
        ["allow", { _tag: "eq", left: { _tag: "claim", key: "x" }, right: { _tag: "lit", value: 1 } }],
      ]),
      ctx({
        principal: {
          subject: "s",
          classes: new Set(),
          claims: new Map(),
          me: Absent,
        },
      }),
    );
    expect(truth._tag).toBe("Incomplete");
    expect(truth).not.toEqual(True);
  });

  test("explicit deny wins over allow", () => {
    const truth = evaluateDecision(
      { allow: ["allow"], deny: ["deny"] },
      new Map([
        ["allow", { _tag: "const", value: true }],
        ["deny", { _tag: "const", value: true }],
      ]),
      ctx(),
    );
    expect(truth).toEqual(False);
  });

  test("missing decision denies", () => {
    expect(evaluateDecision(undefined, new Map(), ctx())).toEqual(False);
  });

  test("authoritatively absent optional data is usable", () => {
    expect(evaluateExpr(
      { _tag: "has", operand: { _tag: "claim", key: "org" } },
      ctx({
        principal: {
          subject: "s",
          classes: new Set(),
          claims: new Map([["org", Absent]]),
          me: Absent,
        },
      }),
    )).toEqual(False);
  });

  test("Taggable grant traversal authorizes through the rule snapshot", () => {
    const installed = installTaggablePolicy();
    const truth = authorizeRow(installed, "issue", ctx());
    expect(truth).toEqual(True);
  });

  test("runtime rejects an unbound template", () => {
    const template = compileTaggablePolicy();
    expect(isPolicyTemplateIR(template)).toBe(true);
    expect(isSealedInstalled(template)).toBe(false);
    const truth = authorizeRow(template as never, "issue", ctx());
    expect(truth._tag).toBe("Incomplete");
  });

  test("trait field is ANDed with the composing row", () => {
    const installed = installTaggablePolicy();
    const deniedRow = ctx({
      resource: {
        _tag: "Record",
        record: {
          id: 11,
          entity: "issue",
          traits: new Set(["taggable"]),
          fields: new Map([
            ["entity:issue/owner", Present(99)],
            ["trait:taggable/tags", { _tag: "PresentMany", values: [] }],
          ]),
        },
      },
    });
    expect(authorizeRow(installed, "issue", deniedRow)).toEqual(False);
    expect(authorizeTrait(installed, "issue", "taggable", deniedRow)).toEqual(False);
  });

  test("field narrowing cannot grant what the row denied", () => {
    const installed = installTaggablePolicy();
    const other = ctx({
      resource: {
        _tag: "Record",
        record: {
          id: 12,
          entity: "issue",
          traits: new Set(["taggable"]),
          fields: new Map([["entity:issue/owner", Present(99)]]),
        },
      },
    });
    expect(
      authorizeField(installed, "issue", "entity:issue/internalNotes", undefined, other),
    ).toEqual(False);
  });

  test("operation decision is keyed by owner/localName/target", () => {
    const installed = installTaggablePolicy();
    const truth = authorizeOperation(
      installed,
      { owner: { kind: "entity", name: "issue" }, localName: "rename", target: "required" },
      ctx(),
    );
    expect(truth).toEqual(True);
    expect(
      installed.decisions.operations[relativeOperationKey({
        owner: { kind: "entity", name: "issue" },
        localName: "rename",
        target: "required",
      })],
    ).toBeDefined();
  });
});

void Issue;
