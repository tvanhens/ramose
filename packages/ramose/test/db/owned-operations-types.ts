/**
 * Compile-time contract for entity- and trait-owned operations (#317).
 * `bun run typecheck` compiles this file.
 */

import * as Schema from "effect/Schema";
import type { Equal, Expect, Extends } from "../../src/db/equal.ts";
import {
  Entity,
  EntityId,
  Field,
  Operation,
  Trait,
  string,
} from "../../src/db/internal.ts";
import { Ref as RefSchema } from "../../src/db/valueTypes.ts";

const Slugged = Trait("slugged", { slug: string() });
const Other = Entity("other", { note: string() });

const Taggable = Trait(
  "taggable",
  { tags: Field.many(string()) },
  {
    traits: [Slugged],
    operations: (Operation) => ({
      addTag: Operation({
        input: Schema.Struct({ tag: Schema.String }),
        output: Schema.Struct({}),
        run(op, { tag }) {
          op.self.set(Taggable.tags, tag);
          // @ts-expect-error trait operations cannot write an unrelated owner field
          op.self.set(Other.note, tag);
          return {};
        },
      }),
      rebuild: Operation({
        self: false,
        input: Schema.Struct({ force: Schema.Boolean }),
        output: Schema.Struct({}),
        run(_op, _input) {
          return {};
        },
      }),
    }),
  },
);

const Issue = Entity(
  "issue",
  { title: string() },
  {
    traits: [Taggable],
    operations: (Operation) => ({
      create: Operation({
        self: false,
        input: Schema.Struct({ title: Schema.String, slug: Schema.String }),
        output: Schema.Struct({ id: EntityId }),
        run(op, input) {
          // @ts-expect-error targetless create requires every entity field
          op.create({ slug: input.slug });
          return { id: op.create({ title: input.title, slug: input.slug }) };
        },
      }),
      rename: Operation({
        input: Schema.Struct({ title: Schema.String }),
        output: Schema.Struct({}),
        run(op, { title }) {
          op.self.set(Issue.title, title);
          // @ts-expect-error entity operations cannot write an unrelated owner field
          op.self.set(Other.note, title);
          return {};
        },
      }),
      dynamic: Operation({
        self: Math.random() > 0.5,
        input: Schema.Struct({ title: Schema.String }),
        output: Schema.Struct({}),
        run(op, { title }) {
          if (op.self !== undefined) op.self.set(Issue.title, title);
          return {};
        },
      }),
    }),
  },
);

type AddTag = typeof Taggable.operations.addTag;
type AddTagContext = Parameters<AddTag["run"]>[0];
type AddTagInput = Parameters<AddTag["run"]>[1];
export type _traitOwner = Expect<Extends<typeof Taggable, AddTag["owner"]>>;
export type _traitLocalKey = Expect<Equal<AddTag["localName"], "addTag">>;
export type _traitSelfDefault = Expect<Equal<AddTag["self"], true>>;
export type _traitInput = Expect<Equal<AddTagInput, { readonly tag: string }>>;
export type _traitHasSelf = Expect<
  Extends<AddTagContext["self"], { readonly _tag: "TxHandle" }>
>;

type Rebuild = typeof Taggable.operations.rebuild;
type RebuildContext = Parameters<Rebuild["run"]>[0];
export type _targetlessTrait = Expect<Equal<Rebuild["self"], false>>;
export type _targetlessTraitNoSelf = Expect<Equal<RebuildContext["self"], undefined>>;
export type _targetlessTraitNoCreate = Expect<Equal<RebuildContext["create"], undefined>>;

type Create = typeof Issue.operations.create;
type CreateContext = Parameters<Create["run"]>[0];
type CreateAttrs = Parameters<NonNullable<CreateContext["create"]>>[0];
export type _entityOwner = Expect<Extends<typeof Issue, Create["owner"]>>;
export type _entityTargetless = Expect<Equal<Create["self"], false>>;
export type _createNeedsEntityField = Expect<Extends<"title", keyof CreateAttrs>>;
export type _createNeedsTransitiveTraitField = Expect<Extends<"slug", keyof CreateAttrs>>;
const _completeCreate: CreateAttrs = { title: "Fix auth", slug: "fix-auth" };
// @ts-expect-error title is a required entity field
const _missingEntityField: CreateAttrs = { slug: "fix-auth" };
// @ts-expect-error slug is a required transitive-trait field
const _missingTraitField: CreateAttrs = { title: "Fix auth" };

type Rename = typeof Issue.operations.rename;
type RenameContext = Parameters<Rename["run"]>[0];
export type _entityTargeted = Expect<Equal<Rename["self"], true>>;
export type _targetedNoCreate = Expect<Equal<RenameContext["create"], undefined>>;

type Dynamic = typeof Issue.operations.dynamic;
type DynamicContext = Parameters<Dynamic["run"]>[0];
export type _dynamicSelfFlag = Expect<Equal<Dynamic["self"], boolean>>;
export type _dynamicSelfHandle = Expect<
  Equal<undefined extends DynamicContext["self"] ? true : false, true>
>;

Operation({
  self: false,
  input: Schema.Struct({ target: RefSchema.self }),
  output: Schema.Struct({}),
  run(op, _input) {
    // @ts-expect-error a targetless operation cannot access a target resource
    op.self.set(Issue.title, "x");
    return {};
  },
});

Operation({
  input: Schema.Struct({ title: Schema.String }),
  output: Schema.Struct({}),
  run(op, _input) {
    // @ts-expect-error targeted operations do not expose the entity-create helper
    op.create({});
    return {};
  },
});

void _completeCreate;
void _missingEntityField;
void _missingTraitField;
