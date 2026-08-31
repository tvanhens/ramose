// docs:graph-catalog
import * as EffectSchema from "effect/Schema";
import {
  Entity,
  EntityId,
  Field,
  Graph,
  Schema,
  string,
} from "ramose/db";

export const ROOT_DATABASE = "example-graph";

let graphSchema!: Schema.Any;

export const Issue = Entity("issue", {
  title: string(),
  status: string(),
}, {
  operations: (Operation) => ({
    createIssue: Operation({
      self: false,
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      allocates: { issue: ["id"] },
      optimistic: ({ input, tx }) => {
        const issue = tx.create("issue", Issue);
        tx.set(issue, Issue.title, input.title);
        tx.set(issue, Issue.status, "open");
      },
      run(op, input) {
        return { id: op.create({ title: input.title, status: "open" }) };
      },
    }),
    rename: Operation({
      input: EffectSchema.Struct({ title: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      optimistic: ({ input, self, tx }) => {
        if (self !== undefined) tx.set(self, Issue.title, input.title);
      },
      run(op, input) {
        op.self.set(Issue.title, input.title);
        return { id: op.self };
      },
    }),
    close: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({ id: EntityId }),
      optimistic: ({ self, tx }) => {
        if (self !== undefined) tx.set(self, Issue.status, "closed");
      },
      run(op) {
        op.self.set(Issue.status, "closed");
        return { id: op.self };
      },
    }),
  }),
});

export const Board = Entity("board", {
  slug: Field.unique(string(), "strict"),
}, {
  traits: [Graph(() => graphSchema)],
  operations: (Operation) => ({
    createBoard: Operation({
      self: false,
      input: EffectSchema.Struct({
        slug: EffectSchema.String,
        name: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      allocates: { board: ["id"] },
      run(op, input) {
        return { id: op.create({ slug: input.slug, name: input.name }) };
      },
    }),
    renameBoard: Operation({
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.set(Graph.name, input.name);
        return { id: op.self };
      },
    }),
  }),
});

export const Organization = Entity("organization", {
  slug: Field.unique(string(), "strict"),
}, {
  traits: [Graph(() => graphSchema)],
  operations: (Operation) => ({
    createOrganization: Operation({
      self: false,
      input: EffectSchema.Struct({
        slug: EffectSchema.String,
        name: EffectSchema.String,
      }),
      output: EffectSchema.Struct({ id: EntityId }),
      allocates: { organization: ["id"] },
      run(op, input) {
        return { id: op.create({ slug: input.slug, name: input.name }) };
      },
    }),
    renameOrganization: Operation({
      input: EffectSchema.Struct({ name: EffectSchema.String }),
      output: EffectSchema.Struct({ id: EntityId }),
      run(op, input) {
        op.self.set(Graph.name, input.name);
        return { id: op.self };
      },
    }),
  }),
});

export const AppSchema = Schema("example-graph", {
  organization: Organization,
  board: Board,
  issue: Issue,
});

graphSchema = AppSchema;

AppSchema.applyPolicy(
  { roles: ["member"] },
  ({ policy, session }) => {
    const member = session.hasRole("member");
    policy.organization.read.where(member);
    policy.board.read.where(member);
    policy.issue.read.where(member);
    policy.graph.read.where(member);
    policy.graph.fields.catalog.read.denyWhere(member);
    policy.organization.operations.createOrganization.where(member);
    policy.organization.operations.renameOrganization.where(member);
    policy.board.operations.createBoard.where(member);
    policy.board.operations.renameBoard.where(member);
    policy.issue.operations.createIssue.where(member);
    policy.issue.operations.rename.where(member);
    policy.issue.operations.close.where(member);
  },
);

export const deployment = Object.freeze({
  root: AppSchema,
  deployments: [{ database: ROOT_DATABASE }],
});
// enddocs:graph-catalog
