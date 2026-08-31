import * as EffectSchema from "effect/Schema";
import { Catalog } from "../../src/Catalog.ts";
import {
  Entity,
  Field,
  Graph,
  Schema,
  Trait,
  string,
  type CodeDefinition,
  type Equal,
  type Expect,
} from "../../src/db/internal.ts";
import { EntityId } from "../../src/db/Operation.ts";
import type { MutationRef } from "../../src/db/refs.ts";
import { compileReadAuthorization } from "../../src/internal/authorization/index.ts";
import { createClient } from "../../src/client/index.ts";
import type {
  ClientDatabase,
  DatabaseMutations,
  EntityHandle,
  MutationNamespace,
  Receipt,
} from "../../src/client/index.ts";
import { useDb, useQuery } from "../../src/react/index.ts";

const Child = { key: "child", schema: Schema({}) } satisfies CodeDefinition;

/** Not a literal, so which namespace installs the operation is decided later. */
declare const computedPlacement: boolean;

const Archivable = Trait("archivable", { archivedAt: string({ optional: true }) }, {
  operations: (Operation) => ({
    archive: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});

const Person = Entity("person", { name: string() });

const Issue = Entity("issue", {
  title: Field.unique(string(), "strict"),
  status: string(),
}, {
  traits: [Archivable],
  operations: (Operation) => ({
    createIssue: Operation({
      self: false,
      input: EffectSchema.Struct({
        title: EffectSchema.String,
        author: EntityId,
        watchers: EffectSchema.Array(EntityId),
        parent: EffectSchema.optionalKey(EntityId),
        origin: EffectSchema.Struct({ board: EntityId }),
      }),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
    setStatus: Operation({
      input: EffectSchema.Struct({ status: EffectSchema.String }),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
    close: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
    touch: Operation({
      self: computedPlacement,
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});

const Note = Entity("note", {
  body: string(),
}, {
  traits: [Archivable],
  operations: (Operation) => ({
    pin: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});

const Organization = Entity("organization", {
  slug: Field.unique(string(), "strict"),
}, { traits: [Graph(Child)] });

const AppSchema = Schema({
  person: Person,
  issue: Issue,
  note: Note,
  organization: Organization,
});

const AppCatalog = Catalog("typed-mutations", {
  schema: AppSchema,
  policy: compileReadAuthorization({ schema: AppSchema, rules: [] }),
});

const client = createClient({
  url: "https://data.example.com",
  root: "app",
  catalog: AppCatalog,
  auth: () => ({ token: "bearer", cacheKey: "account" }),
});

const db = client.open();

/**
 * `db.mutate` carries exactly the targetless operations the catalog declares,
 * plus any whose placement is computed and so could be installed here.
 */
export type _databaseNames = Expect<
  Equal<keyof typeof db.mutate, "createIssue" | "touch">
>;

declare const author: MutationRef<typeof Person>;
declare const board: MutationRef;

export const _createIssue: Receipt = db.mutate.createIssue({
  title: "Offline",
  author,
  watchers: [author],
  origin: { board },
});

/** A declared entity-reference position accepts the opaque handle, at any depth. */
export type _refInput = Expect<
  Equal<Parameters<typeof db.mutate.createIssue>[0]["author"], MutationRef>
>;
export type _refArrayInput = Expect<
  Equal<
    Parameters<typeof db.mutate.createIssue>[0]["watchers"],
    readonly MutationRef[]
  >
>;
export type _refNestedInput = Expect<
  Equal<
    Parameters<typeof db.mutate.createIssue>[0]["origin"],
    { readonly board: MutationRef }
  >
>;
export type _optionalRefInput = Expect<
  Equal<
    Parameters<typeof db.mutate.createIssue>[0]["parent"],
    MutationRef | undefined
  >
>;

// @ts-expect-error — an operation the catalog does not declare
db.mutate.misspelled({ title: "Offline" });

// @ts-expect-error — a field the input schema does not declare
db.mutate.createIssue({ title: "Offline", author, watchers: [], origin: { board }, rank: 1 });

// @ts-expect-error — the wrong type at a declared position
db.mutate.createIssue({ title: 7, author, watchers: [], origin: { board } });

// @ts-expect-error — a numeric eid is never public
db.mutate.createIssue({ title: "Offline", author: 42, watchers: [], origin: { board } });

// @ts-expect-error — a targeted operation is not a database operation
db.mutate.setStatus({ status: "open" });

const issue = db.observe(db.query.from(Issue)).getSnapshot().data![0]!;

/** `entity.mutate` carries the entity's own operations and its traits'. */
export type _entityNames = Expect<
  Equal<keyof typeof issue.mutate, "setStatus" | "close" | "touch" | "archive">
>;

export const _setStatus: Receipt = issue.mutate.setStatus({ status: "closed" });

/** An operation whose whole input is optional needs no argument. */
export const _close: Receipt = issue.mutate.close();
export const _archive: Receipt = issue.mutate.archive();

// @ts-expect-error — an operation this focus does not reach
issue.mutate.createIssue({ title: "Offline" });

// @ts-expect-error — the wrong type at a declared position
issue.mutate.setStatus({ status: 7 });

/** `.data` stays the row, and `.local` stays the sidecar. */
export type _entityData = Expect<
  Equal<typeof issue.data.title, string>
>;

/**
 * A child database is bound to a catalog these types do not name, so its
 * operations stay the runtime namespace.
 */
const childDb = db.query.from(Organization).where({ slug: "acme" }).one().db();
export type _childNamespace = Expect<
  Equal<typeof childDb.mutate, MutationNamespace>
>;
export const _childCall: Receipt = childDb.mutate.anything({ whatever: true });

/** The loose spellings remain supertypes of the derived ones. */
export const _looseDatabase: ClientDatabase = db;
export const _looseHandle: EntityHandle = issue;

type Answered<State> = State extends { readonly status: "ready"; readonly data: infer A }
  ? A
  : never;

/** The React adapter keeps the focus, so a rendered row is a live handle. */
const renderedIssues = useQuery(db.query.from(Issue), db);
declare const rendered: Answered<typeof renderedIssues>[number];
export const _renderedSetStatus: Receipt = rendered.mutate.setStatus({
  status: "closed",
});

// @ts-expect-error — an operation this focus does not reach
rendered.mutate.createIssue({ title: "Offline" });

/**
 * A trait focus reaches only its own operations, as `selfOperationsFor` does:
 * a polymorphic read over a trait says nothing about which composers answer it.
 */
const archivable = db.observe(db.query.from(Archivable)).getSnapshot().data![0]!;
export type _traitFocusNames = Expect<
  Equal<keyof typeof archivable.mutate, "archive">
>;

// @ts-expect-error — an operation the composing entity declares, not this trait
archivable.mutate.setStatus({ status: "closed" });

/** The React root database answers the namespace its catalog is named with. */
const typedRoot = useDb<DatabaseMutations<typeof AppSchema>>();
export const _typedRootCall: Receipt = typedRoot.mutate.createIssue({
  title: "Offline",
  author,
  watchers: [],
  origin: { board },
});

// @ts-expect-error — an operation the catalog does not declare
typedRoot.mutate.misspelled({});

/**
 * A focus chosen at runtime is several alternatives, and each handle carries
 * only the one that was chosen: what stays callable is what both answer.
 */
declare const chooseIssue: boolean;
const either = db
  .observe(db.query.from(chooseIssue ? Issue : Note))
  .getSnapshot().data![0]!;
export const _sharedAcrossFocuses: Receipt = either.mutate.archive();

// @ts-expect-error — only one of the two alternatives declares this
either.mutate.setStatus({ status: "closed" });

// @ts-expect-error — and only the other one declares this
either.mutate.pin({});

/**
 * An operation whose placement is computed is reachable from both namespaces
 * rather than from neither, under the method type of an unknown input.
 */
export const _computedPlacementOnDatabase: Receipt = db.mutate.touch({});
export const _computedPlacementOnEntity: Receipt = issue.mutate.touch({});

/** A provider-backed database with no named catalog stays the runtime namespace. */
const looseRoot = useDb();
export type _looseRoot = Expect<
  Equal<typeof looseRoot.mutate, MutationNamespace>
>;

/** A projection has no focus, so it stays plain data. */
const renderedTitles = useQuery(
  db.query.from(Issue).select({ title: Issue.title }),
  db,
);
declare const projected: Answered<typeof renderedTitles>[number];
export type _projectedRow = Expect<Equal<typeof projected.title, string>>;
