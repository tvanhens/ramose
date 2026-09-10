import { useMutationFeedback } from "../MutationFeedback.tsx";
import type { EntityHandleFor } from "ramose/client";
import { Workspace } from "../../domain/schema.ts";
import { personLabel, type IssueRow, type PersonRow, type Member } from "../entities.ts";
import { useMemo, useState } from "react";
import { useDb, useQuery, useSuspenseQuery } from "ramose/react";
import {
  boardIssues,
  people,
  workspaces,
} from "../../domain/queries.ts";
import {
  STATUSES,
  STATUS_LABELS,
  type Status,
} from "../../domain/schema.ts";
import { rankBetween } from "../../domain/rank.ts";
import type { ReefMutations } from "../ramose.ts";
import { IssueDetail } from "../components/IssueDetail.tsx";
import { MembersPanel } from "../components/MembersPanel.tsx";

const Column = (props: {
  readonly status: Status;
  readonly issues: readonly IssueRow[];
  readonly selected: string | undefined;
  readonly peopleById: ReadonlyMap<string, PersonRow>;
  readonly onSelect: (id: string) => void;
  readonly onDropIssue: (issueId: string, status: Status, beforeIndex: number) => void;
  readonly onCreate: (status: Status, title: string) => void;
}) => {
  const [title, setTitle] = useState("");
  const [over, setOver] = useState(false);

  return (
    <section
      className={`column${over ? " column-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData("text/reef-issue");
        if (id) props.onDropIssue(id, props.status, props.issues.length);
      }}
    >
      <header className="column-head">
        <span>{STATUS_LABELS[props.status]}</span>
        <span className="count">{props.issues.length}</span>
      </header>
      <div className="column-cards">
        {props.issues.map((issue, index) => {
          const id = String(issue.id);
          const assignee = issue.data.assignee
            ? props.peopleById.get(issue.data.assignee.id)
            : undefined;
          return (
            <article
              key={id}
              draggable
              className={[
                "card",
                props.selected === id ? "card-selected" : "",
                issue.local.pending ? "card-pending" : "",
              ].join(" ").trim()}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/reef-issue", id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOver(false);
                const dragged = e.dataTransfer.getData("text/reef-issue");
                if (dragged && dragged !== id) {
                  props.onDropIssue(dragged, props.status, index);
                }
              }}
              onClick={() => props.onSelect(id)}
            >
              <span className={`priority priority-${issue.data.priority}`} />
              <span className="card-title">{issue.data.title}</span>
              {assignee && (
                <span className="avatar" title={personLabel(assignee)}>
                  {personLabel(assignee).slice(0, 1).toUpperCase()}
                </span>
              )}
            </article>
          );
        })}
      </div>
      <form
        className="column-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() === "") return;
          props.onCreate(props.status, title.trim());
          setTitle("");
        }}
      >
        <input
          placeholder="Add an issue…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </form>
    </section>
  );
};

export const BoardScreen = (props: { readonly slug: string }) => {
  const db = useDb<ReefMutations>();
  const result = useSuspenseQuery(workspaces(db), db);
  if (result.status === "error") return <div role="alert" className="error">{result.error.message}</div>;
  if (result.status !== "ready" && result.status !== "stale") return null;
  const workspace = result.data.find((row) => row.data.slug === props.slug);
  return workspace === undefined
    ? <p>This workspace is unavailable. <a href="#/">Back to workspaces</a></p>
    : <WorkspaceBoard key={workspace.id} workspace={workspace} />;
};

const WorkspaceBoard = (props: { readonly workspace: EntityHandleFor<typeof Workspace> }) => {
  const root = useDb<ReefMutations>();
  const board = root;
  const workspace = props.workspace;
  const track = useMutationFeedback();
  const rows = useSuspenseQuery(boardIssues(board, workspace.id), board);
  const folk = useQuery(people(board), board);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [membersOpen, setMembersOpen] = useState(false);

  const issues = rows.status === "ready" || rows.status === "stale"
    ? rows.data
    : [];
  const persons = folk.status === "ready" || folk.status === "stale"
    ? folk.data
    : [];
  const peopleById = useMemo(
    () => new Map(persons.map((person) => [String(person.id), person])),
    [persons],
  );

  const byStatus = useMemo(() => {
    const grouped = new Map<Status, IssueRow[]>(
      STATUSES.map((status) => [status, []]),
    );
    for (const issue of issues) grouped.get(issue.data.status)?.push(issue);
    return grouped;
  }, [issues]);

  const memberIds = new Set(
    (workspace?.data.members ?? []).map((member) => member.id),
  );
  const members: readonly Member[] = persons
    .filter((person) => memberIds.has(person.id))
    .map((person) => ({ sub: person.data.sub, label: personLabel(person) }));

  const dropIssue = (issueId: string, status: Status, beforeIndex: number) => {
    const issue = issues.find((row) => String(row.id) === issueId);
    if (issue === undefined) return;
    const column = (byStatus.get(status) ?? []).filter(
      (row) => String(row.id) !== issueId,
    );
    const at = Math.min(beforeIndex, column.length);
    const before = column[at - 1]?.data.rank;
    const after = column[at]?.data.rank;
    track(issue.mutate.moveIssue({ status, rank: rankBetween(before, after) }), "Move issue");
  };

  const createIssue = (status: Status, title: string) => {
    if (workspace === undefined) return;
    const column = byStatus.get(status) ?? [];
    const last = column[column.length - 1]?.data.rank;
    track(board.mutate.createIssue({
      workspace: workspace.id,
      title,
      status,
      rank: rankBetween(last, undefined),
    }), "Create issue");
  };

  const selectedIssue = selected === undefined
    ? undefined
    : issues.find((row) => String(row.id) === selected);

  return (
    <main className="board">
      <header className="board-head">
        <h2>{workspace.data.label ?? workspace.data.slug}</h2>
        {rows.status === "stale" && <span className="stale-tag">offline copy</span>}
        <button className="ghost" onClick={() => setMembersOpen(true)}>
          Members
        </button>
      </header>
      {rows.status === "error" && <div className="error">{String(rows.error)}</div>}
      <div className="columns">
        {STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            issues={byStatus.get(status) ?? []}
            selected={selected}
            peopleById={peopleById}
            onSelect={setSelected}
            onDropIssue={dropIssue}
            onCreate={createIssue}
          />
        ))}
      </div>
      {selectedIssue !== undefined && workspace !== undefined && (
        <IssueDetail
          board={board}
          issue={selectedIssue}
          workspaceId={workspace.id}
          peopleById={peopleById}
          members={members}
          onClose={() => setSelected(undefined)}
        />
      )}
      {membersOpen && workspace !== undefined && (
        <MembersPanel
          root={root}
          workspace={workspace}
          onClose={() => setMembersOpen(false)}
        />
      )}
    </main>
  );
};
