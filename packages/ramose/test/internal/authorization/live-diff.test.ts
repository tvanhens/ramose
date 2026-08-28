import { describe, expect, test } from "bun:test";
import {
  diffAuthorizedResults,
  isSilentLiveDiff,
  liveDiffFromPrevious,
} from "../../../src/internal/authorization/index.ts";
import { stringifyJson } from "../../../src/internal/core/json.ts";
import { applyLiveDiffs } from "../../../../../test/support/live-query.ts";

const leakKeys = (value: unknown): string[] => {
  const text = stringifyJson(value);
  return ["datoms", "txEid", "basisT", "\"t\":", "rule", "grant"].filter(
    (key) => text.includes(key),
  );
};

describe("diffAuthorizedResults", () => {
  test("additions and retractions are result rows only", () => {
    const diff = diffAuthorizedResults(["Bug", "Child"], ["Bug", "Other"]);
    expect(diff.added).toEqual(["Other"]);
    expect(diff.retracted).toEqual(["Child"]);
    expect(isSilentLiveDiff(diffAuthorizedResults(["Bug"], ["Bug"]))).toBe(true);
    expect(liveDiffFromPrevious(undefined, ["Bug"]).added).toEqual(["Bug"]);
    expect(liveDiffFromPrevious(undefined, [])).toEqual({ added: [], retracted: [] });

    const reordered = diffAuthorizedResults(["A", "B"], ["B", "A"]);
    expect(reordered).toEqual({ added: ["B", "A"], retracted: ["A", "B"] });
    expect(applyLiveDiffs([reordered])).toEqual(["B", "A"]);

    const inserted = diffAuthorizedResults(["A", "C"], ["A", "B", "C"]);
    expect(inserted).toEqual({ added: ["A", "B", "C"], retracted: ["A", "C"] });
    expect(applyLiveDiffs([{ added: ["A", "C"], retracted: [] }, inserted])).toEqual([
      "A",
      "B",
      "C",
    ]);

    const duplicateTuple = diffAuthorizedResults(["A", "A"], ["B", "B"]);
    expect(duplicateTuple).toEqual({ added: ["B", "B"], retracted: ["A", "A"] });
    expect(applyLiveDiffs([{ added: ["A", "A"], retracted: [] }, duplicateTuple])).toEqual([
      "B",
      "B",
    ]);

    const oneDuplicateRemoved = diffAuthorizedResults(["A", "A"], ["A"]);
    expect(oneDuplicateRemoved).toEqual({ added: [], retracted: ["A"] });
    expect(applyLiveDiffs([{ added: ["A", "A"], retracted: [] }, oneDuplicateRemoved])).toEqual([
      "A",
    ]);
    expect(leakKeys(diff)).toEqual([]);
  });
});
