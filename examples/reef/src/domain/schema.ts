// docs:reef-catalog
import * as EffectSchema from "effect/Schema";
import {
  Entity,
  EntityId,
  Enum,
  Field,
  Graph,
  Ref,
  Schema,
  float,
  string,
  timestamp,
  type ValueOf,
} from "ramose/db";
import { RANK_GAP } from "./rank.ts";

export const ROOT_DATABASE = "reef";

let reefSchema!: Schema.Any;

// docs:person-entity
export const Person = Entity("person", {
  sub: Field.unique(string(), "upsert"),
  name: string({ optional: true }),
  email: string({ optional: true }),
});
// enddocs:person-entity

/** The caller's upsertable person attributes, from the verified JWT. */
export const callerAttrs = (principal: {
  readonly sub?: string;
  readonly claims: Readonly<Record<string, unknown>>;
}): { readonly sub: string; readonly name?: string; readonly email?: string } => {
  const name = principal.claims.name;
  const email = principal.claims.email;
  return {
    sub: principal.sub ?? "",
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof email === "string" ? { email } : {}),
  };
};

// docs:workspace-entity
export const Workspace = Entity("workspace", {
  slug: Field.unique(string(), "strict"),
  members: Field.many(Ref(Person)),
}, {
  traits: [Graph(() => reefSchema)],
  operations: (Operation) => ({
    ensureMe: Operation({
      self: false,
      writes: [Person],
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op) {
        return { id: op.put(Person, callerAttrs(op.principal)) };
      },
    }),
    createWorkspace: Operation({
      self: false,
      writes: [Person],
      input: EffectSchema.Struct({
        slug: EffectSchema.String,
        name: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      allocates: { workspace: ["id"] },
      run(op, input) {
        const creator = op.put(Person, callerAttrs(op.principal));
        const workspace = op.create({
          slug: input.slug,
          name: input.name,
          members: [creator],
        });
        return { id: workspace };
      },
    }),
    renameWorkspace: Operation({
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.set(Graph.name, input.name);
        return { id: op.self };
      },
    }),
    addMember: Operation({
      input: EffectSchema.Struct({ person: EntityId }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.set(Workspace.members, input.person);
        return { id: op.self };
      },
    }),
    removeMember: Operation({
      input: EffectSchema.Struct({ person: EntityId }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.remove(Workspace.members, input.person);
        return { id: op.self };
      },
    }),
  }),
});
// enddocs:workspace-entity

