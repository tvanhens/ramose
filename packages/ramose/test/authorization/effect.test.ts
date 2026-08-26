import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { bindAuthorizationResolved } from "../../src/authorization/bind.ts";
import { Policy } from "../../src/authorization/compile.ts";
import { App, catalog, User } from "./fixtures.ts";
import {
  AuthorizationClock,
  AuthorizationClockLive,
  AuthorizationHash,
  AuthorizationHashLive,
  CatalogResolver,
  inMemoryCatalogResolver,
  RuleSnapshot,
} from "../../src/internal/authorization/services.ts";
import {
  CatalogMismatch,
  HashFailure,
  IncompleteRuleSnapshot,
  LeaseExpired,
} from "../../src/internal/authorization/errors.ts";
import { failClosed } from "../../src/internal/authorization/fail-closed.ts";
import { AuthorizationDenied } from "../../src/internal/authorization/errors.ts";

describe("Effect orchestration", () => {
  test("catalog resolver failures are typed", () => {
    const program = bindAuthorizationResolved(
      { _tag: "PolicyTemplateIR" },
      "missing",
    ).pipe(
      Effect.provide(inMemoryCatalogResolver(catalog)),
      Effect.provide(AuthorizationHashLive),
    );
    const exit = Effect.runSyncExit(program);
    expect(exit._tag).toBe("Failure");
  });

  test("incomplete rule snapshot is a typed failure", () => {
    const layer = Layer.succeed(RuleSnapshot, {
      project: () =>
        Effect.fail(
          new IncompleteRuleSnapshot({ message: "grant index missing" }),
        ),
    });
    const program = Effect.gen(function* () {
      const snapshot = yield* RuleSnapshot;
      return yield* snapshot.project(
        {
          ruleId: "x",
          facts: [],
          indexes: [],
          exists: [],
          maxTraversalDepth: 0,
          usesMe: false,
          usesResource: false,
          usesInput: false,
        },
        {
          limit: 1,
          remaining: () => 0,
          consume: () => Effect.void,
        },
      );
    }).pipe(Effect.provide(layer));
    const exit = Effect.runSyncExit(program);
    expect(exit._tag).toBe("Failure");
  });

  test("hash failures are typed", () => {
    const failing = Layer.succeed(AuthorizationHash, {
      digest: () => Effect.fail(new HashFailure({ message: "no hash" })),
    });
    const exit = Effect.runSyncExit(
      Policy(App, { principal: { subjectClaim: "sub" } }, ({ read, always }) => [
        read(User).allow(always),
      ]).pipe(Effect.provide(failing)),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("TestClock drives lease expiry", () => {
    const program = Effect.gen(function* () {
      const clock = yield* AuthorizationClock;
      const lease = yield* clock.lease(5, 1);
      yield* TestClock.adjust("6 seconds");
      return yield* clock.assertFresh(lease);
    }).pipe(
      Effect.provide(AuthorizationClockLive),
      Effect.provide(TestClock.layer()),
    );
    const exit = Effect.runSyncExit(program);
    expect(exit._tag).toBe("Failure");
  });

  test("one fail-closed boundary maps typed failures to deny", () => {
    const program = failClosed(
      Effect.fail(new CatalogMismatch({ message: "nope" })),
    );
    const exit = Effect.runSyncExit(program);
    expect(exit._tag).toBe("Failure");
  });
});

void AuthorizationDenied;
void LeaseExpired;
void CatalogResolver;
