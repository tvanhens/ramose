// docs:graph-catalog
import * as EffectSchema from "effect/Schema";
import * as Effect from "effect/Effect";
import { Catalog, Policy } from "ramose/client";
import {
  Entity,
  EntityId,
  Field,
  Graph,
  OwnedOperations,
  Schema,
  string,
} from "ramose/db";

export const ROOT_DATABASE = "example-graph";

let appCatalog!: ReturnType<typeof Catalog>;

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
  traits: [Graph(() => appCatalog)],
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
  traits: [Graph(() => appCatalog)],
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

export const AppSchema = Schema({
  organization: Organization,
  board: Board,
  issue: Issue,
});

const member = Policy.hasClass("member");

appCatalog = Catalog("example-graph", {
  schema: AppSchema,
  policy: await Effect.runPromise(Policy.compileReadAuthorization({
    schema: AppSchema,
    classes: ["member"],
    rules: [
      Policy.read(Organization).when(member),
      Policy.read(Board).when(member),
      Policy.read(Issue).when(member),
      Policy.read(Graph).when(member),
      Policy.read(Graph.catalog).deny(member),
      Policy.invoke(Organization[OwnedOperations].createOrganization).when(member),
      Policy.invoke(Organization[OwnedOperations].renameOrganization).when(member),
      Policy.invoke(Board[OwnedOperations].createBoard).when(member),
      Policy.invoke(Board[OwnedOperations].renameBoard).when(member),
      Policy.invoke(Issue[OwnedOperations].createIssue).when(member),
      Policy.invoke(Issue[OwnedOperations].rename).when(member),
      Policy.invoke(Issue[OwnedOperations].close).when(member),
    ],
  })),
});

export const AppCatalog = appCatalog;

export const deployment = Object.freeze({
  root: AppCatalog,
  deployments: [{ database: ROOT_DATABASE }],
});
// enddocs:graph-catalog
