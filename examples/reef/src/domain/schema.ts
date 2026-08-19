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
export const User = Ramose.Namespace("user", {
  sub: Ramose.Attr(Schema.String, {
    unique: "identity",
    doc: "Better Auth user id — the JWT `sub`; the policy resolves principals through it",
  }),
  name: Ramose.Attr(Schema.String),
  email: Ramose.Attr(Schema.String),
});

export const Label = Ramose.Namespace("label", {
  name: Ramose.Attr(Schema.String, { unique: "identity" }),
  color: Ramose.Attr(Schema.String),
});

export const Issue = Ramose.Namespace("issue", {
  title: Ramose.Attr(Schema.String),
  description: Ramose.Attr(Schema.String),
  /** One of {@link STATUSES}. */
  status: Ramose.Attr(Schema.String),
  /** 0 none · 1 low · 2 medium · 3 high · 4 urgent. */
  priority: Ramose.Attr(Ramose.Long),
  /** Fractional order inside a column; drag-and-drop writes midpoints. */
  rank: Ramose.Attr(Schema.Number),
  createdAt: Ramose.Attr(Ramose.Instant),
  creator: Ramose.Attr(Ramose.Ref(() => User)),
  assignee: Ramose.Attr(Ramose.Ref(() => User)),
  labels: Ramose.Attr(Ramose.Ref(() => Label), { cardinality: "many" }),
  /** Admin-only field — the policy narrows its `read` (see policy.ts). */
  privateNote: Ramose.Attr(Schema.String, {
    doc: "visible to the admin class only",
  }),
});

export const Comment = Ramose.Namespace("comment", {
  body: Ramose.Attr(Schema.String),
  at: Ramose.Attr(Ramose.Instant),
  author: Ramose.Attr(Ramose.Ref(() => User)),
  issue: Ramose.Attr(Ramose.Ref(() => Issue)),
});

export const Reef = Ramose.Catalog({
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
