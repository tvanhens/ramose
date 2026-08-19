/**
 * The issue side panel. Status / priority / assignee / labels come straight
 * from the live board row (so they update in place); description and the
 * admin-only note ride one standing `usePull`, so an edit from any tab lands
 * without a refetch. Every control is enabled regardless of role — the
 * peer's policy is the enforcement, and a denial surfaces as a toast.
 * `privateNote` demonstrates per-attribute rules: read-masked and
 * write-denied below `admin`.
 */

import { errorMessage, useLive, usePull, useTransact } from "ramose/react";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useMemo, useState } from "react";
import {
  commentsQuery,
  issueExtraShape,
  type BoardRow,
  type CommentRow,
  type LabelRow,
  type Person,
  type ReefDb,
} from "../../domain/queries.ts";
import type { RamoseClass } from "../../domain/shared.ts";
import {
  addComment,
  deleteComment,
  deleteIssue,
  setAssignee,
  setDescription,
  setPriority,
  setPrivateNote,
  setStatus,
  setTitle,
  toggleLabel,
} from "../mutations.ts";
import { PRIORITIES, STATUSES, STATUS_LABELS, type Status } from "../../domain/schema.ts";
import { colors, radii, space, type } from "../theme/tokens.stylex";
import {
  Avatar,
  Button,
  Code,
  Icon,
  IconButton,
  LabelToggle,
  Select,
  Tag,
  TextArea,
  useToast,
} from "../ui.tsx";
import { COLUMN_TINTS } from "./Board.tsx";

const slideIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateX(12px)" },
  to: { opacity: 1, transform: "translateX(0)" },
});

