import type { ReceiptState } from "../../src/client/index.ts";
import { describe, expect, test } from "bun:test";

import * as ReactAdapter from "../../src/react/index.ts";
import type {
  QueryState,
  RamoseProviderProps,
  ReceiptView,
} from "../../src/react/index.ts";

describe("the ramose/react surface", () => {
  test("exports exactly these values", () => {
    expect(Object.keys(ReactAdapter).sort()).toEqual([
      "RamoseProvider",
      "useDb",
      "useQuery",
      "useReceipt",
      "useSuspenseQuery",
      "useSyncState",
    ]);
  });

  test("adapts client receipt state into a React view", () => {
    const committed: ReceiptState = { status: "committed" };
    const view: ReceiptView = committed;
    const idle: ReceiptView = { status: "idle" };

    expect(view.status).toBe("committed");
    expect(idle.status).toBe("idle");
  });

  test("keeps the query and provider types reachable", () => {
    const ready: QueryState<readonly string[]> = { status: "ready", data: [] };
    const props: Pick<RamoseProviderProps, "children"> = { children: null };

    expect(ready.status).toBe("ready");
    expect(props.children).toBeNull();
  });
});
