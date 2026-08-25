/**
 * The deploy-time artifacts, checked at test time: the policy compiles
 * against the catalog, carries exactly the rules the demo narrates, and the
 * app's pull shapes survive the masked-read check.
 *
 * `parsePolicy` comes from the engine via a workspace-relative import —
 * example test suites keep that access without the public package promising
 * it. An app never imports it.
 */

import { describe, expect, test } from "bun:test";
import { parsePolicy } from "../../../packages/ramose/src/internal/core/policy/ast.ts";
import { checkTx } from "../../../packages/ramose/src/internal/core/policy/check.ts";
import { Connection } from "../../../packages/ramose/src/internal/core/conn.ts";
import type { Principal } from "../../../packages/ramose/src/internal/core/index.ts";
import { schemaTx } from "../../../packages/ramose/src/db/ensure.ts";
import * as Ramose from "ramose";
import { classOfRole } from "ramose/better-auth";
import { compiledPolicy, policy } from "../src/domain/policy.ts";
import { allShapes, boardShape } from "../src/domain/queries.ts";
import { Issue, Reef } from "../src/domain/schema.ts";

const who = (cls: "owner" | "member" | "viewer", sub: string, eid?: number): Principal => ({
  kind: "user",
  class: cls,
  sub,
  ...(eid !== undefined ? { eid } : {}),
  claims: { sub },
  db: "reef",
});

describe("reef policy", () => {
  test("compiles to wire JSON that core accepts", () => {
    const json = compiledPolicy();
    const parsed = parsePolicy(JSON.parse(json));
    expect(parsed.principal).toBe(":user/sub");
    expect(parsed.classes).toEqual([...policy.classes]);
    expect(parsed.schemaClasses).toEqual(["owner"]);
    expect(parsed.superuser).toBeUndefined();
  });

  test("presets pin creator and author to the caller", () => {
    const parsed = parsePolicy(JSON.parse(compiledPolicy()));
    expect(Object.keys(parsed.preset).sort()).toEqual([
      ":comment/author",
      ":issue/creator",
    ]);
    expect(parsed.preset[":issue/creator"]).toEqual({ _tag: "principal" });
    expect(parsed.preset[":comment/author"]).toEqual({ _tag: "principal" });
  });

  test("user has no write arms — the peer owns the row", () => {
    const parsed = parsePolicy(JSON.parse(compiledPolicy()));
    expect(parsed.ns?.user?.create).toBeUndefined();
    expect(parsed.ns?.user?.add).toBeUndefined();
    expect(parsed.ns?.user?.retract).toBeUndefined();
    expect(parsed.ns?.user?.retractEntity).toBeUndefined();
    expect(parsed.preset[":user/sub"]).toBeUndefined();
  });

  test("privateNote read is narrowed to the owner class", () => {
    const parsed = parsePolicy(JSON.parse(compiledPolicy()));
    const arms = parsed.attrs[":issue/privateNote"]?.read;
    expect(arms).toBeDefined();
    expect(arms).toEqual([{ _tag: "allow", class: ["owner"], rule: true }]);
    // …and it is the only narrowing: every other issue attribute is unnamed
    // and inherits the broad namespace read at eval time.
    expect(Object.keys(parsed.attrs)).toEqual([":issue/privateNote"]);
    expect(parsed.ns?.issue?.read).toEqual([{ _tag: "allow", rule: true }]);
  });

  test("label.create admits owner and member", () => {
    const parsed = parsePolicy(JSON.parse(compiledPolicy()));
    expect(parsed.ns?.label?.create).toEqual([{ _tag: "allow", class: ["owner", "member"], rule: true }]);
  });

  test("an owner may create and edit their own issue; another owner may not", async () => {
    const compiled = parsePolicy(JSON.parse(compiledPolicy()));
    const conn = await Connection.create();
    await conn.transact(schemaTx(Reef) as never);
    const seeded = await conn.transact([
      { ":db/id": "ada", ":user/sub": "user_ada", ":user/role": "owner" },
      { ":db/id": "bea", ":user/sub": "user_bea", ":user/role": "owner" },
      {
        ":db/id": "iss",
        ":issue/title": "Mine",
        ":issue/status": "todo",
        ":issue/priority": "none",
        ":issue/rank": 1,
        ":issue/createdAt": 1,
        ":issue/creator": "ada",
      },
    ]);
    const ada = who("owner", "user_ada", seeded.tempids.ada);
    const bea = who("owner", "user_bea", seeded.tempids.bea);
    const db = conn.db();
    expect((await checkTx([{ ":label/name": "Bug", ":label/color": "#f00" }], db, compiled, ada)).ok).toBe(true);
    expect((await checkTx([[":db/add", seeded.tempids.iss, ":issue/title", "Renamed"]], db, compiled, ada)).ok).toBe(
      true,
    );
    const denied = await checkTx([[":db/add", seeded.tempids.iss, ":issue/title", "Hacked"]], db, compiled, bea);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.attr).toBe(":issue/title");
    const viewerDenied = await checkTx(
      [{ ":label/name": "Nope", ":label/color": "#000" }],
      db,
      compiled,
      who("viewer", "user_ada", seeded.tempids.ada),
    );
    expect(viewerDenied.ok).toBe(false);
  });

  test("own-issue / own-comment fragments compile to named rules", () => {
    const parsed = parsePolicy(JSON.parse(compiledPolicy()));
    const add = parsed.ns?.issue?.add;
    expect(add).toHaveLength(1);
    expect(add![0]).toEqual({
      _tag: "allow",
      class: ["owner", "member"],
      rule: expect.any(String),
    });
    const name = (add![0] as { rule: string }).rule;
    expect(parsed.ns?.issue?.retract![0]).toEqual(add![0]);
    expect(parsed.rules).toBeDefined();
    const def = (parsed.rules as unknown[][]).find((r) => (r[0] as unknown[])[0] === name);
    expect(def).toBeDefined();
    expect(JSON.stringify(def)).toContain(":issue/creator");
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

  // docs:masked-required
  test("a masked attribute pulled as required is a compile error", () => {
    const badShape = { note: Issue.privateNote };
    expect(() =>
      Ramose.Policy.compile(policy, { pulls: [...allShapes, badShape] }),
    ).toThrow(/privateNote/);
  });
  // enddocs:masked-required

  test("the app's own shapes pass the masked-read check", () => {
    expect(() =>
      Ramose.Policy.compile(policy, { pulls: [boardShape, ...allShapes] }),
    ).not.toThrow();
  });
});

// The mapping lives in `ramose/better-auth` now (the mint plugin's
// default); pinned here so it stays in step with what the policy declares.
describe("role → class mapping", () => {
  test("owner and admin mint the owner class", () => {
    expect(classOfRole("owner")).toBe("owner");
    expect(classOfRole("admin")).toBe("owner");
    expect(classOfRole("owner,member")).toBe("owner");
  });
  test("member mints member; anything else is a viewer", () => {
    expect(classOfRole("member")).toBe("member");
    expect(classOfRole("viewer")).toBe("viewer");
    expect(classOfRole("mystery-role")).toBe("viewer");
  });
});

describe("catalog", () => {
  test("declares the four namespaces the app writes", () => {
    expect(Object.keys(Reef.entities).sort()).toEqual([
      "comment",
      "issue",
      "label",
      "user",
    ]);
  });
});
