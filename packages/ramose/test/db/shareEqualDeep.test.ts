/**
 * Structural sharing: unchanged nodes keep Object.is identity.
 */

import { describe, expect, test } from "bun:test";
import { shareEqualDeep } from "../../src/db/internal.ts";

describe("shareEqualDeep", () => {
  test("deep-equal root returns the previous reference", () => {
    const prev = [{ id: 1, title: "a" }, { id: 2, title: "b" }];
    const next = [{ id: 1, title: "a" }, { id: 2, title: "b" }];
    expect(shareEqualDeep(prev, next)).toBe(prev);
  });

  test("a single-row change keeps the unchanged row's identity", () => {
    const prev = [
      { id: 1, title: "a" },
      { id: 2, title: "b" },
    ];
    const next = [
      { id: 1, title: "a" },
      { id: 2, title: "B" },
    ];
    const shared = shareEqualDeep(prev, next);
    expect(shared).not.toBe(prev);
    expect(shared).not.toBe(next);
    expect(shared[0]).toBe(prev[0]);
    expect(shared[1]).not.toBe(prev[1]);
    expect(shared[1]).toEqual({ id: 2, title: "B" });
  });

  test("equal Dates reuse the previous instance", () => {
    const prev = { at: new Date("2026-01-01T00:00:00.000Z") };
    const next = { at: new Date("2026-01-01T00:00:00.000Z") };
    const shared = shareEqualDeep(prev, next);
    expect(shared).toBe(prev);
    expect(shared.at).toBe(prev.at);
  });

  test("equal byte arrays reuse the previous instance", () => {
    const prev = { bytes: new Uint8Array([1, 2, 3]) };
    const next = { bytes: new Uint8Array([1, 2, 3]) };
    expect(shareEqualDeep(prev, next)).toBe(prev);
  });

  test("a new key produces a new object; sibling fields stay shared", () => {
    const prev: { id: number; title: string; extra?: boolean } = {
      id: 1,
      title: "a",
    };
    const next = { id: 1, title: "a", extra: true };
    const shared = shareEqualDeep(prev, next);
    expect(shared).not.toBe(prev);
    expect(shared.id).toBe(1);
    expect(shared.title).toBe("a");
    expect(shared.extra).toBe(true);
  });
});
