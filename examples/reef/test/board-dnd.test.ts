import { describe, expect, test } from "bun:test";
import {
  type HitNode,
  afterCardBeforeId,
  dropTargetFromStack,
  homeDropTarget,
  insertIndex,
  pinScrollLeft,
  pinWindowScroll,
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
      if (selector === "[data-reef-slot]" && dataset.reefSlot !== undefined) return node;
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

describe("insertIndex / homeDropTarget", () => {
  test("a missing beforeId appends", () => {
    expect(insertIndex([1, 2, 3], undefined)).toBe(3);
    expect(insertIndex([1, 2, 3], 2)).toBe(1);
    expect(insertIndex([1, 2, 3], 99)).toBe(3);
  });

  test("inserting after the last card appends", () => {
    expect(afterCardBeforeId([1, 2, 3], 3)).toBeUndefined();
    expect(afterCardBeforeId([1, 2, 3], 1)).toBe(2);
  });

  test("lifting a card leaves a slot in its old place", () => {
    expect(homeDropTarget(rows, 1)).toEqual({ status: "todo", beforeId: 2 });
    expect(homeDropTarget(rows, 2)).toEqual({ status: "todo", beforeId: undefined });
    expect(homeDropTarget(rows, 3)).toEqual({ status: "doing", beforeId: undefined });
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

describe("pinWindowScroll", () => {
  test("scrollTo writes the snapshotted x/y back", () => {
    const win = {
      scrollX: 0,
      scrollY: 64,
      scrollTo(x: number, y: number) {
        this.scrollX = x;
        this.scrollY = y;
      },
    };
    const pin = pinWindowScroll(win);
    win.scrollY = 180;
    pin();
    expect(win.scrollY).toBe(64);
    expect(win.scrollX).toBe(0);
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

  test("the drop slot keeps the same insert point", () => {
    expect(
      dropTargetFromStack(
        [hit({ reefSlot: "1", reefStatus: "todo", reefBefore: "2" })],
        1,
      ),
    ).toEqual({ status: "todo", beforeId: 2 });
    expect(
      dropTargetFromStack([hit({ reefSlot: "1", reefStatus: "doing" })], 1),
    ).toEqual({ status: "doing", beforeId: undefined });
  });
});