export const Label = Entity("label", {
  name: Field.unique(string(), "upsert"),
  color: string(),
}, {
  operations: (Operation) => ({
    createLabel: Operation({
      self: false,
      input: EffectSchema.Struct({
        name: EffectSchema.String,
        color: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      allocates: { label: ["id"] },
      optimistic: ({ input, tx }) => {
        const label = tx.create("label", Label);
        tx.set(label, Label.name, input.name);
        tx.set(label, Label.color, input.color);
      },
      run(op, input) {
        return { id: op.create({ name: input.name, color: input.color }) };
      },
    }),
  }),
});

export const STATUSES = ["backlog", "todo", "doing", "done"] as const;
export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

// docs:issue-entity
export const Issue = Entity("issue", {
  title: string(),
  description: string({ optional: true }),
  status: Enum(STATUSES),
  priority: Enum(PRIORITIES),
  rank: float(),
  createdAt: timestamp(),
  creator: Ref(Person, { optional: true }),
  assignee: Ref(Person, { optional: true }),
  labels: Field.many(Ref(Label)),
  privateNote: string({ optional: true }),
}, {
  operations: (Operation) => ({
    createIssue: Operation({
      self: false,
      writes: [Person],
      input: EffectSchema.Struct({
        title: EffectSchema.String,
        status: EffectSchema.Literals(STATUSES),
        rank: EffectSchema.Finite,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      allocates: { issue: ["id"] },
      optimistic: ({ input, tx }) => {
        const issue = tx.create("issue", Issue);
        tx.set(issue, Issue.title, input.title);
        tx.set(issue, Issue.status, input.status);
        tx.set(issue, Issue.priority, "none");
        tx.set(issue, Issue.rank, input.rank);
        tx.set(issue, Issue.createdAt, new Date());
      },
      run(op, input) {
        const creator = op.put(Person, callerAttrs(op.principal));
        const issue = op.create({
          title: input.title,
          status: input.status,
          priority: "none",
          rank: input.rank,
          createdAt: new Date(),
          creator,
        });
        return { id: issue };
      },
    }),
    editIssue: Operation({
      input: EffectSchema.Struct({
        title: EffectSchema.optionalKey(EffectSchema.String),
        description: EffectSchema.optionalKey(EffectSchema.String),
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      optimistic: ({ input, self, tx }) => {
        if (self === undefined) return;
        if (input.title !== undefined) tx.set(self, Issue.title, input.title);
        if (input.description !== undefined) {
          tx.set(self, Issue.description, input.description);
        }
      },
      run(op, input) {
        if (input.title !== undefined) op.self.set(Issue.title, input.title);
        if (input.description !== undefined) {
          op.self.set(Issue.description, input.description);
        }
        return { id: op.self };
      },
    }),
    moveIssue: Operation({
      input: EffectSchema.Struct({
        status: EffectSchema.Literals(STATUSES),
        rank: EffectSchema.Finite,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      optimistic: ({ input, self, tx }) => {
        if (self === undefined) return;
        tx.set(self, Issue.status, input.status);
        tx.set(self, Issue.rank, input.rank);
      },
      run(op, input) {
        op.self.set(Issue.status, input.status);
        op.self.set(Issue.rank, input.rank);
        return { id: op.self };
      },
    }),
    setPriority: Operation({
      input: EffectSchema.Struct({ priority: EffectSchema.Literals(PRIORITIES) }),
      output: EffectSchema.Struct({ id: EntityId }),
      optimistic: ({ input, self, tx }) => {
        if (self !== undefined) tx.set(self, Issue.priority, input.priority);
      },
      run(op, input) {
        op.self.set(Issue.priority, input.priority);
        return { id: op.self };
      },
    }),
    setAssignee: Operation({
      input: EffectSchema.Struct({
        assignee: EffectSchema.optionalKey(EntityId),
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        if (input.assignee === undefined) op.self.remove(Issue.assignee);
        else op.self.set(Issue.assignee, input.assignee);
        return { id: op.self };
      },
    }),
    addLabel: Operation({
      input: EffectSchema.Struct({ label: EntityId }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.set(Issue.labels, input.label);
        return { id: op.self };
      },
    }),
    removeLabel: Operation({
      input: EffectSchema.Struct({ label: EntityId }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.remove(Issue.labels, input.label);
        return { id: op.self };
      },
    }),
    setPrivateNote: Operation({
      input: EffectSchema.Struct({ note: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        if (input.note === "") op.self.remove(Issue.privateNote);
        else op.self.set(Issue.privateNote, input.note);
        return { id: op.self };
      },
    }),
    deleteIssue: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run(op) {
        op.self.delete();
        return {};
      },
    }),
  }),
});
// enddocs:issue-entity

export const Comment = Entity("comment", {
  body: string(),
  at: timestamp(),
  author: Ref(Person, { optional: true }),
  issue: Ref(Issue),
}, {
  operations: (Operation) => ({
    createComment: Operation({
      self: false,
      writes: [Person],
      input: EffectSchema.Struct({
        issue: EntityId,
        body: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      allocates: { comment: ["id"] },
      run(op, input) {
        const author = op.put(Person, callerAttrs(op.principal));
        const comment = op.create({
          issue: input.issue,
          body: input.body,
          at: new Date(),
          author,
        });
        return { id: comment };
      },
    }),
    deleteComment: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run(op) {
        op.self.delete();
        return {};
      },
    }),
  }),
});

export const Reef = Schema("reef", {
  person: Person,
  workspace: Workspace,
  label: Label,
  issue: Issue,
  comment: Comment,
});

reefSchema = Reef;

export type Reef = typeof Reef;

// docs:reef-policy
Reef.applyPolicy(
  {
    principal: Person.sub,
    roles: ["user"],
    claims: [
      {
        key: "name",
        optional: true,
        shape: { _tag: "scalar", valueType: "string" },
      },
      {
        key: "email",
        optional: true,
        shape: { _tag: "scalar", valueType: "string" },
      },
    ],
  },
  ({ policy, actor, session }) => {
    const signedIn = session.hasRole("user");

    policy.person.read.where(signedIn);

    policy.workspace.read.where((workspace) =>
      workspace.members.contains(actor)
    );
    policy.graph.read.where(signedIn);
    policy.graph.fields.catalog.read.denyWhere(signedIn);

    policy.label.read.where(signedIn);
    policy.issue.read.where(signedIn);
    policy.comment.read.where(signedIn);
    policy.issue.fields.privateNote.read.where((issue) =>
      issue.creator.eq(actor)
    );

    policy.workspace.operations.ensureMe.where(signedIn);
    policy.workspace.operations.createWorkspace.where(signedIn);
    policy.workspace.operations.renameWorkspace.where(signedIn);
    policy.workspace.operations.addMember.where(signedIn);
    policy.workspace.operations.removeMember.where(signedIn);
    policy.label.operations.createLabel.where(signedIn);
    policy.issue.operations.createIssue.where(signedIn);
    policy.issue.operations.editIssue.where(signedIn);
    policy.issue.operations.moveIssue.where(signedIn);
    policy.issue.operations.setPriority.where(signedIn);
    policy.issue.operations.setAssignee.where(signedIn);
    policy.issue.operations.addLabel.where(signedIn);
    policy.issue.operations.removeLabel.where(signedIn);
    policy.issue.operations.setPrivateNote.where(signedIn);
    policy.issue.operations.deleteIssue.where(signedIn);
    policy.comment.operations.createComment.where(signedIn);
    policy.comment.operations.deleteComment.where(signedIn);
  },
);
// enddocs:reef-policy

export const deployment = Object.freeze({
  root: Reef,
  deployments: [{ database: ROOT_DATABASE }],
});
// enddocs:reef-catalog

export type Status = ValueOf<typeof Issue.status>;
export type Priority = ValueOf<typeof Issue.priority>;

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

export const DEFAULT_RANK = RANK_GAP;
