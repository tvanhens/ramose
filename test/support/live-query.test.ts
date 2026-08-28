import { describe, expect, test } from "bun:test";
import { applyLiveDiffs } from "./live-query.ts";

describe("thin live-query consumer", () => {
  test("applyLiveDiffs rebuilds the authorized bag", () => {
    expect(
      applyLiveDiffs([
        { added: ["Bug", "Child"], retracted: [] },
        { added: ["Other"], retracted: ["Child"] },
      ]).sort(),
    ).toEqual(["Bug", "Other"]);
  });
});
