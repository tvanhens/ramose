/**
 * Compile-time pin: entity- and trait-owned operations (issue #317).
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused.
 */

import * as Schema from "effect/Schema";
import type { PolicyArms } from "../../src/db/Policy.ts";
import type {
  Db,
  Eid,
  Equal,
  Expect,
  Extends,
  OpReport,
} from "../../src/db/internal.ts";
import {
  Entity,
  EntityId,
  Field,
  Operation,
  Schema as DbSchema,
  Trait,
  string,
} from "../../src/db/internal.ts";

const Taggable = Trait(
  "taggable",
  { tags: Field.many(string()) },
  {
    operations: {
      addTag: Operation({
        input: Schema.Struct({ tag: Schema.String }),
        output: Schema.Struct({}),
        run(op, { tag }) {
          op.self.set(Taggable.tags, tag);
          return {};
        },
      }),
    },
  },
);

const Issue = Entity(
  "issue",
  { title: string() },
  {
    traits: [Taggable],
    operations: {
      create: Operation({
        self: false,
        input: Schema.Struct({ title: Schema.String }),
        output: Schema.Struct({ id: EntityId }),
        run(op, input) {
          return { id: op.create({ title: input.title }) };
        },
      }),
      rename: Operation({
        input: Schema.Struct({ title: Schema.String }),
        output: Schema.Struct({}),
        run(op, { title }) {
          op.self.set(Issue.title, title);
          return {};
        },
      }),
    },
  },
);

const Doc = Entity("doc", { body: string() }, { traits: [Taggable] });
const User = Entity("user", { name: string() });
const App = DbSchema({ issue: Issue, doc: Doc, user: User });
const Lonely = DbSchema({ user: User });

type _addTagName = Expect<
  Equal<(typeof Taggable.operations.addTag)["name"], "taggable/addTag">
>;
type _createName = Expect<
  Equal<(typeof Issue.operations.create)["name"], "issue/create">
>;
type _renameName = Expect<
  Equal<(typeof Issue.operations.rename)["name"], "issue/rename">
>;

type _createOn = Expect<
  Equal<(typeof Issue.operations.create)["on"], undefined>
>;
type _renameOn = Expect<
  Extends<typeof Issue, NonNullable<(typeof Issue.operations.rename)["on"]>>
>;
type _addTagOn = Expect<
  Extends<typeof Taggable, NonNullable<(typeof Taggable.operations.addTag)["on"]>>
>;

declare const db: Db<typeof App>;
declare const lonely: Db<typeof Lonely>;
declare const issueId: Eid<typeof Issue>;
declare const docId: Eid<typeof Doc>;
declare const userId: Eid<typeof User>;

const created = db.run(Issue.operations.create, { title: "Fix login" });
type _created = Expect<
  Equal<typeof created, Promise<OpReport<{ readonly id: number }, typeof App>>>
>;

const renamed = db.run(Issue.operations.rename, issueId, {
  title: "Fix auth",
});
type _renamed = Expect<
  Equal<typeof renamed, Promise<OpReport<{}, typeof App>>>
>;

db.run(Taggable.operations.addTag, issueId, { tag: "urgent" });
db.run(Taggable.operations.addTag, docId, { tag: "reviewed" });

// @ts-expect-error instance op needs a target
db.run(Issue.operations.rename, { title: "x" });
// @ts-expect-error self:false does not take a target
db.run(Issue.operations.create, issueId, { title: "x" });
// @ts-expect-error a user is not a Taggable composer
db.run(Taggable.operations.addTag, userId, { tag: "x" });
// @ts-expect-error a doc is not an issue
db.run(Issue.operations.rename, docId, { title: "x" });

// @ts-expect-error this catalog has no Taggable composer
lonely.run(Taggable.operations.addTag, userId, { tag: "x" });
lonely.run(Taggable.operations.addTag, 1001, { tag: "x" });
// @ts-expect-error create is bound to the issue catalog
lonely.run(Issue.operations.create, { title: "x" });

{
  const create = Issue.operations.create;
  type CreateOp = Parameters<(typeof create)["body"]>[0];
  type _noSelf = Expect<Equal<CreateOp["self"], undefined>>;
  type _hasCreate = Expect<Extends<CreateOp["create"], Function>>;
  type CreateAttrs = Parameters<NonNullable<CreateOp["create"]>>[0];
  type _titleKey = Expect<Extends<"title", keyof CreateAttrs>>;
  const _validCreate: CreateAttrs = { title: "Fix login" };
}

{
  const rename = Issue.operations.rename;
  type RenameOp = Parameters<(typeof rename)["body"]>[0];
  type _hasSelf = Expect<Extends<RenameOp["self"], { readonly _tag: "TxHandle" }>>;
  type _noCreate = Expect<Equal<RenameOp["create"], undefined>>;
}

type Arms = PolicyArms<typeof App, unknown, ["member"]>;
type IssueOps = NonNullable<NonNullable<Arms["issue"]>["operations"]>;
type _createKey = Expect<Extends<"create", keyof IssueOps>>;
type _renameKey = Expect<Extends<"rename", keyof IssueOps>>;
type TraitOps = NonNullable<
  NonNullable<NonNullable<Arms["traits"]>["taggable"]>["operations"]
>;
type _addTagKey = Expect<Extends<"addTag", keyof TraitOps>>;
