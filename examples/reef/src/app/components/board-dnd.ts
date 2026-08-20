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
  readonly dataset?: {
    reefCard?: string;
    reefStatus?: string;
    reefColumn?: string;
    reefSlot?: string;
    reefBefore?: string;
  };
}

const isStatus = (value: string | undefined): value is Status =>
  value !== undefined && (STATUSES as readonly string[]).includes(value);

/** Index of the placeholder among `ids` (the column with the dragged card removed). */
export const insertIndex = (
  ids: readonly number[],
  beforeId: number | undefined,
): number => {
  if (beforeId === undefined) return ids.length;
  const i = ids.indexOf(beforeId);
  return i < 0 ? ids.length : i;
};

/** Insert after `hoveredId` — `undefined` means append. */
export const afterCardBeforeId = (
  ids: readonly number[],
  hoveredId: number,
): number | undefined => {
  const i = ids.indexOf(hoveredId);
  if (i < 0 || i >= ids.length - 1) return undefined;
  return ids[i + 1];
};

/** The slot that replaces a just-lifted card so neighbours do not jump. */
export const homeDropTarget = (
  rows: readonly { id: number; status: string }[],
  dragId: number,
): DropTarget | null => {
  const row = rows.find((r) => r.id === dragId);
  if (row === undefined || !isStatus(row.status)) return null;
  const full = rows.filter((r) => r.status === row.status);
  const idx = full.findIndex((r) => r.id === dragId);
  return { status: row.status, beforeId: full[idx + 1]?.id };
};

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

/** A committed drop that live `rows` have not yet reflected. */
export interface PendingMove {
  readonly id: number;
  readonly status: Status;
  readonly beforeId: number | undefined;
}

const ranksClose = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/** True once the live row already sits at the drop's status + rank. */
export const pendingMoveSettled = (
  rows: readonly { id: number; status: string; rank: number }[],
  pending: PendingMove,
): boolean => {
  const row = rows.find((r) => r.id === pending.id);
  if (row === undefined) return true;
  if (row.status !== pending.status) return false;
  return ranksClose(
    row.rank,
    rankForDrop(rows, pending.id, pending.status, pending.beforeId),
  );
};

/**
 * Keep a just-dropped card at its insert point until `useLive` catches up.
 * Clearing drag state first would flash the card back in its old column.
 */
export const applyPendingMove = <T extends { id: number; status: string; rank: number }>(
  rows: readonly T[],
  pending: PendingMove | null,
): T[] => {
  if (pending === null) return [...rows];
  const row = rows.find((r) => r.id === pending.id);
  if (row === undefined || pendingMoveSettled(rows, pending)) return [...rows];
  const rest = rows.filter((r) => r.id !== pending.id);
  const dest = rest.filter((r) => r.status === pending.status);
  const at = insertIndex(
    dest.map((r) => r.id),
    pending.beforeId,
  );
  const moved = { ...row, status: pending.status };
  const out: T[] = [];
  for (const status of STATUSES) {
    const col = rest.filter((r) => r.status === status);
    if (status === pending.status) {
      out.push(...col.slice(0, at), moved, ...col.slice(at));
    } else {
      out.push(...col);
    }
  }
  return out;
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
    const slot = el.closest("[data-reef-slot]");
    const slotStatus = slot?.dataset?.reefStatus;
    if (isStatus(slotStatus)) {
      const raw = slot?.dataset?.reefBefore;
      const beforeId = raw === undefined || raw === "" ? undefined : Number(raw);
      return {
        status: slotStatus,
        beforeId: beforeId !== undefined && Number.isFinite(beforeId) ? beforeId : undefined,
      };
    }
  }
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

/** Snapshot `scrollLeft` and write it back — used while a card is in flight. */
export const pinScrollLeft = (el: { scrollLeft: number }): (() => void) => {
  const left = el.scrollLeft;
  return () => {
    el.scrollLeft = left;
  };
};

export const pinWindowScroll = (win: {
  scrollX: number;
  scrollY: number;
  scrollTo: (x: number, y: number) => void;
}): (() => void) => {
  const x = win.scrollX;
  const y = win.scrollY;
  return () => {
    win.scrollTo(x, y);
  };
};

/**
 * Freeze the document viewport for a drag: html/body cannot overflow, and
 * window `touchmove` / `wheel` are cancelled so iOS does not rubber-band.
 */
export const lockPageScroll = (
  doc: Document = document,
  win: Window = window,
): (() => void) => {
  const html = doc.documentElement;
  const body = doc.body;
  const prevHtml = {
    overflow: html.style.overflow,
    overscroll: html.style.overscrollBehavior,
    touch: html.style.touchAction,
  };
  const prevBody = {
    overflow: body.style.overflow,
    overscroll: body.style.overscrollBehavior,
    touch: body.style.touchAction,
  };
  html.style.overflow = "hidden";
  body.style.overflow = "hidden";
  html.style.overscrollBehavior = "none";
  body.style.overscrollBehavior = "none";
  html.style.touchAction = "none";
  body.style.touchAction = "none";
  const pin = pinWindowScroll(win);
  pin();
  const prevent = (e: Event) => {
    e.preventDefault();
  };
  win.addEventListener("scroll", pin);
  win.addEventListener("touchmove", prevent, { passive: false });
  win.addEventListener("wheel", prevent, { passive: false });
  return () => {
    win.removeEventListener("scroll", pin);
    win.removeEventListener("touchmove", prevent);
    win.removeEventListener("wheel", prevent);
    html.style.overflow = prevHtml.overflow;
    html.style.overscrollBehavior = prevHtml.overscroll;
    html.style.touchAction = prevHtml.touch;
    body.style.overflow = prevBody.overflow;
    body.style.overscrollBehavior = prevBody.overscroll;
    body.style.touchAction = prevBody.touch;
    pin();
  };
};

export const dropTargetFromPoint = (
  x: number,
  y: number,
  dragId: number,
): DropTarget | null => {
  if (typeof document === "undefined") return null;
  const raw = dropTargetFromStack(document.elementsFromPoint(x, y) as HitNode[], dragId);
  if (raw === null || raw.beforeId === undefined) return raw;
  const card = document.querySelector(`[data-reef-card="${raw.beforeId}"]`);
  if (!(card instanceof HTMLElement)) return raw;
  const box = card.getBoundingClientRect();
  if (y <= (box.top + box.bottom) / 2) return raw;
  const col = card.closest("[data-reef-column]");
  const ids = col
    ? [...col.querySelectorAll("[data-reef-card]")]
        .map((el) => Number((el as HTMLElement).dataset.reefCard))
        .filter((id) => Number.isFinite(id) && id !== dragId)
    : [];
  return { status: raw.status, beforeId: afterCardBeforeId(ids, raw.beforeId) };
};