const styles = stylex.create({
  panel: {
    width: "min(420px, 90vw)",
    flexShrink: 0,
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: colors.border,
    backgroundColor: colors.bgRaised,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    animationName: slideIn,
    animationDuration: "160ms",
    animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: "10px",
    paddingInline: space.lg,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    position: "sticky",
    top: 0,
    backgroundColor: colors.bgRaised,
    zIndex: 1,
  },
  headId: {
    fontFamily: type.mono,
    fontSize: type.sm,
    color: colors.textMuted,
    fontWeight: 500,
  },
  statusDot: { width: "8px", height: "8px", borderRadius: radii.full, display: "inline-block" },
  spacer: { flexGrow: 1 },
  body: { padding: space.lg, display: "flex", flexDirection: "column", gap: space.xl },
  titleInput: {
    width: "100%",
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover, ":focus": colors.surface },
    backgroundImage: "none",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: "transparent", ":focus": colors.accent },
    borderRadius: radii.sm,
    fontSize: type.xl,
    fontWeight: 700,
    letterSpacing: "-0.01em",
    lineHeight: 1.3,
    color: colors.text,
    outline: "none",
    paddingBlock: "6px",
    paddingInline: "8px",
    marginInline: "-8px",
    boxShadow: { default: "none", ":focus": `0 0 0 3px ${colors.ring}` },
    transition: "background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease",
    fontFamily: type.family,
  },
  titleBlock: { display: "flex", flexDirection: "column", gap: space.sm },
  sectionLabel: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: type.xs,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.07em",
    color: colors.textMuted,
    marginBottom: "6px",
  },
  metaGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: space.md,
  },
  fullRow: { gridColumn: "1 / -1" },
  chips: { display: "flex", flexWrap: "wrap", gap: "6px" },
  noteHint: {
    display: "flex",
    alignItems: "flex-start",
    gap: "6px",
    fontSize: type.xs,
    color: colors.textFaint,
    marginTop: "6px",
    lineHeight: 1.45,
  },
  comments: { display: "flex", flexDirection: "column", gap: space.md },
  comment: {
    display: "flex",
    gap: space.sm,
    alignItems: "flex-start",
  },
  commentBody: {
    flexGrow: 1,
    minWidth: 0,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.md,
    borderTopLeftRadius: radii.xs,
    paddingBlock: space.sm,
    paddingInline: space.md,
  },
  commentMeta: {
    display: "flex",
    gap: space.sm,
    alignItems: "baseline",
    marginBottom: "3px",
  },
  commentAuthor: { fontSize: type.sm, fontWeight: 700, color: colors.text },
  commentAt: { fontSize: type.xs, color: colors.textFaint, flexGrow: 1 },
  commentText: {
    margin: 0,
    fontSize: type.sm,
    color: colors.text,
    lineHeight: 1.55,
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
  },
  commentDelete: {
    opacity: { default: 0.5, ":hover": 1 },
  },
  commentEmpty: {
    fontSize: type.sm,
    color: colors.textFaint,
    margin: 0,
  },
  composer: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    marginTop: space.xs,
  },
  composerRow: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
  },
  composerHint: {
    fontSize: type.xs,
    color: colors.textFaint,
    flexGrow: 1,
  },
  kbd: {
    fontFamily: type.mono,
    fontSize: "10px",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.xs,
    paddingInline: "4px",
    color: colors.textMuted,
    backgroundColor: colors.surface,
  },
  creatorLine: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    fontSize: type.sm,
    color: colors.textMuted,
  },
  creatorName: { color: colors.text, fontWeight: 600 },
});

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const IssueDetail = ({
  db,
  row,
  myEid,
  cls,
  labels,
  people,
  onClose,
}: {
  db: ReefDb;
  /** The live board row — already re-rendering on every basis tick. */
  row: BoardRow;
  myEid: number | undefined;
  cls: RamoseClass;
  labels: readonly LabelRow[];
  people: readonly Person[];
  onClose: () => void;
}) => {
  const issueId = row.id;
  const toast = useToast();
  const { run } = useTransact({
    onError: (error) => toast("error", errorMessage(error)),
  });

  const [title, setTitleDraft] = useState("");
  const [description, setDescriptionDraft] = useState("");
  const [note, setNoteDraft] = useState("");
  const [commentDraft, setCommentDraft] = useState("");

  // A standing pull: `{ id: issueId }` inline is fine (the subject is
  // structural), and every emission — an edit from any tab — resets the
  // drafts, so the panel updates in place.
  const extra = usePull(db, { id: issueId }, issueExtraShape).rows ?? null;
  useEffect(() => {
    if (extra === null) return;
    setTitleDraft(extra.title);
    setDescriptionDraft(extra.description ?? "");
    setNoteDraft(extra.privateNote ?? "");
  }, [extra]);

  // built per id, so memoise the query on `issueId` — its one dependency
  const comments = useLive(
    db,
    useMemo(() => commentsQuery(issueId), [issueId]),
  );

  const submitComment = () => {
    const body = commentDraft.trim();
    if (body === "" || myEid === undefined) return;
    setCommentDraft("");
    void run(addComment(db, myEid, issueId, body));
  };

  const status = row.status as Status;

  return (
    <aside {...stylex.props(styles.panel)} aria-label={`Issue #${issueId}`}>
      <div {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.headId)}>#{issueId}</span>
        <Tag>
          <span
            {...stylex.props(styles.statusDot)}
            style={{ backgroundColor: COLUMN_TINTS[status] ?? colors.textFaint }}
          />
          {STATUS_LABELS[status] ?? row.status}
        </Tag>
        <span {...stylex.props(styles.spacer)} />
        <IconButton
          icon="trash"
          label="Delete issue"
          tone="danger"
          onClick={() => void run(deleteIssue(db, issueId))}
        />
        <IconButton icon="x" label="Close panel" onClick={onClose} />
      </div>
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.titleBlock)}>
          <input
            {...stylex.props(styles.titleInput)}
            aria-label="Title"
            value={extra === null ? row.title : title}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            onBlur={() => {
              if (title.trim() !== "" && title !== row.title) {
                void run(setTitle(db, issueId, title.trim()));
              }
            }}
          />
          <div {...stylex.props(styles.creatorLine)}>
            <Avatar name={row.creator.name} />
            <span>
              opened by <span {...stylex.props(styles.creatorName)}>{row.creator.name}</span>
              {" · "}
              {row.createdAt.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </div>
        </div>

        <div {...stylex.props(styles.metaGrid)}>
          <div>
            <div {...stylex.props(styles.sectionLabel)}>Status</div>
            <Select
              value={row.status}
              onChange={(e) =>
                void run(setStatus(db, issueId, e.target.value as Status))
              }
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <div {...stylex.props(styles.sectionLabel)}>Priority</div>
            <Select
              value={row.priority}
              onChange={(e) =>
                void run(setPriority(db, issueId, Number(e.target.value)))
              }
            >
              {PRIORITIES.map((p, i) => (
                <option key={p} value={i}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
          <div {...stylex.props(styles.fullRow)}>
            <div {...stylex.props(styles.sectionLabel)}>Assignee</div>
            <Select
              value={row.assignee?.id ?? ""}
              onChange={(e) =>
                void run(
                  setAssignee(
                    db,
                    issueId,
                    e.target.value === "" ? undefined : Number(e.target.value),
                  ),
                )
              }
            >
              <option value="">Unassigned</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div {...stylex.props(styles.fullRow)}>
            <div {...stylex.props(styles.sectionLabel)}>Labels</div>
            <div {...stylex.props(styles.chips)}>
              {labels.map((label) => {
                const on = row.labels.some((l) => l.id === label.id);
                return (
                  <LabelToggle
                    key={label.id}
                    name={label.name}
                    color={label.color}
                    on={on}
                    onToggle={() => void run(toggleLabel(db, issueId, label.id, !on))}
                  />
                );
              })}
            </div>
          </div>
        </div>

        <div>
          <div {...stylex.props(styles.sectionLabel)}>Description</div>
          <TextArea
            value={description}
            placeholder="Add a description…"
            onChange={(e) => setDescriptionDraft(e.target.value)}
            onBlur={() => {
              if (extra !== null && description !== (extra.description ?? "")) {
                void run(setDescription(db, issueId, description.trim()));
              }
            }}
          />
        </div>

        <div>
          <div {...stylex.props(styles.sectionLabel)}>
            <Icon name="lock" size={12} />
            Admin note
            {cls !== "admin" && <Tag tone="warn">masked for {cls}</Tag>}
          </div>
          <TextArea
            value={note}
            placeholder={
              cls === "admin"
                ? "Visible to admins only…"
                : "Read-masked for your class — a write here is denied by the peer"
            }
            onChange={(e) => setNoteDraft(e.target.value)}
            onBlur={() => {
              if (extra !== null && note !== (extra.privateNote ?? "")) {
                void run(setPrivateNote(db, issueId, note.trim()));
              }
            }}
          />
          <div {...stylex.props(styles.noteHint)}>
            <Icon name="info" size={12} />
            <span>
              <Code>issue.privateNote</Code> has a narrowed read rule — the peer
              redacts the datom itself for non-admins.
            </span>
          </div>
        </div>

        <div>
          <div {...stylex.props(styles.sectionLabel)}>
            <Icon name="message" size={12} />
            Comments
            {comments.rows !== undefined && comments.rows.length > 0 && (
              <Tag>{comments.rows.length}</Tag>
            )}
          </div>
          <div {...stylex.props(styles.comments)}>
            {comments.rows !== undefined && comments.rows.length === 0 && (
              <p {...stylex.props(styles.commentEmpty)}>No comments yet.</p>
            )}
            {(comments.rows ?? []).map((comment: CommentRow) => (
              <div key={comment.id} {...stylex.props(styles.comment)}>
                <Avatar name={comment.author.name} />
                <div {...stylex.props(styles.commentBody)}>
                  <div {...stylex.props(styles.commentMeta)}>
                    <span {...stylex.props(styles.commentAuthor)}>
                      {comment.author.name}
                    </span>
                    <span {...stylex.props(styles.commentAt)}>
                      {comment.at.toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                    <span {...stylex.props(styles.commentDelete)}>
                      <IconButton
                        icon="x"
                        size="sm"
                        label="Delete comment"
                        tone="danger"
                        onClick={() => void run(deleteComment(db, comment.id))}
                      />
                    </span>
                  </div>
                  <p {...stylex.props(styles.commentText)}>{comment.body}</p>
                </div>
              </div>
            ))}
            <form
              {...stylex.props(styles.composer)}
              onSubmit={(e) => {
                e.preventDefault();
                submitComment();
              }}
            >
              <TextArea
                value={commentDraft}
                placeholder={
                  myEid === undefined ? "Viewers cannot comment" : "Leave a comment…"
                }
                disabled={myEid === undefined}
                onChange={(e) => setCommentDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitComment();
                  }
                }}
                rows={2}
              />
              <div {...stylex.props(styles.composerRow)}>
                <span {...stylex.props(styles.composerHint)}>
                  <span {...stylex.props(styles.kbd)}>{isMac ? "⌘" : "Ctrl"}</span>{" "}
                  + <span {...stylex.props(styles.kbd)}>↵</span> to send
                </span>
                <Button
                  variant="primary"
                  type="submit"
                  size="sm"
                  disabled={myEid === undefined || commentDraft.trim() === ""}
                >
                  <Icon name="send" size={12} /> Comment
                </Button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </aside>
  );
};
