import { ChangesetPanel } from "../components/ChangesetPanel.tsx";
import { useEffect, useMemo, useState } from "react";
import type { Changeset, ClientDatabase, DatabaseView } from "ramose/client";
import { useChangesets, useDb, useQuery, useSuspenseQuery } from "ramose/react";
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

type ReefDb = ClientDatabase<ReefMutations>;

export type IssueRow = {
  readonly id: unknown;
  readonly data: {
    readonly title: string;
    readonly status: Status;
    readonly priority: string;
    readonly rank: number;
    readonly assignee?: { readonly id: string } | undefined;
    readonly creator?: { readonly id: string } | undefined;
  };
  readonly local: { readonly pending: boolean };
  readonly mutate: {
    readonly moveIssue: (input: { status: Status; rank: number }) => unknown;
  };
};

export type PersonRow = {
  readonly id: unknown;
  readonly data: {
    readonly sub: string;
    readonly name?: string | undefined;
    readonly email?: string | undefined;
  };
};

export type Member = {
  readonly sub: string;
  readonly label: string;
};

export const personLabel = (person: PersonRow | undefined): string =>
  person?.data.name ?? person?.data.email ?? "Someone";

const Column = (props: {
  readonly status: Status;
  readonly readOnly?: boolean;
  readonly issues: readonly (Pick<IssueRow, "id" | "data"> & { readonly local?: IssueRow["local"] })[];
  readonly selected: string | undefined;
  readonly peopleById: ReadonlyMap<string, PersonRow>;
  readonly onSelect?: (id: string) => void;
  readonly onDropIssue?: (issueId: string, status: Status, beforeIndex: number) => void;
  readonly onCreate?: (status: Status, title: string) => void;
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
        if (id) props.onDropIssue?.(id, props.status, props.issues.length);
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
              draggable={!props.readOnly}
              className={[
                "card",
                props.selected === id ? "card-selected" : "",
                issue.local?.pending ? "card-pending" : "",
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
                  props.onDropIssue?.(dragged, props.status, index);
                }
              }}
              onClick={() => props.onSelect?.(id)}
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
          props.onCreate?.(props.status, title.trim());
          setTitle("");
        }}
      >
        <input
          disabled={props.readOnly}
          placeholder="Add an issue…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </form>
    </section>
  );
};

const ProposedBoard = (props: { readonly view: DatabaseView; readonly slug: string; readonly onReady: (ready: boolean) => void }) => {
  const issues = useQuery(boardIssues(props.view, props.slug), props.view);
  const persons = useQuery(people(props.view), props.view);
  useEffect(() => props.onReady(issues.status === "ready" && persons.status === "ready"), [issues.status, persons.status, props.onReady]);
  if (issues.status === "error" || persons.status === "error") return <p role="alert">This proposal is no longer available at its reviewed revision. Reopen it or prepare a new proposal.</p>;
  if (issues.status !== "ready" || persons.status !== "ready") return <p role="status">Loading proposed board…</p>;
  const peopleById = new Map(persons.data.map((person) => [person.id, person]));
  return <div className="columns">{STATUSES.map((status) => <Column key={status} status={status}
    readOnly issues={issues.data.filter((issue) => issue.data.status === status)} selected={undefined} peopleById={peopleById} />)}</div>;
};

export const BoardScreen = (props: { readonly slug: string }) => {
  const changesets = useChangesets();
  const root = useDb<ReefMutations>();
  const board = root as ReefDb;

  const rows = useSuspenseQuery(boardIssues(board, props.slug), board);
  const folk = useQuery(people(board), board);
  const rootWorkspaces = useQuery(workspaces(root), root);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [membersOpen, setMembersOpen] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [proposal, setProposal] = useState<Changeset | undefined>();

  const liveIssues = rows.status === "ready" || rows.status === "stale"
    ? (rows.data as unknown as readonly IssueRow[])
    : [];
  const previewing = proposal?.status === "draft";
  const issues = liveIssues;
  const persons = folk.status === "ready" || folk.status === "stale"
    ? (folk.data as unknown as readonly PersonRow[])
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

  const workspace = (rootWorkspaces.status === "ready" ||
      rootWorkspaces.status === "stale")
    ? rootWorkspaces.data.find((row) => row.data.slug === props.slug)
    : undefined;

  const directory = useQuery(people(root), root);
  const rootPersons = directory.status === "ready" || directory.status === "stale"
    ? (directory.data as unknown as readonly PersonRow[])
    : [];
  const memberIds = new Set(
    ((workspace?.data as { members?: readonly { id: string }[] } | undefined)
      ?.members ?? []).map((member) => member.id),
  );
  const members: readonly Member[] = rootPersons
    .filter((person) => memberIds.has(String(person.id)))
    .map((person) => ({ sub: person.data.sub, label: personLabel(person) }));

  const dropIssue = (issueId: string, status: Status, beforeIndex: number) => {
    if (previewing) return;
    const issue = issues.find((row) => String(row.id) === issueId);
    if (issue === undefined) return;
    const column = (byStatus.get(status) ?? []).filter(
      (row) => String(row.id) !== issueId,
    );
    const at = Math.min(beforeIndex, column.length);
    const before = column[at - 1]?.data.rank;
    const after = column[at]?.data.rank;
    issue.mutate.moveIssue({ status, rank: rankBetween(before, after) });
  };

  const createIssue = (status: Status, title: string) => {
    if (previewing || workspace === undefined) return;
    const column = byStatus.get(status) ?? [];
    const last = column[column.length - 1]?.data.rank;
    board.mutate.createIssue({
      workspace: workspace.id,
      workspaceSlug: props.slug,
      title,
      status,
      rank: rankBetween(last, undefined),
    });
  };

  const selectedIssue = selected === undefined
    ? undefined
    : issues.find((row) => String(row.id) === selected);

  return (
    <main className="board">
      <header className="board-head">
        <h2>
          {workspace
            ? String(
              (workspace.data as { label?: string }).label ?? props.slug,
            )
            : props.slug}
        </h2>
        {rows.status === "stale" && <span className="stale-tag">offline copy</span>}
        <button className="ghost" disabled={previewing} onClick={() => setMembersOpen(true)}>
          Members
        </button>
      </header>
      {rows.status === "error" && <div className="error">{String(rows.error)}</div>}
      <ChangesetPanel previewReady={previewReady} issues={liveIssues} proposal={proposal} onPreview={(value) => { setSelected(undefined); setPreviewReady(false); setProposal(value); }} />
      {previewing ? <ProposedBoard onReady={setPreviewReady} view={changesets.open(proposal.id, proposal.revision)} slug={props.slug} /> : (
      <div className="columns">
        {STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            readOnly={previewing || workspace === undefined}
            issues={byStatus.get(status) ?? []}
            selected={selected}
            peopleById={peopleById}
            onSelect={(id) => { if (!previewing) setSelected(id); }}
            onDropIssue={dropIssue}
            onCreate={createIssue}
          />
        ))}
      </div>
      )}
      {selectedIssue !== undefined && workspace !== undefined && (
        <IssueDetail
          board={board}
          issue={selectedIssue}
          workspaceId={workspace.id}
          workspaceSlug={props.slug}
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
