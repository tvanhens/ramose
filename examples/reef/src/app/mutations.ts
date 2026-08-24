/**
 * Every write the app makes. Each is a named operation — the session overlay
 * applies the optimistic prefix locally, then the peer commits it or the
 * policy rejects it with `Unauthorized` / `OperationRejected`. A denial drops
 * the pending layer; the UI surfaces the error as a toast (enforcement
 * is server-side; the buttons are merely polite).
 */

import * as Schema from "effect/Schema";
import * as Ramose from "ramose/db";
import type { ReefDb } from "../domain/queries.ts";
import { rankAfter } from "../domain/rank.ts";
import { Comment, Issue, Label, Reef, type Status } from "../domain/schema.ts";

const Op = Ramose.Operation.for(Reef);

/** The labels every new workspace starts with. */
export const SEED_LABELS: readonly { name: string; color: string }[] = [
  { name: "bug", color: "#ef5f6b" },
  { name: "feature", color: "#5b8cff" },
  { name: "design", color: "#b17aff" },
  { name: "infra", color: "#3fb970" },
];

const StatusSchema = Schema.Literals(["backlog", "todo", "doing", "done"]);

const authFetch = (
  env: unknown,
): ((input: string, init?: RequestInit) => Promise<Response>) | undefined => {
  if (typeof env !== "object" || env === null || !("AUTH" in env)) {
    return undefined;
  }
  const auth = env.AUTH;
  if (typeof auth !== "object" || auth === null || !("fetch" in auth)) {
    return undefined;
  }
  const fetchFn = auth.fetch;
  if (typeof fetchFn !== "function") return undefined;
  return (input, init) => fetchFn.call(auth, input, init);
};

/**
 * Workspace provisioning as an operation: install + optional org registration
 * as effects, then seed labels. The peer upserts the creator's `user` row
 * (`sub`, `role`, and `ramose.attrs`) at session establishment — the body
 * must not write that row. Effects come first, so there is no optimistic
 * prefix; the creating tab has no session yet.
 */
