/**
 * `tempid()` rejects builder-reserved `tmp-<n>` names.
 */

import { describe, expect, test } from "bun:test";
import { tempid } from "../src/db/internal.ts";

describe("tempid", () => {
  test("rejects builder-reserved tmp-<n> names", () => {
    expect(() => tempid("tmp-1")).toThrow(
      "ramose: tempid names matching tmp-<n> are reserved for the transaction builder",
    );
    expect(() => tempid("tmp-12")).toThrow(
      "ramose: tempid names matching tmp-<n> are reserved for the transaction builder",
    );
  });

  test("admits caller names that are not tmp-<n>", () => {
    expect(tempid("new") as string).toBe("new");
    expect(tempid("tmp") as string).toBe("tmp");
    expect(tempid("tmp-x") as string).toBe("tmp-x");
  });
});
