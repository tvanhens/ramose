/**
 * Every write the app makes. Each is one `db.transact` generator — the
 * session overlay applies it locally, then the peer commits it or the
 * policy rejects it with `Unauthorized` / `TxRejected`. A denial drops
 * the pending layer; the UI surfaces the error as a toast (enforcement
 * is server-side; the buttons are merely polite).
 */

import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Schema from "effect/Schema";
import * as Ramose from "ramose/db";
import type { ReefDb } from "../domain/queries.ts";
import { rankAfter } from "../domain/rank.ts";
import { Comment, Issue, Label, Reef, User, type Status } from "../domain/schema.ts";

const { Query } = Ramose;

/** The caller's own `user` row, by the sub their JWT carries. */
const mineQuery = Query.q({ sub: User.sub }, (p) =>
  pipe(
    Query.entities(User),
    Query.is(User.sub, p.sub),
    Query.select({ id: User.id }),
  ),
);

/** The labels every new workspace starts with. */
export const SEED_LABELS: readonly { name: string; color: string }[] = [
  { name: "bug", color: "#ef5f6b" },
  { name: "feature", color: "#5b8cff" },
  { name: "design", color: "#b17aff" },
  { name: "infra", color: "#3fb970" },
];

const StatusSchema = Schema.Literals(["backlog", "todo", "doing", "done"]);

const Person = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
});

/**
 * Workspace provisioning: install + optional org registration as effects,
 * then seed the creator and labels as one transaction. Effects come first,
 * so there is no optimistic prefix — the creating tab has no session yet.
 */
export const provisionWorkspaceOp = Ramose.Operation(
  "workspace/provision",
  {
    input: Person,
    output: Schema.Struct({ ready: Schema.Boolean }),
  },
  (op, input) =>
    Effect.gen(function* () {
      yield* op.effect("db/install", ({ databases }) => databases.install(Reef, op.db));
      yield* op.effect("org/register", ({ env }) => {
        const register = (env as { AUTH?: { fetch?: typeof fetch } }).AUTH?.fetch;
        if (register === undefined) return Effect.void;
        return Effect.tryPromise({
          try: () =>
            register("https://auth/api/auth/organization/create", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: input.name, slug: op.db }),
            }),
          catch: (cause) =>
            ({
              _tag: "InternalError",
              message: cause instanceof Error ? cause.message : String(cause),
            }) as const,
        }).pipe(Effect.asVoid);
      });
      const user = yield* op.entity();
      yield* user.add(User.sub, input.id);
      yield* user.add(User.name, input.name);
      yield* user.add(User.email, input.email);
      for (const seed of SEED_LABELS) {
        const label = yield* op.entity();
        yield* label.add(Label.name, seed.name);
        yield* label.add(Label.color, seed.color);
      }
      return { ready: true };
    }),
);

export const provisionWorkspace = (
  db: ReefDb,
  me: { id: string; name: string; email: string },
) => db.run(provisionWorkspaceOp, me).pipe(Effect.asVoid);

export const moveIssueOp = Ramose.Operation(
  "issue/move",
  {
    on: Issue,
    input: Schema.Struct({ status: StatusSchema, rank: Schema.Number }),
    output: Schema.Struct({}),
  },
  (op, input) =>
    Effect.gen(function* () {
      yield* op.add(op.self, Issue.status, input.status as Status);
      yield* op.add(op.self, Issue.rank, input.rank);
      return {};
    }),
);

export const setStatusOp = Ramose.Operation(
  "issue/set-status",
  {
    on: Issue,
    input: Schema.Struct({ status: StatusSchema }),
    output: Schema.Struct({}),
  },
  (op, input) =>
    Effect.gen(function* () {
      yield* op.add(op.self, Issue.status, input.status as Status);
      return {};
    }),
);

export const addCommentOp = Ramose.Operation(
  "issue/add-comment",
  {
    on: Issue,
    input: Schema.Struct({ body: Schema.String, authorId: Schema.Number }),
    output: Schema.Struct({}),
  },
  (op, input) =>
    Effect.gen(function* () {
      const comment = yield* op.entity();
      yield* comment.add(Comment.body, input.body);
      yield* comment.add(Comment.at, new Date());
      yield* comment.add(Comment.author, input.authorId);
      yield* comment.add(Comment.issue, op.self);
      return {};
    }),
);

export const deleteIssueOp = Ramose.Operation(
  "issue/delete",
  {
    on: Issue,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) =>
    Effect.gen(function* () {
      yield* op.retractEntity(op.self);
      return {};
    }),
);

export const operations = Ramose.Operations({
  provisionWorkspaceOp,
  moveIssueOp,
  setStatusOp,
  addCommentOp,
  deleteIssueOp,
});

/**
 * First entry by a member: write your own `user` row if it is not there.
 * `:user/sub` is a preset attribute, so supplying your own sub is a no-op
 * check and supplying anyone else's is `Unauthorized`. Viewers skip the
 * write — they never need an entity (reads are class-scoped).
 *
 * Returns the caller's user eid, or `undefined` for a viewer who has none.
 */
