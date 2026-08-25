/**
 * The browser side, end to end: sign in once, discover workspaces with a
 * trait query, enter one, work inside it. One credential crosses every graph
 * the functions allow — there is no per-database token (compare Reef's
 * `openWorkspace`, which mints a token per workspace slug and threads a
 * `provision` flag).
 *
 * In the real package these imports would be `ramose/db` and `ramose/react`.
 */

import { useState } from "react";
import * as Ramose from "./future.ts";
import { useLiveQuery, useOperation } from "./future.ts";
import { createWsOp, orgCatalog } from "./org.ts";
import {
  createIssueOp,
  Issue,
  moveIssueOp,
  workspaceCatalog,
} from "./workspace.ts";
import { addTagOp } from "./taggable.ts";

// ── connection ───────────────────────────────────────────────────────────────

const ramose = Ramose.connect({
  url: "https://atoll.example",
  token: Ramose.token.jwt(async () => "…mint from the auth provider…"),
});

/**
 * Opening the root. Entry to the root is implicit (it has no parent to run an
 * enter function in) — any verified credential lands here and is provisioned
 * a `user` row.
 *
 * ergonomics: "org" the path segment is the root catalog's key — but nothing
 * says so. Is the root's address its catalog key, a name from Server config,
 * or should the client have a dedicated `ramose.root(orgCatalog)`?
 */
const org = ramose.open("org", orgCatalog);

// ── discovery: a trait query (#312 §Discovery) ───────────────────────────────

/**
 * Every graph row this caller may `read`, whatever entity kind holds it —
 * filtered by the org policy's ordinary read rules (here: `memberOf`), live
 * like any query. This same query is an agent's `learn()`.
 */
const myWorkspaces = Ramose.Query.from(Ramose.Graph).select({
  id: Ramose.Graph.id,
  name: Ramose.Graph.name,
  doc: Ramose.Graph.doc,
});

type WsHandle = Ramose.GraphHandle<typeof workspaceCatalog>;

const WorkspacePicker = ({ onOpen }: { onOpen: (ws: WsHandle) => void }) => {
  const { data } = useLiveQuery(org, myWorkspaces);
  const { run: createWs } = useOperation(org, createWsOp);

  return (
    <div>
      <h1>Workspaces</h1>
      <ul>
        {data?.map((ws) => (
          <li key={ws.id}>
            {/*
             * Entering a child graph. The path re-states what `ws` already
             * knows, and `workspaceCatalog` re-states what the row's
             * `:graph/catalog` stamp already records — both are runtime
             * errors if wrong. ergonomics: the discovery row should be
             * openable directly — `ramose.open(ws)` — with the handle typed
             * from the Graph composition's closed-over catalog. What type
             * does that give when kinds composing Graph(differentCatalog)
             * mix in one result? See README §client.
             */}
            <button onClick={() => onOpen(ramose.open(`org/${ws.name}`, workspaceCatalog))}>
              {ws.name}
            </button>
            {ws.doc}
          </li>
        ))}
      </ul>
      <button onClick={() => void createWs({ name: "acme", doc: "Acme Corp" })}>
        New workspace
      </button>
      {/* createWs commits the graph row AND the creator's membership in one
          transaction; the new workspace appears in `data` via the live query.
          No install step, no second round trip. */}
    </div>
  );
};

// ── inside a workspace: unchanged Ramose (#312's whole point) ────────────────

const board = Ramose.Query.from(Issue)
  .select({
    id: Issue.id,
    title: Issue.title,
    status: Issue.status,
    tags: Issue.tags, // a trait field, selected like any own field
  })
  .orderBy(Issue.createdAt, "asc");

type BoardRow = Ramose.Row<typeof board>;

const NEXT = { todo: "doing", doing: "done", done: "todo" } as const;

const Board = ({ ws }: { ws: WsHandle }) => {
  const { data } = useLiveQuery(ws, board);
  const { run: create } = useOperation(ws, createIssueOp);
  const { run: move } = useOperation(ws, moveIssueOp);
  const { run: tag } = useOperation(ws, addTagOp);

  const advance = (issue: BoardRow) =>
    void move(issue.id, { status: NEXT[issue.status] });

  return (
    <div>
      <h1>{ws.path}</h1>
      <ul>
        {data?.map((issue) => (
          <li key={issue.id}>
            <button onClick={() => advance(issue)}>{issue.status}</button>
            {issue.title}
            {issue.tags.map((t) => (
              <em key={t}> #{t}</em>
            ))}
            <button onClick={() => void tag(issue.id, { tag: "urgent" })}>
              tag urgent
            </button>
          </li>
        ))}
      </ul>
      <button onClick={() => void create({ title: "New issue" })}>
        New issue
      </button>
      {/* If this caller isn't the issue's creator, `move` is rejected by the
          workspace policy's `mine` rule server-side — the optimistic prefix
          rolls back. Buttons are merely polite, as in Reef. */}
    </div>
  );
};

export const App = () => {
  const [ws, setWs] = useState<WsHandle | null>(null);
  return ws === null ? <WorkspacePicker onOpen={setWs} /> : <Board ws={ws} />;
};
