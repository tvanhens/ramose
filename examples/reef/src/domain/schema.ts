/**
 * Reef — the catalog one workspace runs on.
 *
 * Every workspace is its own Ramose database (`ramose.db(slug, Reef)`), so
 * this catalog is installed once per workspace at creation time, from the
 * browser, under the creator's admin-class JWT. Refs are targeted
 * (`Ramose.Ref(User)`) so navigational queries can join through them
 * (`Issue.assignee.name`).
 */

import * as Ramose from "ramose/db";

/** One row per human who has entered the workspace. `sub` is the JWT subject. */
// docs:user-entity
export const User = Ramose.Entity("user", {
  sub: Ramose.string({
    unique: "upsert",
    doc: "Better Auth user id — the JWT `sub`; the policy resolves principals through it",
  }),
  role: Ramose.string({
    doc: "Policy class, materialized by the peer from the JWT at session establishment",
  }),
  name: Ramose.string({
    doc: "Display name, stamped by the peer from ramose.attrs.name",
  }),
  email: Ramose.string({
    doc: "Email, stamped by the peer from ramose.attrs.email",
  }),
});
// enddocs:user-entity

// docs:label-entity
export const Label = Ramose.Entity("label", {
  name: Ramose.string({ unique: "upsert" }),
  color: Ramose.string(),
});
// enddocs:label-entity

export const STATUSES = ["backlog", "todo", "doing", "done"] as const;
export type Status = (typeof STATUSES)[number];

// docs:issue-entity
export const Issue = Ramose.Entity("issue", {
  title: Ramose.string(),
  description: Ramose.string(),
  status: Ramose.Enum(STATUSES),
  /** 0 none · 1 low · 2 medium · 3 high · 4 urgent. */
  priority: Ramose.int(),
  /** Fractional order inside a column; drag-and-drop writes midpoints. */
  rank: Ramose.float(),
  createdAt: Ramose.timestamp(),
  creator: Ramose.Ref(User),
  assignee: Ramose.Ref(User),
  labels: Ramose.Field.many(Ramose.Ref(Label)),
  /** Admin-only field — the policy narrows its `read` (see policy.ts). */
  privateNote: Ramose.string({
    doc: "visible to the admin class only",
  }),
});
// enddocs:issue-entity

export const Comment = Ramose.Entity("comment", {
  body: Ramose.string(),
  at: Ramose.timestamp(),
  author: Ramose.Ref(User),
  issue: Ramose.Ref(Issue),
});

export const Reef = Ramose.Schema({
  user: User,
  label: Label,
  issue: Issue,
  comment: Comment,
});

export type Reef = typeof Reef;

// ── shared vocabulary ────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  doing: "In Progress",
  done: "Done",
};

export const PRIORITIES = ["No priority", "Low", "Medium", "High", "Urgent"] as const;
