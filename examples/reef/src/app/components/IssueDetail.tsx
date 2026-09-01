import { useEffect, useState } from "react";
import type { ClientDatabase } from "ramose/client";
import type { MutationRef } from "ramose/db";
import { useQuery } from "ramose/react";
import { boardLabels, issueComments } from "../../domain/queries.ts";
import {
  PRIORITIES,
  PRIORITY_LABELS,
  type Priority,
} from "../../domain/schema.ts";
import type { ReefMutations } from "../ramose.ts";
import {
  personLabel,
  type IssueRow,
  type Member,
  type PersonRow,
} from "../screens/BoardScreen.tsx";

type ReefDb = ClientDatabase<ReefMutations>;

type DetailIssue = IssueRow & {
  readonly data: IssueRow["data"] & {
    readonly description?: string | undefined;
    readonly privateNote?: string | undefined;
    readonly labels?: readonly { readonly id: string }[] | undefined;
  };
  readonly mutate: IssueRow["mutate"] & {
    readonly editIssue: (input: {
      title?: string;
      description?: string;
    }) => unknown;
    readonly setPriority: (input: { priority: Priority }) => unknown;
    readonly setAssignee: (input: { sub?: string; name?: string }) => unknown;
    readonly addLabel: (input: { label: string }) => unknown;
    readonly removeLabel: (input: { label: string }) => unknown;
    readonly setPrivateNote: (input: { note: string }) => unknown;
    readonly deleteIssue: (input: Record<never, never>) => unknown;
  };
};

type CommentRow = {
  readonly id: unknown;
  readonly data: {
    readonly body: string;
    readonly at: Date;
    readonly author?: { readonly id: string } | undefined;
  };
};

type LabelRow = {
  readonly id: unknown;
  readonly data: { readonly name: string; readonly color: string };
};

const LABEL_COLORS = ["#5e6ad2", "#26b5ce", "#4cb782", "#f2c94c", "#eb5757"];