export const provisionWorkspaceOp = Op(
  "workspace/provision",
  {
    input: Schema.Struct({}),
    output: Schema.Struct({ ready: Schema.Boolean }),
  },
  async (op) => {
    await op.effect("db/install", ({ databases }) =>
      databases.install(Reef, op.db),
    );
    await op.effect("org/register", async ({ env, principal }) => {
      const register = authFetch(env);
      if (register === undefined) return;
      const name =
        typeof principal.name === "string" && principal.name.length > 0
          ? principal.name
          : op.db;
      try {
        await register("https://auth/api/auth/organization/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, slug: op.db }),
        });
      } catch (cause) {
        throw new Ramose.InternalError({
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
    // docs:seed-labels
    for (const seed of SEED_LABELS) {
      op.put(Label, { name: seed.name, color: seed.color });
    }
    // enddocs:seed-labels
    return { ready: true };
  },
);

// docs:provision-workspace
export const provisionWorkspace = (db: ReefDb) =>
  db.run(provisionWorkspaceOp, {}).then(() => undefined);
// enddocs:provision-workspace

export const moveIssueOp = Op(
  "issue/move",
  {
    on: Issue,
    input: Schema.Struct({ status: StatusSchema, rank: Schema.Number }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    op.set(op.self, Issue.status, input.status);
    op.set(op.self, Issue.rank, input.rank);
    return {};
  },
);

export const setStatusOp = Op(
  "issue/set-status",
  {
    on: Issue,
    input: Schema.Struct({ status: StatusSchema }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    op.set(op.self, Issue.status, input.status);
    return {};
  },
);

export const addCommentOp = Op(
  "issue/add-comment",
  {
    on: Issue,
    input: Schema.Struct({ body: Schema.String, authorId: Schema.Number }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    const comment = op.entity();
    comment.set(Comment.body, input.body);
    comment.set(Comment.at, new Date());
    comment.set(Comment.author, input.authorId);
    comment.set(Comment.issue, op.self.eid);
    return {};
  },
);

export const deleteIssueOp = Op(
  "issue/delete",
  {
    on: Issue,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.delete(op.self);
    return {};
  },
);

export const createIssueOp = Op(
  "issue/create",
  {
    input: Schema.Struct({
      title: Schema.String,
      description: Schema.optional(Schema.String),
      status: StatusSchema,
      priority: Schema.Number,
      rank: Schema.Number,
      creatorId: Schema.Number,
      assigneeId: Schema.optional(Schema.Number),
      labelIds: Schema.optional(Schema.Array(Schema.Number)),
    }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    // docs:create-issue-put
    op.put(Issue, {
      title: input.title,
      description:
        input.description != null && input.description !== ""
          ? input.description
          : undefined,
      status: input.status,
      priority: input.priority,
      rank: input.rank,
      createdAt: new Date(),
      creator: input.creatorId,
      assignee: input.assigneeId,
      labels: input.labelIds ?? [],
    });
    // enddocs:create-issue-put
    return {};
  },
);

export const setTitleOp = Op(
  "issue/set-title",
  {
    on: Issue,
    input: Schema.Struct({ title: Schema.String }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    op.set(op.self, Issue.title, input.title);
    return {};
  },
);

export const setDescriptionOp = Op(
  "issue/set-description",
  {
    on: Issue,
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    if (input.text === "") op.remove(op.self, Issue.description);
    else op.set(op.self, Issue.description, input.text);
    return {};
  },
);

export const setPriorityOp = Op(
  "issue/set-priority",
  {
    on: Issue,
    input: Schema.Struct({ priority: Schema.Number }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    op.set(op.self, Issue.priority, input.priority);
    return {};
  },
);

export const setAssigneeOp = Op(
  "issue/set-assignee",
  {
    on: Issue,
    input: Schema.Struct({ assigneeId: Schema.optional(Schema.Number) }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    if (input.assigneeId == null) op.remove(op.self, Issue.assignee);
    else op.set(op.self, Issue.assignee, input.assigneeId);
    return {};
  },
);

export const toggleLabelOp = Op(
  "issue/toggle-label",
  {
    on: Issue,
    input: Schema.Struct({ labelId: Schema.Number, on: Schema.Boolean }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    if (input.on) op.set(op.self, Issue.labels, input.labelId);
    else op.remove(op.self, Issue.labels, input.labelId);
    return {};
  },
);

export const setPrivateNoteOp = Op(
  "issue/set-private-note",
  {
    on: Issue,
    input: Schema.Struct({ note: Schema.String }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    if (input.note === "") op.remove(op.self, Issue.privateNote);
    else op.set(op.self, Issue.privateNote, input.note);
    return {};
  },
);

export const deleteCommentOp = Op(
  "comment/delete",
  {
    on: Comment,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.delete(op.self);
    return {};
  },
);

export const seedSampleIssuesOp = Op(
  "workspace/seed-sample",
  {
    input: Schema.Struct({
      creatorId: Schema.Number,
      labels: Schema.Array(
        Schema.Struct({ id: Schema.Number, name: Schema.String }),
      ),
    }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    const labelIds = new Map(input.labels.map((l) => [l.name, l.id] as const));
    const nextRank: Partial<Record<Status, number>> = {};
    for (const sample of SAMPLE_ISSUES) {
      const rank = rankAfter(nextRank[sample.status]);
      nextRank[sample.status] = rank;
      op.put(Issue, {
        title: sample.title,
        description: sample.description,
        status: sample.status,
        priority: sample.priority,
        rank,
        createdAt: new Date(),
        creator: input.creatorId,
        assignee: sample.assign ? input.creatorId : undefined,
        labels: sample.labels.flatMap((name) => {
          const id = labelIds.get(name);
          return id === undefined ? [] : [id];
        }),
      });
    }
    return {};
  },
);

export const operations = Ramose.Operations({
  provisionWorkspaceOp,
  moveIssueOp,
  setStatusOp,
  addCommentOp,
  deleteIssueOp,
  createIssueOp,
  setTitleOp,
  setDescriptionOp,
  setPriorityOp,
  setAssigneeOp,
  toggleLabelOp,
  setPrivateNoteOp,
  deleteCommentOp,
  seedSampleIssuesOp,
});

export interface NewIssue {
  readonly title: string;
  readonly description?: string;
  readonly status: Status;
  readonly priority: number;
  readonly assigneeId?: number | undefined;
  readonly labelIds?: readonly number[];
}

/** `creator` is preset by the peer; writing it explicitly is the same datom. */
// docs:create-issue
export const createIssue = (
  db: ReefDb,
  myEid: number,
  lastRankInColumn: number | undefined,
  draft: NewIssue,
) =>
  db.run(createIssueOp, {
    title: draft.title,
    ...(draft.description != null && draft.description !== ""
      ? { description: draft.description }
      : {}),
    status: draft.status,
    priority: draft.priority,
    rank: rankAfter(lastRankInColumn),
    creatorId: myEid,
    ...(draft.assigneeId != null ? { assigneeId: draft.assigneeId } : {}),
    ...(draft.labelIds !== undefined ? { labelIds: draft.labelIds } : {}),
  });
// enddocs:create-issue

/** Drag-and-drop: one status datom + one rank datom. */
// docs:move-issue
export const moveIssue = (
  db: ReefDb,
  issueId: number,
  status: Status,
  rank: number,
) => db.run(moveIssueOp, issueId, { status, rank });
// enddocs:move-issue

/** Status change from the detail panel — keeps the rank (column position). */
export const setStatus = (db: ReefDb, issueId: number, status: Status) =>
  db.run(setStatusOp, issueId, { status });

export const setTitle = (db: ReefDb, issueId: number, title: string) =>
  db.run(setTitleOp, issueId, { title });

// docs:set-description
export const setDescription = (db: ReefDb, issueId: number, text: string) =>
  db.run(setDescriptionOp, issueId, { text });
// enddocs:set-description

export const setPriority = (db: ReefDb, issueId: number, priority: number) =>
  db.run(setPriorityOp, issueId, { priority });

export const setAssignee = (
  db: ReefDb,
  issueId: number,
  assigneeId: number | undefined,
) => db.run(setAssigneeOp, issueId, { assigneeId });

// docs:toggle-label
export const toggleLabel = (
  db: ReefDb,
  issueId: number,
  labelId: number,
  on: boolean,
) => db.run(toggleLabelOp, issueId, { labelId, on });
// enddocs:toggle-label

/** Admin-only by policy: everyone else gets `Unauthorized` from the peer. */
export const setPrivateNote = (db: ReefDb, issueId: number, note: string) =>
  db.run(setPrivateNoteOp, issueId, { note });

// docs:delete-issue
export const deleteIssue = (db: ReefDb, issueId: number) =>
  db.run(deleteIssueOp, issueId, {});
// enddocs:delete-issue

export const addComment = (
  db: ReefDb,
  myEid: number,
  issueId: number,
  body: string,
) => db.run(addCommentOp, issueId, { body, authorId: myEid });

export const deleteComment = (db: ReefDb, commentId: number) =>
  db.run(deleteCommentOp, commentId, {});

// ── sample data ──────────────────────────────────────────────────────────────

/** A realistic starter board, for the empty state. Label names map to ids. */
const SAMPLE_ISSUES: readonly {
  title: string;
  status: Status;
  priority: number;
  labels: readonly string[];
  description?: string;
  assign?: boolean;
}[] = [
  {
    title: "Live board flickers when two tabs move the same card",
    status: "doing",
    priority: 4,
    labels: ["bug"],
    assign: true,
    description:
      "Repro: open the board twice, drag one card in each tab within a second.",
  },
  {
    title: "Add keyboard shortcuts for moving issues between columns",
    status: "todo",
    priority: 2,
    labels: ["feature"],
  },
  {
    title: "Design pass on the issue detail panel",
    status: "doing",
    priority: 3,
    labels: ["design"],
    assign: true,
  },
  {
    title: "Rotate the JWKS signing key on a schedule",
    status: "backlog",
    priority: 3,
    labels: ["infra"],
  },
  {
    title: "Empty-state illustration for new workspaces",
    status: "backlog",
    priority: 1,
    labels: ["design", "feature"],
  },
  {
    title: "Time-travel slider should snap to transaction boundaries",
    status: "todo",
    priority: 2,
    labels: ["feature", "bug"],
    assign: true,
  },
  {
    title: "Show who is online in the workspace header",
    status: "backlog",
    priority: 0,
    labels: ["feature"],
  },
  {
    title: "Ship the peer to three regions",
    status: "done",
    priority: 3,
    labels: ["infra"],
    assign: true,
  },
  {
    title: "Per-datom policy for issue.privateNote",
    status: "done",
    priority: 2,
    labels: ["infra", "feature"],
  },
];

/**
 * Seed the sample board in one operation. Ranks are spaced by column so
 * later drags have room in between; issues are created by (and, when marked,
 * assigned to) the caller.
 */
export const seedSampleIssues = (
  db: ReefDb,
  myEid: number,
  labels: readonly { id: number; name: string }[],
) => db.run(seedSampleIssuesOp, { creatorId: myEid, labels });
