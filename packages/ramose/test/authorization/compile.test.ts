/** Authoring → deterministic serializable IR. No peer I/O. */

import { describe, expect, test } from "bun:test";
import { PolicyError } from "../../src/db/internal.ts";
import {
  AUTHORIZATION_IR_VERSION,
  compileAuthorization,
  parseAuthorizationIR,
  serializeAuthorizationIR,
} from "../../src/authorization/index.ts";
import { head, taggableBindings } from "./fixtures.ts";

describe("compileAuthorization", () => {
  test("the Taggable example compiles without special runtime machinery", () => {
    const ir = compileAuthorization(head, taggableBindings);
    expect(ir.version).toBe(AUTHORIZATION_IR_VERSION);
    expect(ir.principal).toEqual({ ident: ":user/sub", entity: "user" });
    expect(ir.classes).toEqual(["member", "support"]);
    expect(ir.identities.entities.map((e) => e.ns)).toEqual(["issue", "tag", "tagGrant", "user"]);
    expect(ir.identities.traits.map((t) => t.ns)).toEqual(["taggable"]);
    expect(ir.rows.issue?.allow.length).toBe(2);
    expect(ir.traits.taggable?.allow.length).toBe(1);
    expect(ir.fields[":issue/internalNotes"]?.allow.length).toBe(1);
    expect(ir.operations["issue/rename"]?.allow.length).toBe(2);
    expect(ir.operations["taggable/add-tag"]?.allow.length).toBe(1);
    expect(ir.operations["issue/seed"]?.allow.length).toBe(1);
    const tags = ir.identities.fields.find((f) => f.ident === ":taggable/tags");
    expect(tags?.owner).toEqual({ kind: "trait", ns: "taggable" });
    expect(ir.rules.some((r) => r.expr.kind === "some")).toBe(true);
    expect(ir.rules.some((r) => JSON.stringify(r.expr).includes("tagGrant"))).toBe(true);
  });

  test("compiled IR is JSON, has no functions, and round-trips", () => {
    const ir = compileAuthorization(head, taggableBindings);
    const json = serializeAuthorizationIR(ir);
    expect(json.includes("function")).toBe(false);
    const parsed = parseAuthorizationIR(json);
    expect(parsed).toEqual(ir);
    expect(JSON.parse(json)).toEqual(JSON.parse(serializeAuthorizationIR(parsed)));
  });

  test("compilation is deterministic", () => {
    const a = serializeAuthorizationIR(compileAuthorization(head, taggableBindings));
    const b = serializeAuthorizationIR(compileAuthorization(head, taggableBindings));
    expect(a).toBe(b);
  });

  test("canonical identities are owner + local name, never a closure", () => {
    const ir = compileAuthorization(head, taggableBindings);
    for (const rule of ir.rules) {
      expect(rule.focus.kind === "entity" || rule.focus.kind === "trait").toBe(true);
      expect(typeof rule.focus.ns).toBe("string");
      expect(typeof rule.id).toBe("string");
    }
    for (const op of ir.identities.operations) {
      expect(op.kind).toBe("operation");
      expect(typeof op.name).toBe("string");
      expect(typeof op.targetless).toBe("boolean");
    }
    expect(ir.identities.operations.find((o) => o.name === "issue/seed")?.targetless).toBe(true);
    expect(ir.identities.operations.find((o) => o.name === "issue/rename")?.targetless).toBe(false);
  });

  test("parseAuthorizationIR rejects incomplete compiled state", () => {
    expect(() => parseAuthorizationIR("")).toThrow(PolicyError);
    expect(() => parseAuthorizationIR(null)).toThrow(PolicyError);
    expect(() => parseAuthorizationIR("{")).toThrow(PolicyError);
    expect(() => parseAuthorizationIR({ version: 2 })).toThrow(PolicyError);
    const ir = compileAuthorization(head, taggableBindings);
    expect(() => parseAuthorizationIR({ ...ir, version: 99 })).toThrow(PolicyError);
    expect(() =>
      parseAuthorizationIR({
        ...ir,
        rows: { issue: { allow: ["missing-rule"], deny: [] } },
      }),
    ).toThrow(PolicyError);
  });
});
