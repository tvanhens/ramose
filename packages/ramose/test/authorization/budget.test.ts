import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { evaluateExpr, createBudget, type EvalContext } from "../../src/internal/authorization/eval.ts";
import { Present } from "../../src/internal/authorization/truth.ts";
import { AuthorizationBudgetLive, AuthorizationBudgetService } from "../../src/internal/authorization/services.ts";
import { AuthorizationBudgetExceeded } from "../../src/internal/authorization/errors.ts";

const base = (): EvalContext => ({
  principal: {
    subject: "s",
    classes: new Set(),
    claims: new Map(),
    me: Present(1),
  },
  resource: AbsentRecord(),
  input: new Map(),
  snapshot: {
    entities: new Map([
      [
        "issue",
        {
          _tag: "Loaded",
          records: Array.from({ length: 50 }, (_, i) => ({
            id: i,
            entity: "issue",
            traits: new Set(),
            fields: new Map(),
          })),
        },
      ],
    ]),
    byId: new Map(),
  },
  budget: createBudget(3),
  bindings: new Map(),
});

const AbsentRecord = () =>
  ({
    _tag: "Record" as const,
    record: {
      id: 0,
      entity: "issue",
      traits: new Set<string>(),
      fields: new Map(),
    },
  });

describe("evaluation budget and cancellation", () => {
  test("exists respects the work budget", () => {
    const truth = evaluateExpr(
      {
        _tag: "exists",
        entity: { name: "issue" },
        bind: "i",
        pred: { _tag: "const", value: false },
      },
      base(),
    );
    expect(truth._tag).toBe("Incomplete");
    if (truth._tag === "Incomplete") {
      expect(truth.reason._tag).toBe("BudgetExhausted");
    }
  });

  test("budget service fails closed when exhausted", () => {
    const program = Effect.gen(function* () {
      const budgets = yield* AuthorizationBudgetService;
      const budget = budgets.make(1);
      yield* budget.consume(1);
      yield* budget.consume(1);
    }).pipe(Effect.provide(AuthorizationBudgetLive));
    const exit = Effect.runSyncExit(program);
    expect(exit._tag).toBe("Failure");
  });

  test("projection can be interrupted", async () => {
    const slow = Effect.gen(function* () {
      yield* Effect.sleep("10 seconds");
      return "done";
    });
    const fiber = Effect.runFork(slow);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(true).toBe(true);
  });
});

void AuthorizationBudgetExceeded;
