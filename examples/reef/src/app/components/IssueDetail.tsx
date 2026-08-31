import { useEffect, useState } from "react";
import type { ClientDatabase } from "ramose/client";
import { useQuery } from "ramose/react";
import { boardLabels, issueComments } from "../../domain/queries.ts";
import {
  PRIORITIES,
  PRIORITY_LABELS,
  type Priority,
} from "../../domain/schema.ts";
import type { ReefMutations } from "../ramose.ts";
import { personLabel, type IssueRow, type PersonRow } from "../screens/BoardScreen.tsx";

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
    readonly setAssignee: (input: { assignee?: string }) => unknown;
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
  readonly peopleById: ReadonlyMap<string, PersonRow>;
  readonly persons: readonly PersonRow[];
  readonly onClose: () => void;
}) => {
  const issue = props.issue as DetailIssue;
  const issueId = String(issue.id);

  const [title, setTitle] = useState(issue.data.title);
  const [description, setDescription] = useState(issue.data.description ?? "");
  const [note, setNote] = useState(issue.data.privateNote ?? "");
  const [comment, setComment] = useState("");
  const [labelName, setLabelName] = useState("");
  useEffect(() => {
    setTitle(issue.data.title);
    setDescription(issue.data.description ?? "");
    setNote(issue.data.privateNote ?? "");
  }, [issueId]);

  const comments = useQuery(issueComments(props.board, issueId), props.board);
  const labels = useQuery(boardLabels(props.board), props.board);
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
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title.trim() !== "" && title !== issue.data.title) {
              issue.mutate.editIssue({ title: title.trim() });
            }
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
          value={issue.data.assignee?.id ?? ""}
          onChange={(e) =>
            issue.mutate.setAssignee(
              e.target.value === "" ? {} : { assignee: e.target.value },
            )}
        >
          <option value="">Unassigned</option>
          {props.persons.map((person) => (
            <option key={String(person.id)} value={String(person.id)}>
              {personLabel(person)}
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
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            if (description !== (issue.data.description ?? "")) {
              issue.mutate.editIssue({ description });
            }
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
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note !== (issue.data.privateNote ?? "")) {
              issue.mutate.setPrivateNote({ note });
            }
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
