/**
 * The deploy-time artifacts, checked at test time: the policy compiles
 * against the catalog, carries exactly the rules the demo narrates, and the
 * app's pull shapes survive the masked-read check.
 *
 * `parsePolicy` comes from `ramose/internal/*` — the engine, reachable but
 * unsupported — because "core accepts this JSON" is the assertion, and the
 * public surface only offers the compiler that produces it. An app never
 * imports it.
 */

import { describe, expect, test } from "bun:test";
import { parsePolicy } from "ramose/internal/core/policy/ast.ts";
import * as Ramose from "ramose";
import { classOfRole } from "ramose/better-auth";
import { compiledPolicy, policy } from "../src/domain/policy.ts";
import { allShapes, boardShape } from "../src/domain/queries.ts";
import { Issue, Reef } from "../src/domain/schema.ts";
import { CLASSES } from "../src/domain/shared.ts";

describe("reef policy", () => {
  test("compiles to wire JSON that core accepts", () => {
    const json = compiledPolicy();
    const parsed = parsePolicy(JSON.parse(json));
    expect(parsed.principal).toBe(":user/sub");
    expect(parsed.classes).toEqual([...CLASSES]);
  });

  test("presets pin creator, author and sub to the caller", () => {
    const parsed = parsePolicy(JSON.parse(compiledPolicy()));
    expect(Object.keys(parsed.preset).sort()).toEqual([
      ":comment/author",
      ":issue/creator",
      ":user/sub",
    ]);
    expect(parsed.preset[":issue/creator"]).toEqual({ _tag: "principal" });
    expect(parsed.preset[":comment/author"]).toEqual({ _tag: "principal" });
    expect(parsed.preset[":user/sub"]).toEqual({
      _tag: "claim",
      path: ["sub"],
    });
  });

  test("privateNote read is narrowed to the admin class", () => {
    const parsed = parsePolicy(JSON.parse(compiledPolicy()));
    const arms = parsed.attrs[":issue/privateNote"]?.read;
    expect(arms).toBeDefined();
    expect(arms).toEqual([
      { _tag: "allow", expr: { _tag: "class", class: "admin" } },
    ]);
    // …and it is the only narrowing: every other issue attribute is unnamed
    // and inherits the broad namespace read at eval time.
    expect(Object.keys(parsed.attrs)).toEqual([":issue/privateNote"]);
    expect(parsed.ns?.issue?.read).toBeDefined();
  });

  // `RAMOSE_POLICY` is a Cloudflare plain-text binding, capped at 5.1 kB —
  // over it the peer Worker cannot be deployed at all, which is a failure only
  // a real deploy surfaces (miniflare enforces no such limit).
  test("compiles small enough to bind on Cloudflare", () => {
    const bytes = new TextEncoder().encode(compiledPolicy()).length;
    expect(bytes).toBeLessThan(5 * 1024);
  });

  test("viewers have no write arms anywhere", () => {
    const parsed = parsePolicy(JSON.parse(compiledPolicy()));
    const everywhere = [
      ...Object.values(parsed.attrs),
      ...Object.values(parsed.ns ?? {}),
    ];
    for (const rules of everywhere) {
      for (const op of ["create", "add", "retract", "retractEntity"] as const) {
        for (const arm of rules[op] ?? []) {
          expect(JSON.stringify(arm)).not.toContain('"viewer"');
        }
      }
    }
  });

  test("a masked attribute pulled as required is a compile error", () => {
    const badShape = { note: Issue.privateNote };
    expect(() =>
      Ramose.Policy.compile(policy, { pulls: [...allShapes, badShape] }),
    ).toThrow(/privateNote/);
  });

  test("the app's own shapes pass the masked-read check", () => {
    expect(() =>
      Ramose.Policy.compile(policy, { pulls: [boardShape, ...allShapes] }),
    ).not.toThrow();
  });
});

// The mapping lives in `ramose/better-auth` now (the mint plugin's
// default); pinned here so it stays in step with what the policy declares.
describe("role → class mapping", () => {
  test("owner and admin mint the admin class", () => {
    expect(classOfRole("owner")).toBe("admin");
    expect(classOfRole("admin")).toBe("admin");
    expect(classOfRole("owner,member")).toBe("admin");
  });
  test("member mints member; anything else is a viewer", () => {
    expect(classOfRole("member")).toBe("member");
    expect(classOfRole("viewer")).toBe("viewer");
    expect(classOfRole("mystery-role")).toBe("viewer");
  });
});

describe("catalog", () => {
  test("declares the four namespaces the app writes", () => {
    expect(Object.keys(Reef.namespaces).sort()).toEqual([
      "comment",
      "issue",
      "label",
      "user",
    ]);
  });
});
