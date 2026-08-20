/**
 * Shared drop math for mouse (HTML5) and touch (pointer) card moves.
 * Touch cannot use HTML5 drag-and-drop — Safari/Chrome on phones never
 * fire `dragstart` — so the board long-presses, then hit-tests.
 */

import { rankAfter, rankBetween } from "../../domain/rank.ts";
import { STATUSES, type Status } from "../../domain/schema.ts";

/** Hold still this long before a touch/pen pointer picks the card up. */
export const TOUCH_HOLD_MS = 320;
/** Movement before the hold completes cancels the drag so the board can scroll. */
export const TOUCH_CANCEL_PX = 12;

export interface DropTarget {
  readonly status: Status;
  /** Insert before this card; omit to append. */
  readonly beforeId: number | undefined;
}

/** `Element` in the browser; a `{ closest, dataset }` stub in tests. */
export interface HitNode {
  closest(selector: string): HitNode | null;
  readonly dataset?: { reefCard?: string; reefStatus?: string; reefColumn?: string };
}

const isStatus = (value: string | undefined): value is Status =>
  value !== undefined && (STATUSES as readonly string[]).includes(value);

/** Rank written for a drop, matching the HTML5 `onDrop` behaviour. */
export const rankForDrop = (
  rows: readonly { id: number; status: string; rank: number }[],
  dragId: number,
  status: string,
  beforeId: number | undefined,
): number => {
  const column = rows.filter((r) => r.status === status && r.id !== dragId);
  if (beforeId === undefined) return rankAfter(column[column.length - 1]?.rank);
  const i = column.findIndex((r) => r.id === beforeId);
  return rankBetween(column[i - 1]?.rank, column[i]?.rank);
};

/**
 * Walk `elementsFromPoint` (or a test stack) and pick a column / insert-before
 * card. The dragged card itself is skipped so the column underneath still hits.
 */
export const dropTargetFromStack = (
  stack: readonly HitNode[],
  dragId: number,
): DropTarget | null => {
  for (const el of stack) {
    const card = el.closest("[data-reef-card]");
    const id = Number(card?.dataset?.reefCard);
    const status = card?.dataset?.reefStatus;
    if (!Number.isFinite(id) || !isStatus(status)) continue;
    if (id === dragId) continue;
    return { status, beforeId: id };
  }
  for (const el of stack) {
    const col = el.closest("[data-reef-column]");
    const status = col?.dataset?.reefColumn;
    if (!isStatus(status)) continue;
    return { status, beforeId: undefined };
  }
  return null;
};

export const dropTargetFromPoint = (
  x: number,
  y: number,
  dragId: number,
): DropTarget | null =>
  typeof document === "undefined"
    ? null
    : dropTargetFromStack(document.elementsFromPoint(x, y) as HitNode[], dragId);
