/**
 * Reef — the catalog one workspace runs on.
 *
 * Every workspace is its own Ramose database (`ramose.db(slug, Reef)`), so
 * this catalog is installed once per workspace at creation time, from the
 * browser, under the creator's admin-class JWT. Refs are targeted
 * (`Ramose.Ref(() => User)`) so navigational queries can join through them
 * (`Issue.assignee.name`).
 */

import * as Ramose from "ramose/db";
import * as Schema from "effect/Schema";

/** One row per human who has entered the workspace. `sub` is the JWT subject. */
export const User = Ramose.Entity("user", {
  sub: Ramose.Field(Schema.String, {
    unique: "upsert",
    doc: "Better Auth user id — the JWT `sub`; the policy resolves principals through it",
  }),
  role: Ramose.Field(Schema.String, {
    doc: "Policy class, materialized by the peer from the JWT at session establishment",
  }),
  name: Ramose.Field(Schema.String, {
    doc: "Display name, stamped by the peer from ramose.attrs.name",
  }),
  email: Ramose.Field(Schema.String, {
    doc: "Email, stamped by the peer from ramose.attrs.email",
  }),
});

export const Label = Ramose.Entity("label", {
  name: Ramose.Field(Schema.String, { unique: "upsert" }),
  color: Ramose.Field(Schema.String),
});

export const Issue = Ramose.Entity("issue", {
  title: Ramose.Field(Schema.String),
  description: Ramose.Field(Schema.String),
  /** One of {@link STATUSES}. */
  status: Ramose.Field(Schema.String),
  /** 0 none · 1 low · 2 medium · 3 high · 4 urgent. */
  priority: Ramose.Field(Ramose.Long),
  /** Fractional order inside a column; drag-and-drop writes midpoints. */
  rank: Ramose.Field(Schema.Number),
  createdAt: Ramose.Field(Ramose.Instant),
  creator: Ramose.Field(Ramose.Ref(() => User)),
  assignee: Ramose.Field(Ramose.Ref(() => User)),
  labels: Ramose.Field(Ramose.Ref(() => Label), { cardinality: "many" }),
  /** Admin-only field — the policy narrows its `read` (see policy.ts). */
  privateNote: Ramose.Field(Schema.String, {
    doc: "visible to the admin class only",
  }),
});

export const Comment = Ramose.Entity("comment", {
  body: Ramose.Field(Schema.String),
  at: Ramose.Field(Ramose.Instant),
  author: Ramose.Field(Ramose.Ref(() => User)),
  issue: Ramose.Field(Ramose.Ref(() => Issue)),
});

export const Reef = Ramose.Schema({
  user: User,
  label: Label,
  issue: Issue,
  comment: Comment,
});

export type Reef = typeof Reef;

// ── shared vocabulary ────────────────────────────────────────────────────────

export const STATUSES = ["backlog", "todo", "doing", "done"] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  doing: "In Progress",
  done: "Done",
};

export const PRIORITIES = ["No priority", "Low", "Medium", "High", "Urgent"] as const;
