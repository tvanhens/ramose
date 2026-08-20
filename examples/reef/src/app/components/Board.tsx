/**
 * The kanban board. Rows come straight from one `useLive(db, boardQuery)`
 * read (already rank-sorted); a drag writes exactly two datoms (status +
 * rank) and the board re-renders when the peer's basis tick comes back —
 * there is no local reordering state to reconcile.
 *
 * Desktop uses HTML5 drag-and-drop. Phones never fire those events, so a
 * hold-still then move on a `pointerType: "touch" | "pen"` pointer does
 * the same `onMove` — a tap still opens the card, and a flicked scroll
 * cancels the hold so the board can pan. While a card is in flight a
 * dashed slot tracks the insert point and the other cards shift to open
 * a gap of the same height.
 */

import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BoardRow } from "../../domain/queries.ts";
import { PRIORITIES, STATUSES, STATUS_LABELS, type Status } from "../../domain/schema.ts";
import { colors, radii, space, type } from "../theme/tokens.stylex";
import { Avatar, Icon, IconButton, LabelBadge, PriorityIcon } from "../ui.tsx";
import {
  TOUCH_CANCEL_PX,
  TOUCH_HOLD_MS,
  afterCardBeforeId,
  dropTargetFromPoint,
  homeDropTarget,
  insertIndex,
  lockPageScroll,
  pinScrollLeft,
  rankForDrop,
  type DropTarget,
} from "./board-dnd.ts";

export const COLUMN_TINTS: Record<Status, string> = {
  backlog: "#8b93a3",
  todo: "#5b8cff",
  doing: "#f5a524",
  done: "#3fb970",
};

const styles = stylex.create({
  board: {
    display: "flex",
    gap: space.md,
    alignItems: "stretch",
    flexGrow: 1,
    minHeight: 0,
    overflowX: "auto",
    padding: space.lg,
    touchAction: "pan-x pan-y",
    overscrollBehavior: "none",
  },
  boardDragging: {
    overflowX: "hidden",
    touchAction: "none",
    overscrollBehavior: "none",
  },
  wrap: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    overscrollBehavior: "none",
  },
  touchHint: {
    display: { default: "none", "@media (hover: none)": "block" },
    flexShrink: 0,
    marginInline: space.lg,
    marginTop: space.sm,
    fontSize: type.xs,
    color: colors.textFaint,
  },
  column: {
    display: "flex",
    flexDirection: "column",
    flexBasis: 0,
    flexGrow: 1,
    flexShrink: 0,
    minWidth: "236px",
    maxWidth: "380px",
    minHeight: 0,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.lg,
    transition: "border-color 120ms ease, background-color 120ms ease",
  },
  columnOver: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  columnHead: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: "10px",
    paddingInline: space.md,
    paddingRight: space.sm,
  },
  columnDot: {
    width: "8px",
    height: "8px",
    borderRadius: radii.full,
    flexShrink: 0,
    boxShadow: "0 0 0 3px color-mix(in srgb, currentColor 18%, transparent)",
  },
  columnTitle: {
    fontSize: type.sm,
    fontWeight: 700,
    color: colors.text,
    letterSpacing: "0.01em",
  },
  columnCount: {
    fontSize: type.xs,
    fontWeight: 600,
    color: colors.textMuted,
    fontFamily: type.mono,
    backgroundColor: colors.surfaceActive,
    borderRadius: radii.full,
    paddingInline: "7px",
    paddingBlock: "1px",
    lineHeight: 1.6,
    minWidth: "22px",
    textAlign: "center",
  },
  spacer: { flexGrow: 1 },
  cards: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    paddingBlock: space.xs,
    paddingInline: space.sm,
    paddingBottom: space.sm,
    overflowY: "auto",
    flexGrow: 1,
    minHeight: "80px",
    overscrollBehavior: "contain",
  },
  card: {
    position: "relative",
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": colors.borderStrong },
    borderRadius: radii.md,
    paddingBlock: "10px",
    paddingInline: space.md,
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    boxShadow: colors.shadowSm,
    transition: "border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease, transform 160ms ease",
    outline: "none",
    userSelect: "none",
    touchAction: "manipulation",
  },
  cardSelected: {
    borderColor: { default: colors.accent, ":hover": colors.accent },
    boxShadow: `0 0 0 3px ${colors.ring}`,
  },
  cardLifted: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: 0,
    overflow: "hidden",
    opacity: 0,
    pointerEvents: "none",
    borderWidth: 0,
  },
  slot: {
    flexShrink: 0,
    boxSizing: "border-box",
    borderRadius: radii.md,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    transition: "height 160ms ease",
  },
  ghost: {
    position: "fixed",
    left: 0,
    top: 0,
    zIndex: 40,
    pointerEvents: "none",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.accent,
    borderRadius: radii.md,
    paddingBlock: "10px",
    paddingInline: space.md,
    boxShadow: colors.shadow,
    opacity: 0.96,
  },
  ghostTitle: {
    fontSize: type.md,
    fontWeight: 500,
    color: colors.text,
    lineHeight: 1.4,
    margin: 0,
    overflow: "hidden",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
  },
  cardTop: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    minHeight: "22px",
  },
  cardId: {
    fontFamily: type.mono,
    fontSize: type.xs,
    color: colors.textFaint,
    letterSpacing: "0.01em",
  },
  cardTitle: {
    fontSize: type.md,
    fontWeight: 500,
    color: colors.text,
    lineHeight: 1.4,
    overflowWrap: "anywhere",
    margin: 0,
  },
  cardMeta: {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    flexWrap: "wrap",
    minHeight: "22px",
  },
  emptyColumn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginInline: space.xs,
    marginTop: space.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    color: colors.textFaint,
    fontSize: type.sm,
    height: "64px",
    transition: "border-color 120ms ease, color 120ms ease, background-color 120ms ease",
  },
  emptyColumnOver: {
    borderColor: colors.accent,
    color: colors.accent,
    backgroundColor: colors.surface,
  },
  emptyColumnHint: { display: "inline-flex", alignItems: "center", gap: space.xs },
});

