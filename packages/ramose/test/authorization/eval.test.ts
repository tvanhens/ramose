/**
 * IR evaluation: fail-closed, deny-wins, Taggable traversal.
 * Imports only the runtime module — not authoring callbacks.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizeField,
  authorizeOperation,
  authorizeRow,
  type EvalCtx,
  type RuleRecord,
} from "../../src/internal/authorization/index.ts";
import { compileAuthorization, eq, read, rule } from "../../src/authorization/index.ts";
import { head, Issue, ownsIssue, taggableBindings } from "./fixtures.ts";

const ir = compileAuthorization(head, taggableBindings);

const alice = 10;
const issueId = 1;
const tagId = 100;
const grantId = 200;

const issueOwned: RuleRecord = {
  id: issueId,
  type: "issue",
  traits: ["taggable"],
  attrs: {
    ":issue/title": "Bug",
    ":issue/owner": alice,
    ":issue/internalNotes": "secret",
    ":taggable/tags": [tagId],
  },
};

const grant: RuleRecord = {
  id: grantId,
  type: "tagGrant",
  attrs: { ":tagGrant/tag": tagId, ":tagGrant/user": alice },
};

const snapshot = (grants: readonly RuleRecord[] = [grant]): EvalCtx["entities"] => ({
  issue: [issueOwned],
  tag: [{ id: tagId, type: "tag", attrs: { ":tag/name": "ops" } }],
  tagGrant: grants,
  user: [{ id: alice, type: "user", attrs: { ":user/sub": "alice" } }],
});

const ctx = (over: Partial<EvalCtx> = {}): EvalCtx => ({
  me: alice,
  classes: ["member"],
  claims: { org: "acme" },
  resource: issueOwned,
  entities: snapshot(),
  ...over,
});

describe("IR evaluation", () => {
  test("owner can read the issue row; a stranger cannot", () => {
    expect(authorizeRow(ir, "issue", ctx())).toBe(true);
    expect(authorizeRow(ir, "issue", ctx({ me: 99 }))).toBe(false);
  });

  test("Taggable grants via Tag → TagGrant on the rule snapshot", () => {
    const other: RuleRecord = {
      ...issueOwned,
      id: 2,
      attrs: { ...issueOwned.attrs, ":issue/owner": 99, ":taggable/tags": [tagId] },
    };
    expect(authorizeRow(ir, "issue", ctx({ resource: other }))).toBe(true);
    expect(authorizeRow(ir, "issue", ctx({ resource: other, entities: snapshot([]) }))).toBe(false);
  });

  test("policy-input TagGrant facts are read but missing grants deny", () => {
    const other: RuleRecord = {
      ...issueOwned,
      attrs: { ...issueOwned.attrs, ":issue/owner": 99, ":taggable/tags": [tagId] },
    };
    const hiddenGrant = ctx({ resource: other });
    expect(authorizeRow(ir, "issue", hiddenGrant)).toBe(true);
    expect(hiddenGrant.entities.tagGrant?.[0]?.id).toBe(grantId);
  });

  test("missing row / operation / trait policy fails closed", () => {
    expect(authorizeRow(ir, "tag", ctx())).toBe(false);
    expect(authorizeRow(ir, "missing", ctx())).toBe(false);
    expect(authorizeOperation(ir, "issue/missing", ctx())).toBe(false);
    expect(authorizeField(ir, { entity: "issue", fieldIdent: ":taggable/tags", trait: "absent" }, ctx())).toBe(
      false,
    );
  });

  test("trait fields AND the composing row policy (POL-2 / POL-5)", () => {
    expect(authorizeField(ir, { entity: "issue", fieldIdent: ":taggable/tags", trait: "taggable" }, ctx())).toBe(
      true,
    );
    const noTrait = compileAuthorization(head, [
      taggableBindings[0]!,
      taggableBindings[2]!,
      taggableBindings[3]!,
      taggableBindings[4]!,
      taggableBindings[5]!,
    ]);
    expect(
      authorizeField(noTrait, { entity: "issue", fieldIdent: ":taggable/tags", trait: "taggable" }, ctx()),
    ).toBe(false);
    expect(authorizeRow(noTrait, "issue", ctx())).toBe(true);
  });

  test("field policies only narrow", () => {
    expect(authorizeField(ir, { entity: "issue", fieldIdent: ":issue/internalNotes" }, ctx())).toBe(false);
    expect(
      authorizeField(ir, { entity: "issue", fieldIdent: ":issue/internalNotes" }, ctx({ classes: ["support"] })),
    ).toBe(true);
    expect(authorizeField(ir, { entity: "issue", fieldIdent: ":issue/title" }, ctx())).toBe(true);
  });

  test("explicit deny wins over allow", () => {
    const banned = rule(Issue, ({ resource }) => eq(resource.title, "Bug"));
    const denied = compileAuthorization(head, [read(Issue).allow(ownsIssue).deny(banned)]);
    expect(authorizeRow(denied, "issue", ctx())).toBe(false);
    expect(authorizeRow(ir, "issue", ctx())).toBe(true);
  });

  test("targetless seed allows a class gate and ignores a missing resource", () => {
    expect(authorizeOperation(ir, "issue/seed", ctx({ resource: undefined }))).toBe(true);
    expect(authorizeOperation(ir, "issue/seed", ctx({ classes: [] }))).toBe(false);
  });

  test("rename is allowed for the owner", () => {
    expect(authorizeOperation(ir, "issue/rename", ctx())).toBe(true);
    expect(authorizeOperation(ir, "issue/rename", ctx({ me: 99 }))).toBe(false);
  });
});

describe("runtime isolation", () => {
  test("eval.ts does not import the authoring module", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../../src/internal/authorization/eval.ts"), "utf8");
    expect(src.includes("authorization/authoring")).toBe(false);
    expect(src.includes('from "../../authorization')).toBe(false);
  });
});
