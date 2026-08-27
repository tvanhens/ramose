import { describe, expect, test } from "bun:test";
import {
  FIRST_USER_EID,
  UNSTAMPED_APPLICATION_MESSAGE,
  firstUnstampedEid,
} from "../../../src/internal/core/index.ts";

describe("firstUnstampedEid", () => {
  test("returns the first occupant at or above the user-eid floor", () => {
    expect(
      firstUnstampedEid([10, FIRST_USER_EID, 1001], new Set(), FIRST_USER_EID),
    ).toBe(FIRST_USER_EID);
    expect(
      firstUnstampedEid([10, FIRST_USER_EID], new Set([FIRST_USER_EID]), FIRST_USER_EID),
    ).toBeUndefined();
    expect(
      firstUnstampedEid([1001, 1002], new Set([1001]), FIRST_USER_EID),
    ).toBe(1002);
  });

  test("the fail-closed message names a fresh database, not a repair", () => {
    expect(UNSTAMPED_APPLICATION_MESSAGE).toContain("create a fresh database");
    expect(UNSTAMPED_APPLICATION_MESSAGE).not.toContain("migrat");
  });
});
