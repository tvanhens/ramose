import { describe, expect, test } from "bun:test";
import {
  replicaDatabaseRouteKey,
  replicaRouteScope,
  rootReplicaRouteSlot,
} from "../../../src/internal/replication/route-slot.ts";

describe("local replica routing", () => {
  test("the configured database occupies one fixed opaque slot", async () => {
    const root = await rootReplicaRouteSlot();
    expect(root).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await rootReplicaRouteSlot()).toBe(root);
    expect(await replicaDatabaseRouteKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("deployment scopes are opaque and database-specific", async () => {
    const scope = await replicaRouteScope({ origin: "https://data.example", root: "app" });
    expect(scope).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(scope).not.toContain("data.example");
    expect(await replicaRouteScope({ origin: "https://data.example", root: "app" }))
      .toBe(scope);
    expect(await replicaRouteScope({ origin: "https://data.example", root: "other" }))
      .not.toBe(scope);
  });
});
