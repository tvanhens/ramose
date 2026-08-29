import { describe, expect, test } from "bun:test";
import {
  provisionalReplicaRouteSlot,
  replicaRoutePathKey,
  replicaRouteScope,
  replicaRouteSlotFor,
  rootReplicaRouteSlot,
  stableReplicaRouteSlot,
} from "../../../src/internal/replication/route-slot.ts";

const opaque = (character: string): string => character.repeat(43);
const board = opaque("1");
const roadmap = opaque("2");

describe("stable local replica route slots", () => {
  test("the configured root occupies one fixed slot", async () => {
    const root = await rootReplicaRouteSlot();
    expect(root).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await rootReplicaRouteSlot()).toBe(root);
    expect(await stableReplicaRouteSlot([])).toBe(root);
    expect(await replicaRouteSlotFor({ graphPath: [] })).toBe(root);
    expect(await replicaRouteSlotFor({ graphPath: [], lineage: [] })).toBe(root);
  });

  test("a child slot depends on the ordered lineage, not on path text", async () => {
    const slot = await stableReplicaRouteSlot([board, roadmap]);
    expect(slot).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(slot).not.toBe(await rootReplicaRouteSlot());
    expect(await stableReplicaRouteSlot([board, roadmap])).toBe(slot);
    // A rename keeps the lineage, so the same slot is selected.
    expect(await replicaRouteSlotFor({
      graphPath: ["renamed", "also-renamed"],
      lineage: [board, roadmap],
    })).toBe(slot);
    // Delete/recreate replaces an entity, so the slot changes.
    expect(await stableReplicaRouteSlot([board, opaque("3")])).not.toBe(slot);
    expect(await stableReplicaRouteSlot([opaque("3"), roadmap])).not.toBe(slot);
    // Chaining: order matters and a prefix is a different slot.
    expect(await stableReplicaRouteSlot([roadmap, board])).not.toBe(slot);
    expect(await stableReplicaRouteSlot([board])).not.toBe(slot);
  });

  test("provisional path slots live in their own domain", async () => {
    const provisional = await provisionalReplicaRouteSlot(["board"]);
    expect(provisional).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(provisional).not.toContain("board");
    expect(await provisionalReplicaRouteSlot(["board"])).toBe(provisional);
    expect(await provisionalReplicaRouteSlot(["renamed"])).not.toBe(provisional);
    expect(provisional).not.toBe(await rootReplicaRouteSlot());
    expect(provisional).not.toBe(await stableReplicaRouteSlot([board]));
    expect(await replicaRouteSlotFor({ graphPath: ["board"] })).toBe(provisional);
  });

  test("a lineage must describe every authorized segment", () => {
    expect(() => replicaRouteSlotFor({ graphPath: ["board"], lineage: [] }))
      .toThrow(/every path segment/);
    expect(() => replicaRouteSlotFor({ graphPath: [], lineage: [board] }))
      .toThrow(/every path segment/);
  });

  test("scopes and path keys are opaque and separate", async () => {
    const scope = await replicaRouteScope({ origin: "https://data.example", root: "app" });
    expect(scope).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(scope).not.toContain("data.example");
    expect(await replicaRouteScope({ origin: "https://data.example", root: "app" }))
      .toBe(scope);
    expect(await replicaRouteScope({ origin: "https://data.example", root: "other" }))
      .not.toBe(scope);
    expect(await replicaRouteScope({ origin: "https://other.example", root: "app" }))
      .not.toBe(scope);
    const pathKey = await replicaRoutePathKey(["board"]);
    expect(pathKey).not.toContain("board");
    expect(pathKey).not.toBe(await provisionalReplicaRouteSlot(["board"]));
    expect(await replicaRoutePathKey(["board", "extra"])).not.toBe(pathKey);
  });
});
