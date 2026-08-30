import * as Ramose from "ramose/db";

// docs:user-entity
export const User = Ramose.Entity("user", {
  sub: Ramose.Field.unique(Ramose.string(), "upsert", {
    doc: "Better Auth user id — the JWT `sub`; the policy resolves principals through it",
  }),
  role: Ramose.string({
    doc: "Policy class, materialized by the peer from the JWT at session establishment",
  }),
  name: Ramose.string({
    optional: true,
    doc: "Display name, stamped by the peer from ramose.attrs.name",
  }),
  email: Ramose.string({
    optional: true,
    doc: "Email, stamped by the peer from ramose.attrs.email",
  }),
});
// enddocs:user-entity

// docs:label-entity
export const Label = Ramose.Entity("label", {
  name: Ramose.Field.unique(Ramose.string(), "upsert"),
  color: Ramose.string(),
});
// enddocs:label-entity

// docs:issue-entity
export const Issue = Ramose.Entity("issue", {
  title: Ramose.string(),
  description: Ramose.string({ optional: true }),
  status: Ramose.Enum(["backlog", "todo", "doing", "done"]),
  priority: Ramose.Enum(["none", "low", "medium", "high", "urgent"]),

  rank: Ramose.float(),
  createdAt: Ramose.timestamp(),
  creator: Ramose.Ref(User),
  assignee: Ramose.Ref(User, { optional: true }),
  labels: Ramose.Field.many(Ramose.Ref(Label)),

  privateNote: Ramose.string({
    optional: true,
    doc: "visible to the owner class only",
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

export type Status = Ramose.ValueOf<typeof Issue.status>;
export type Priority = Ramose.ValueOf<typeof Issue.priority>;

export const STATUS_LABELS: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  doing: "In Progress",
  done: "Done",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};