export const ensureSelf = (
  db: ReefDb,
  me: { id: string; name: string; email: string },
  canWrite: boolean,
) =>
  Effect.gen(function* () {
    const existing = yield* db.q(mineQuery, { sub: me.id });
    if (existing.length > 0) return existing[0]!.id;
    if (!canWrite) return undefined;
    const report = yield* db.transact(function* (tx) {
      const user = yield* tx.entity();
      yield* user.add(User.sub, me.id);
      yield* user.add(User.name, me.name);
      yield* user.add(User.email, me.email);
    });
    const after = yield* report.dbAfter.q(mineQuery, { sub: me.id });
    return after[0]?.id;
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
export const createIssue = (
  db: ReefDb,
  myEid: number,
  lastRankInColumn: number | undefined,
  draft: NewIssue,
) =>
  db.transact(function* (tx) {
    const issue = yield* tx.entity();
    yield* issue.add(Issue.title, draft.title);
    if (draft.description !== undefined && draft.description !== "") {
      yield* issue.add(Issue.description, draft.description);
    }
    yield* issue.add(Issue.status, draft.status);
    yield* issue.add(Issue.priority, draft.priority);
    yield* issue.add(Issue.rank, rankAfter(lastRankInColumn));
    yield* issue.add(Issue.createdAt, new Date());
    yield* issue.add(Issue.creator, myEid);
    if (draft.assigneeId !== undefined) {
      yield* issue.add(Issue.assignee, draft.assigneeId);
    }
    for (const labelId of draft.labelIds ?? []) {
      yield* issue.add(Issue.labels, labelId);
    }
  });

/** Drag-and-drop: one status datom + one rank datom. */
export const moveIssue = (
  db: ReefDb,
  issueId: number,
  status: Status,
  rank: number,
) => db.run(moveIssueOp, issueId, { status, rank });

/** Status change from the detail panel — keeps the rank (column position). */
export const setStatus = (db: ReefDb, issueId: number, status: Status) =>
  db.run(setStatusOp, issueId, { status });

export const setTitle = (db: ReefDb, issueId: number, title: string) =>
  db.transact(function* (tx) {
    yield* tx.add(issueId, Issue.title, title);
  });

export const setDescription = (db: ReefDb, issueId: number, text: string) =>
  db.transact(function* (tx) {
    if (text === "") yield* tx.retract(issueId, Issue.description);
    else yield* tx.add(issueId, Issue.description, text);
  });

export const setPriority = (db: ReefDb, issueId: number, priority: number) =>
  db.transact(function* (tx) {
    yield* tx.add(issueId, Issue.priority, priority);
  });

export const setAssignee = (
  db: ReefDb,
  issueId: number,
  assigneeId: number | undefined,
) =>
  db.transact(function* (tx) {
    if (assigneeId === undefined) yield* tx.retract(issueId, Issue.assignee);
    else yield* tx.add(issueId, Issue.assignee, assigneeId);
  });

export const toggleLabel = (
  db: ReefDb,
  issueId: number,
  labelId: number,
  on: boolean,
) =>
  db.transact(function* (tx) {
    if (on) yield* tx.add(issueId, Issue.labels, labelId);
    else yield* tx.retract(issueId, Issue.labels, labelId);
  });

/** Admin-only by policy: everyone else gets `Unauthorized` from the peer. */
export const setPrivateNote = (db: ReefDb, issueId: number, note: string) =>
  db.transact(function* (tx) {
    if (note === "") yield* tx.retract(issueId, Issue.privateNote);
    else yield* tx.add(issueId, Issue.privateNote, note);
  });

export const deleteIssue = (db: ReefDb, issueId: number) =>
  db.run(deleteIssueOp, issueId, {});

export const addComment = (
  db: ReefDb,
  myEid: number,
  issueId: number,
  body: string,
) => db.run(addCommentOp, issueId, { body, authorId: myEid });

export const deleteComment = (db: ReefDb, commentId: number) =>
  db.transact(function* (tx) {
    yield* tx.retractEntity(commentId);
  });

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
 * Seed the sample board in one transaction. Ranks are spaced by column so
 * later drags have room in between; issues are created by (and, when marked,
 * assigned to) the caller.
 */
export const seedSampleIssues = (
  db: ReefDb,
  myEid: number,
  labels: readonly { id: number; name: string }[],
) =>
  db.transact(function* (tx) {
    const labelIds = new Map(labels.map((l) => [l.name, l.id] as const));
    const nextRank: Partial<Record<Status, number>> = {};
    for (const sample of SAMPLE_ISSUES) {
      const rank = rankAfter(nextRank[sample.status]);
      nextRank[sample.status] = rank;
      const issue = yield* tx.entity();
      yield* issue.add(Issue.title, sample.title);
      if (sample.description !== undefined) {
        yield* issue.add(Issue.description, sample.description);
      }
      yield* issue.add(Issue.status, sample.status);
      yield* issue.add(Issue.priority, sample.priority);
      yield* issue.add(Issue.rank, rank);
      yield* issue.add(Issue.createdAt, new Date());
      yield* issue.add(Issue.creator, myEid);
      if (sample.assign) yield* issue.add(Issue.assignee, myEid);
      for (const name of sample.labels) {
        const id = labelIds.get(name);
        if (id !== undefined) yield* issue.add(Issue.labels, id);
      }
    }
  });