export const IssueDetail = (props: {
  readonly board: ReefDb;
  readonly issue: IssueRow;
  readonly workspaceId: MutationRef;
  readonly workspaceSlug: string;
  readonly peopleById: ReadonlyMap<string, PersonRow>;
  readonly members: readonly Member[];
  readonly onClose: () => void;
}) => {
  const issue = props.issue as DetailIssue;
  const issueId = String(issue.id);

  const [title, setTitle] = useState(issue.data.title);
  const [description, setDescription] = useState(issue.data.description ?? "");
  const [note, setNote] = useState(issue.data.privateNote ?? "");
  const [dirty, setDirty] = useState<{
    title?: boolean;
    description?: boolean;
    note?: boolean;
  }>({});
  const [comment, setComment] = useState("");
  const [labelName, setLabelName] = useState("");
  useEffect(() => {
    setTitle(issue.data.title);
    setDescription(issue.data.description ?? "");
    setNote(issue.data.privateNote ?? "");
    setDirty({});
  }, [issueId]);
  useEffect(() => {
    if (!dirty.title) setTitle(issue.data.title);
    if (!dirty.description) setDescription(issue.data.description ?? "");
    if (!dirty.note) setNote(issue.data.privateNote ?? "");
  }, [issue.data.title, issue.data.description, issue.data.privateNote]);

  const comments = useQuery(issueComments(props.board, issueId), props.board);
  const labels = useQuery(
    boardLabels(props.board, props.workspaceSlug),
    props.board,
  );
  const allLabels = labels.status === "ready" || labels.status === "stale"
    ? (labels.data as unknown as readonly LabelRow[])
    : [];
  const attached = new Set((issue.data.labels ?? []).map((label) => label.id));

  const commentRows = comments.status === "ready" || comments.status === "stale"
    ? (comments.data as unknown as readonly CommentRow[])
    : [];

  return (
    <aside className="detail">
      <header className="detail-head">
        <input
          className="detail-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty((d) => ({ ...d, title: true }));
          }}
          onBlur={() => {
            if (dirty.title && title.trim() !== "" && title !== issue.data.title) {
              issue.mutate.editIssue({ title: title.trim() });
            }
            setDirty((d) => ({ ...d, title: false }));
          }}
        />
        <button className="ghost" onClick={props.onClose}>
          ✕
        </button>
      </header>

      <label className="field">
        <span>Priority</span>
        <select
          value={issue.data.priority}
          onChange={(e) =>
            issue.mutate.setPriority({ priority: e.target.value as Priority })}
        >
          {PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {PRIORITY_LABELS[priority]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Assignee</span>
        <select
          value={(issue.data.assignee
            ? props.peopleById.get(issue.data.assignee.id)?.data.sub
            : undefined) ?? ""}
          onChange={(e) => {
            const sub = e.target.value;
            const member = props.members.find((m) => m.sub === sub);
            issue.mutate.setAssignee(
              sub === "" ? {} : { sub, ...(member ? { name: member.label } : {}) },
            );
          }}
        >
          <option value="">Unassigned</option>
          {props.members.map((member) => (
            <option key={member.sub} value={member.sub}>
              {member.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Description</span>
        <textarea
          rows={4}
          value={description}
          placeholder="Add a description…"
          onChange={(e) => {
            setDescription(e.target.value);
            setDirty((d) => ({ ...d, description: true }));
          }}
          onBlur={() => {
            if (dirty.description && description !== (issue.data.description ?? "")) {
              issue.mutate.editIssue({ description });
            }
            setDirty((d) => ({ ...d, description: false }));
          }}
        />
      </label>

      <div className="field">
        <span>Labels</span>
        <div className="labels">
          {allLabels.map((label) => {
            const id = String(label.id);
            const on = attached.has(id);
            return (
              <button
                key={id}
                className={`label${on ? " label-on" : ""}`}
                style={{ borderColor: label.data.color }}
                onClick={() =>
                  on
                    ? issue.mutate.removeLabel({ label: id })
                    : issue.mutate.addLabel({ label: id })}
              >
                {label.data.name}
              </button>
            );
          })}
          <form
            className="label-new"
            onSubmit={(e) => {
              e.preventDefault();
              const name = labelName.trim();
              if (name === "" || allLabels.some((l) => l.data.name === name)) {
                return;
              }
              props.board.mutate.createLabel({
                workspace: props.workspaceId,
                workspaceSlug: props.workspaceSlug,
                name,
                color: LABEL_COLORS[allLabels.length % LABEL_COLORS.length]!,
              });
              setLabelName("");
            }}
          >
            <input
              placeholder="New label"
              value={labelName}
              onChange={(e) => setLabelName(e.target.value)}
            />
          </form>
        </div>
      </div>

      <label className="field">
        <span>Private note (only you see this)</span>
        <textarea
          rows={2}
          value={note}
          placeholder="Visible to the issue creator only — a field-level policy rule"
          onChange={(e) => {
            setNote(e.target.value);
            setDirty((d) => ({ ...d, note: true }));
          }}
          onBlur={() => {
            if (dirty.note && note !== (issue.data.privateNote ?? "")) {
              issue.mutate.setPrivateNote({ note });
            }
            setDirty((d) => ({ ...d, note: false }));
          }}
        />
      </label>

      <div className="field">
        <span>Comments</span>
        <div className="comments">
          {commentRows.map((row) => (
            <div key={String(row.id)} className="comment">
              <span className="comment-author">
                {personLabel(
                  row.data.author
                    ? props.peopleById.get(row.data.author.id)
                    : undefined,
                )}
              </span>
              <span className="comment-body">{row.data.body}</span>
            </div>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const body = comment.trim();
            if (body === "") return;
            props.board.mutate.createComment({
              issue: issueId as never,
              body,
            });
            setComment("");
          }}
        >
          <input
            placeholder="Write a comment…"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </form>
      </div>

      <button
        className="danger"
        onClick={() => {
          issue.mutate.deleteIssue({});
          props.onClose();
        }}
      >
        Delete issue
      </button>
    </aside>
  );
};