export const Board = ({
  rows,
  readOnly,
  canCreate,
  selectedId,
  onSelect,
  onNew,
  onMove,
}: {
  rows: readonly BoardRow[];
  /** Time travel: the past is not editable (and drags would be lies). */
  readOnly: boolean;
  /**
   * Viewers get a polite UI (no "+" buttons) but drags stay enabled on
   * purpose: the proof of enforcement is the peer's `Unauthorized` toast.
   */
  canCreate: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNew: (status: Status) => void;
  onMove: (id: number, status: Status, rank: number) => void;
}) => {
  const [dragId, setDragId] = useState<number | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [slotHeight, setSlotHeight] = useState(72);
  const [ghost, setGhost] = useState<{
    title: string;
    width: number;
    x: number;
    y: number;
  } | null>(null);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const dragIdRef = useRef(dragId);
  dragIdRef.current = dragId;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const suppressClick = useRef(false);
  const touch = useRef<{
    pointerId: number;
    row: BoardRow;
    el: HTMLElement;
    startX: number;
    startY: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const stopListen = useRef<(() => void) | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const pageLock = useRef<(() => void) | null>(null);

  const startPageLock = () => {
    if (pageLock.current !== null) return;
    pageLock.current = lockPageScroll();
  };
  const stopPageLock = () => {
    pageLock.current?.();
    pageLock.current = null;
  };

  const resetDrag = () => {
    const held = touch.current;
    if (held) {
      clearTimeout(held.timer);
      held.el.style.touchAction = "";
    }
    touch.current = null;
    stopListen.current?.();
    stopListen.current = null;
    stopPageLock();
    setDragId(null);
    setOver(null);
    setGhost(null);
  };

  const lift = (row: BoardRow, el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    setSlotHeight(Math.max(56, Math.round(box.height)));
    setOver(homeDropTarget(rowsRef.current, row.id));
    setDragId(row.id);
  };

  const commitDrop = (status: Status, beforeId: number | undefined) => {
    const id = dragIdRef.current;
    if (id === null) return;
    onMoveRef.current(id, status, rankForDrop(rowsRef.current, id, status, beforeId));
    resetDrag();
  };

  const drop = (status: Status, before: BoardRow | undefined) => {
    commitDrop(status, before?.id);
  };

  useEffect(() => () => resetDrag(), []);

  // The board is `overflow-x: auto` so columns can pan, and the document
  // itself rubber-bands on iOS. While a card is in flight, freeze both.
  useLayoutEffect(() => {
    if (dragId === null) return;
    startPageLock();
    const el = boardRef.current;
    if (el === null) return;
    const pin = pinScrollLeft(el);
    pin();
    const prevent = (e: Event) => {
      e.preventDefault();
    };
    el.addEventListener("scroll", pin);
    el.addEventListener("touchmove", prevent, { passive: false });
    el.addEventListener("wheel", prevent, { passive: false });
    return () => {
      el.removeEventListener("scroll", pin);
      el.removeEventListener("touchmove", prevent);
      el.removeEventListener("wheel", prevent);
      pin();
      stopPageLock();
    };
  }, [dragId]);

  const listenTouch = () => {
    stopListen.current?.();
    const onMove = (e: PointerEvent) => {
      const held = touch.current;
      if (held === null || e.pointerId !== held.pointerId) return;
      held.x = e.clientX;
      held.y = e.clientY;
      if (dragIdRef.current === null) {
        const dx = e.clientX - held.startX;
        const dy = e.clientY - held.startY;
        if (dx * dx + dy * dy > TOUCH_CANCEL_PX * TOUCH_CANCEL_PX) {
          clearTimeout(held.timer);
          touch.current = null;
          stopListen.current?.();
          stopListen.current = null;
        }
        return;
      }
      e.preventDefault();
      setGhost((g) => (g === null ? g : { ...g, x: e.clientX, y: e.clientY }));
      const next = dropTargetFromPoint(e.clientX, e.clientY, dragIdRef.current);
      if (next) setOver(next);
    };
    const onUp = (e: PointerEvent) => {
      const held = touch.current;
      if (held === null || e.pointerId !== held.pointerId) return;
      const id = dragIdRef.current;
      if (id === null) {
        resetDrag();
        return;
      }
      const target = dropTargetFromPoint(e.clientX, e.clientY, id);
      if (target) commitDrop(target.status, target.beforeId);
      else resetDrag();
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    stopListen.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  };

  const onCardPointerDown = (row: BoardRow, e: React.PointerEvent<HTMLElement>) => {
    if (readOnly || e.button !== 0) return;
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    const el = e.currentTarget;
    clearTimeout(touch.current?.timer);
    touch.current = {
      pointerId: e.pointerId,
      row,
      el,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        const held = touch.current;
        if (held === null) return;
        suppressClick.current = true;
        startPageLock();
        held.el.style.touchAction = "none";
        try {
          held.el.setPointerCapture(held.pointerId);
        } catch {
          /* capture is optional — window listeners still track the finger */
        }
        try {
          navigator.vibrate?.(10);
        } catch {
          /* iOS has no vibrate */
        }
        lift(held.row, held.el);
        setGhost({
          title: held.row.title,
          width: held.el.getBoundingClientRect().width,
          x: held.x,
          y: held.y,
        });
      }, TOUCH_HOLD_MS),
    };
    listenTouch();
  };

  const dragging = dragId !== null;

  return (
    <div {...stylex.props(styles.wrap)}>
      <p {...stylex.props(styles.touchHint)}>Hold a card, then drag to move it</p>
      <div
        ref={boardRef}
        {...stylex.props(styles.board, dragging && styles.boardDragging)}
      >
      {STATUSES.map((status) => {
        const column = rows.filter((r) => r.status === status);
        const visible = dragging ? column.filter((r) => r.id !== dragId) : column;
        const hovering = over?.status === status && dragging;
        const slotAt = hovering ? insertIndex(visible.map((r) => r.id), over.beforeId) : -1;
        return (
          <section
            key={status}
            aria-label={STATUS_LABELS[status]}
            data-reef-column={status}
            {...stylex.props(styles.column, hovering && styles.columnOver)}
            onDragOver={(e) => {
              e.preventDefault();
              const hit = e.target as Element;
              if (hit.closest?.("[data-reef-card]") || hit.closest?.("[data-reef-slot]")) return;
              setOver({ status, beforeId: undefined });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (over?.status === status) commitDrop(over.status, over.beforeId);
              else drop(status, undefined);
            }}
          >
            <header {...stylex.props(styles.columnHead)}>
              <span
                {...stylex.props(styles.columnDot)}
                style={{ backgroundColor: COLUMN_TINTS[status], color: COLUMN_TINTS[status] }}
              />
              <span {...stylex.props(styles.columnTitle)}>
                {STATUS_LABELS[status]}
              </span>
              <span {...stylex.props(styles.columnCount)}>{column.length}</span>
              <span {...stylex.props(styles.spacer)} />
              {!readOnly && canCreate && (
                <IconButton
                  icon="plus"
                  size="sm"
                  label={`New issue in ${STATUS_LABELS[status]}`}
                  onClick={() => onNew(status)}
                />
              )}
            </header>
            <div {...stylex.props(styles.cards)}>
              {visible.length === 0 && slotAt < 0 && (
                <div
                  {...stylex.props(styles.emptyColumn, hovering && styles.emptyColumnOver)}
                >
                  <span {...stylex.props(styles.emptyColumnHint)}>
                    {dragging ? (
                      <>
                        <Icon name="plus" size={13} /> Drop here
                      </>
                    ) : readOnly ? (
                      "Nothing here at this point in time"
                    ) : (
                      "No issues"
                    )}
                  </span>
                </div>
              )}
              {column.map((row) => {
                const liftedCard = row.id === dragId;
                const visIdx = visible.findIndex((r) => r.id === row.id);
                const order =
                  visIdx < 0
                    ? 50
                    : slotAt >= 0 && visIdx >= slotAt
                      ? visIdx + 1
                      : visIdx;
                return (
                  <article
                    key={row.id}
                    tabIndex={liftedCard ? -1 : 0}
                    data-reef-card={row.id}
                    data-reef-status={status}
                    draggable={!readOnly}
                    {...stylex.props(
                      styles.card,
                      !liftedCard && row.id === selectedId && styles.cardSelected,
                      liftedCard && styles.cardLifted,
                    )}
                    style={{ order }}
                    onClick={() => {
                      if (liftedCard || suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      onSelect(row.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(row.id);
                      }
                    }}
                    onPointerDown={(e) => onCardPointerDown(row, e)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      startPageLock();
                      lift(row, e.currentTarget);
                    }}
                    onDragEnd={() => {
                      stopPageLock();
                      setDragId(null);
                      setOver(null);
                      setGhost(null);
                    }}
                    onDragOver={(e) => {
                      if (liftedCard) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const box = e.currentTarget.getBoundingClientRect();
                      const after = e.clientY > (box.top + box.bottom) / 2;
                      const ids = visible.map((r) => r.id);
                      setOver({
                        status,
                        beforeId: after ? afterCardBeforeId(ids, row.id) : row.id,
                      });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (over?.status === status) commitDrop(over.status, over.beforeId);
                      else drop(status, row);
                    }}
                  >
                    <div {...stylex.props(styles.cardTop)}>
                      <PriorityIcon
                        level={row.priority}
                        size={14}
                        title={PRIORITIES[row.priority] ?? PRIORITIES[0]}
                      />
                      <span {...stylex.props(styles.cardId)}>#{row.id}</span>
                      <span {...stylex.props(styles.spacer)} />
                      {row.assignee !== undefined && (
                        <Avatar name={row.assignee.name} title={`Assigned to ${row.assignee.name}`} />
                      )}
                    </div>
                    <p {...stylex.props(styles.cardTitle)}>{row.title}</p>
                    {row.labels.length > 0 && (
                      <div {...stylex.props(styles.cardMeta)}>
                        {row.labels.map((label) => (
                          <LabelBadge key={label.id} name={label.name} color={label.color} />
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
              {slotAt >= 0 && (
                <div
                  data-reef-slot=""
                  data-reef-status={status}
                  data-reef-before={over?.beforeId ?? ""}
                  {...stylex.props(styles.slot)}
                  style={{ height: slotHeight, order: slotAt }}
                />
              )}
            </div>
          </section>
        );
      })}
      {ghost !== null && (
        <div
          {...stylex.props(styles.ghost)}
          style={{
            width: ghost.width,
            transform: `translate(${ghost.x - ghost.width / 2}px, ${ghost.y - 56}px) rotate(2deg)`,
          }}
        >
          <p {...stylex.props(styles.ghostTitle)}>{ghost.title}</p>
        </div>
      )}
      </div>
    </div>
  );
};
