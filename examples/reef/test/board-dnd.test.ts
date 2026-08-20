import { describe, expect, test } from "bun:test";
import {
  type HitNode,
  dropTargetFromStack,
  pinScrollLeft,
  rankForDrop,
} from "../src/app/components/board-dnd.ts";
import { RANK_GAP } from "../src/domain/rank.ts";

const rows = [
  { id: 1, status: "todo" as const, rank: RANK_GAP },
  { id: 2, status: "todo" as const, rank: 2 * RANK_GAP },
  { id: 3, status: "doing" as const, rank: RANK_GAP },
];

const hit = (
  dataset: NonNullable<HitNode["dataset"]>,
  parent?: HitNode,
): HitNode => {
  const node: HitNode = {
    dataset,
    closest(selector) {
      if (selector === "[data-reef-card]" && dataset.reefCard !== undefined) return node;
      if (selector === "[data-reef-column]" && dataset.reefColumn !== undefined) {
        return node;
      }
      return parent?.closest(selector) ?? null;
    },
  };
  return node;
};

describe("rankForDrop", () => {
  test("appending to a column lands after the last remaining card", () => {
    expect(rankForDrop(rows, 3, "todo", undefined)).toBe(3 * RANK_GAP);
    expect(rankForDrop(rows, 1, "doing", undefined)).toBe(2 * RANK_GAP);
  });

  test("dropping on a card inserts before it", () => {
    expect(rankForDrop(rows, 3, "todo", 2)).toBe(1.5 * RANK_GAP);
    expect(rankForDrop(rows, 2, "todo", 1)).toBe(0);
  });

  test("an empty target column gets the first gap", () => {
    expect(rankForDrop(rows, 1, "done", undefined)).toBe(RANK_GAP);
  });
});

describe("pinScrollLeft", () => {
  test("writes the snapshotted offset back", () => {
    const el = { scrollLeft: 80 };
    const pin = pinScrollLeft(el);
    el.scrollLeft = 240;
    pin();
    expect(el.scrollLeft).toBe(80);
  });
});

describe("dropTargetFromStack", () => {
  test("a card under the pointer is an insert-before drop", () => {
    const column = hit({ reefColumn: "doing" });
    const card = hit({ reefCard: "3", reefStatus: "doing" }, column);
    expect(dropTargetFromStack([card, column], 1)).toEqual({
      status: "doing",
      beforeId: 3,
    });
  });

  test("the dragged card itself is skipped so the column underneath hits", () => {
    const column = hit({ reefColumn: "todo" });
    const card = hit({ reefCard: "1", reefStatus: "todo" }, column);
    expect(dropTargetFromStack([card, column], 1)).toEqual({
      status: "todo",
      beforeId: undefined,
    });
  });

  test("empty space in a column appends", () => {
    expect(dropTargetFromStack([hit({ reefColumn: "backlog" })], 2)).toEqual({
      status: "backlog",
      beforeId: undefined,
    });
  });

  test("a miss is null", () => {
    expect(dropTargetFromStack([hit({})], 1)).toBeNull();
  });
});
