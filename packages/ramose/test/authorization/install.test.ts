/** Two-stage IR install, completeness, budgets, and leases. */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { compileAuthorization, compileTemplate, hasClass, read } from "../../src/authorization/index.ts";
import {
  AuthorizationDenied,
  CountedBudget,
  TimedLease,
  UnboundedLease,
  UnlimitedBudget,
  authorize,
  catalogFromTemplate,
  installAgainstCatalog,
  parseAuthorizationIR,
  serializeAuthorizationIR,
} from "../../src/internal/authorization/index.ts";
import { MemoryRuleSnapshot } from "../../src/internal/authorization/snapshot.ts";
import { head, Issue } from "./fixtures.ts";

const projection = {
  subject: "alice",
  classes: ["member"] as const,
  claims: {},
  input: {},
  inputLoaded: false,
  entities: {},
};

describe("two-stage IR", () => {
  test("compileTemplate is catalog-relative; install seals it", () => {
    const template = Effect.runSync(compileTemplate(head, [read(Issue).allow(hasClass("member"))]));
    expect(template.form).toBe("template");
    const installed = Effect.runSync(installAgainstCatalog(template, catalogFromTemplate(template)));
    expect(installed.form).toBe("installed");
    expect(installed.policyHash.length).toBe(64);
    expect(installed.catalog.schemaFingerprint.length).toBeGreaterThan(0);
    const json = serializeAuthorizationIR(installed);
    expect(parseAuthorizationIR(json)).toEqual(installed);
  });

  test("runtime parse rejects a template string", () => {
    const template = Effect.runSync(compileTemplate(head, [read(Issue).allow(hasClass("member"))]));
    expect(() => parseAuthorizationIR(JSON.stringify(template))).toThrow(/installed/);
  });

  test("compileAuthorization returns the sealed installed form", () => {
    const ir = compileAuthorization(head, [read(Issue).allow(hasClass("member"))]);
    expect(ir.form).toBe("installed");
    expect(ir.rules.every((rule) => rule.id.startsWith("r:"))).toBe(true);
    expect(ir.rules[0]!.id.split(":")[3]?.length).toBe(64);
  });
});

describe("Effect authorization shell", () => {
  const ir = compileAuthorization(head, [read(Issue).allow(hasClass("member"))]);

  test("only True authorizes; missing class denies at the boundary", () => {
    const denied = authorize(ir, ir.rows.issue).pipe(
      Effect.provide(MemoryRuleSnapshot.layer({ ...projection, classes: [] })),
      Effect.provide(UnlimitedBudget),
      Effect.provide(UnboundedLease),
    );
    expect(Effect.runSync(denied.pipe(Effect.flip))).toBeInstanceOf(AuthorizationDenied);
  });

  test("a counted budget fails closed", () => {
    const effect = authorize(ir, ir.rows.issue).pipe(
      Effect.provide(MemoryRuleSnapshot.layer(projection)),
      Effect.provide(CountedBudget.layer(0)),
      Effect.provide(UnboundedLease),
      Effect.flip,
    );
    expect(Effect.runSync(effect)._tag).toBe("AuthorizationBudgetExceeded");
  });

  test("a five-second lease expires under the test clock", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        yield* authorize(ir, ir.rows.issue);
        yield* TestClock.setTime(6_000);
        return yield* authorize(ir, ir.rows.issue);
      }).pipe(
        Effect.provide(MemoryRuleSnapshot.layer(projection)),
        Effect.provide(UnlimitedBudget),
        Effect.provide(TimedLease.layer(0, 5_000)),
        Effect.provide(TestClock.layer()),
        Effect.flip,
      ),
    );
    expect(result._tag).toBe("LeaseExpired");
  });
});
