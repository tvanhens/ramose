import * as Schema from "effect/Schema";
import type { Eid } from "../../src/db/Eid.ts";
import type { AnyEntity } from "../../src/db/Entity.ts";
import type { Equal, Expect, Extends } from "../../src/db/equal.ts";
import {
  Entity,
  EntityId,
  Field,
  Operation,
  OwnedOperations,
  Ref,
  Schema as CatalogSchema,
  Trait,
  string,
} from "../../src/db/internal.ts";
import { Ref as RefSchema } from "../../src/db/valueTypes.ts";

const Slugged = Trait("slugged", { slug: string() });
const User = Entity("user", { name: string() });
const Other = Entity("other", { note: string() });
declare const userId: Eid<typeof User>;
declare const otherId: Eid<typeof Other>;

const GloballyAuthored = Operation({
  input: Schema.Struct({}),
  output: Schema.Struct({}),
  run() {
    return {};
  },
});
Entity("escapedOperationAuthor", {}, {
  // @ts-expect-error
  operations: (_Operation) => ({
    escaped: GloballyAuthored,
  }),
});

const BoundOperations = Trait(
  "boundOperations",
  { catalog: string() },
  {
    bind: (definition) => ({ values: { catalog: definition.key } }),
    operations: (Operation) => ({
      inspect: Operation({
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        run(op) {
          // @ts-expect-error
          op.self.set(BoundOperations.catalog, "forged");
          // @ts-expect-error
          op.self.set(Other.note, "wrong owner");
          return {};
        },
      }),
    }),
  },
);
type BoundInspect = typeof BoundOperations[typeof OwnedOperations]["inspect"];
declare const boundInspectContext: Parameters<BoundInspect["run"]>[0];
// @ts-expect-error
boundInspectContext.self.set(BoundOperations.catalog, "forged");

const definition = CatalogSchema("child", {});
const BoundOperationsUse = BoundOperations(definition);
const UnionBoundOperations = Trait(
  "unionBoundOperations",
  { catalog: string() },
  {
    bind: (
      definition,
    ):
      | { readonly values: { readonly catalog: string } }
      | { readonly dependencies: readonly [] } =>
      definition.key === "bound"
        ? { values: { catalog: definition.key } }
        : { dependencies: [] },
    operations: (Operation) => ({
      inspect: Operation({
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        run(op) {
          // @ts-expect-error
          op.self.set(UnionBoundOperations.catalog, "forged");
          return {};
        },
      }),
    }),
  },
);
const BoundEntity = Entity(
  "boundEntity",
  { title: string() },
  {
    traits: [BoundOperationsUse],
    operations: (Operation) => ({
      rename: Operation({
        input: Schema.Struct({ title: Schema.String }),
        output: Schema.Struct({}),
        run(op, { title }) {
          // @ts-expect-error
          op.entity();
          op.self.set(BoundEntity.title, title);
          op.set(BoundEntity, op.self, BoundEntity.title, title);
          op.put(BoundEntity, { title });
          op.update(BoundEntity, op.self.eid, { title });
          // @ts-expect-error
          op.self.set(BoundEntity.catalog, "forged");
          // @ts-expect-error
          op.update(BoundEntity, op.self.eid, { catalog: "forged" });
          // @ts-expect-error
          op.put(BoundEntity, { title, catalog: "forged" });
          return {};
        },
      }),
    }),
  },
);

type BroadRunContext = {
  update(
    entity: AnyEntity,
    id: number,
    attrs: Record<string, unknown>,
  ): void;
};
const extractedBroadRun = (op: BroadRunContext) => {
  op.update(BoundEntity, 1, { catalog: "forged" });
  return {};
};
const extractedOptionalBroadRun = (op?: BroadRunContext) => {
  op?.update(BoundEntity, 1, { catalog: "forged" });
  return {};
};
Entity(
  "extractedRunOwner",
  { title: string() },
  {
    traits: [BoundOperationsUse],
    operations: (Operation) => ({
      escaped: Operation({
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        // @ts-expect-error
        run: extractedBroadRun,
      }),
      optionalEscape: Operation({
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        // @ts-expect-error
        run: extractedOptionalBroadRun,
      }),
    }),
  },
);

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
          // @ts-expect-error
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

const Classified = Trait("classified", {});
const Specialized = Trait("specialized", {}, { traits: [Classified] });
const ClassifiedEntity = Entity("classifiedEntity", {}, { traits: [Specialized] });
const UnclassifiedEntity = Entity("unclassifiedEntity", {});
declare const classifiedId: Eid<typeof ClassifiedEntity>;
declare const unclassifiedId: Eid<typeof UnclassifiedEntity>;

const Relation = Trait(
  "relation",
  { target: Ref(Classified), parent: Ref.self },
  {
    operations: (Operation) => ({
      retarget: Operation({
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        run(op) {
          op.self.set(Relation.target, classifiedId);
          // @ts-expect-error
          op.self.set(Relation.target, unclassifiedId);
          op.self.set(Relation.parent, 1);
          return {};
        },
      }),
    }),
  },
);

const Link = Entity(
  "link",
  { target: Ref(Classified), parent: Ref.self },
  {
    operations: (Operation) => ({
      retarget: Operation({
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        run(op) {
          op.self.set(Link.target, classifiedId);
          // @ts-expect-error
          op.self.set(Link.target, unclassifiedId);
          op.self.set(Link.parent, 1);
          return {};
        },
      }),
    }),
  },
);

const PlainOperationsEntity = Entity("plainOperationsEntity", {}, {
  operations: (Operation) => ({
    inspect: Operation({
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});
const PlainOperationsTrait = Trait("plainOperationsTrait", {}, {
  operations: (Operation) => ({
    inspect: Operation({
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});
export type _entityOmittedTraitsAreEmpty = Expect<
  Extends<typeof PlainOperationsEntity.traits, readonly []>
>;
export type _traitOmittedTraitsAreEmpty = Expect<
  Extends<typeof PlainOperationsTrait.traits, readonly []>
>;

const invalidOperationKey = Symbol("invalidOperationKey");
Entity("symbolOperationKey", {}, {
  // @ts-expect-error
  operations: (Operation) => ({
    [invalidOperationKey]: Operation({
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});
Entity("numberOperationKey", {}, {
  // @ts-expect-error
  operations: (Operation) => ({
    1: Operation({
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});
Entity("openOperationMap", {}, {
  // @ts-expect-error
  operations: (Operation) => {
    const spec = Operation({
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      run() {
        return {};
      },
    });
    const key: string = "run";
    const operations: Record<string, typeof spec> = { [key]: spec };
    return operations;
  },
});

const IssueLike = Trait("issueLike", {});
const Membership = Entity("membership", {
  issue: Ref(IssueLike),
  user: Ref(User),
  role: string(),
});
const widenedWrites: readonly (typeof Membership | typeof Other)[] = [Membership];
declare const conditionalWrites:
  | readonly [typeof Membership]
  | readonly [typeof Other];
Entity("invalidWriteDependencies", {}, {
  operations: (Operation) => ({
    widened: Operation({
      // @ts-expect-error
      writes: widenedWrites,
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      run() {
        return {};
      },
    }),
    conditional: Operation({
      // @ts-expect-error
      writes: conditionalWrites,
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      run() {
        return {};
      },
    }),
  }),
});

const Issue = Entity(
  "issue",
  { title: string(), assignee: Ref(User, { optional: true }) },
  {
    traits: [Taggable, IssueLike],
    operations: (Operation) => ({
      create: Operation({
        self: false,
        writes: [Membership, Other],
        input: Schema.Struct({ title: Schema.String, slug: Schema.String }),
        output: Schema.Struct({ id: EntityId }),
        run(op, input) {
          // @ts-expect-error
          op.create({ slug: input.slug });
          const issue = op.create({ title: input.title, slug: input.slug });
          issue.set(Issue.title, input.title);
          const membership = op.put(Membership, {
            issue,
            user: userId,
            role: "owner",
          });
          // @ts-expect-error
          op.put(User, { name: input.title });
          const writeTarget = Math.random() > 0.5 ? Membership : Other;
          // @ts-expect-error
          op.put(writeTarget, {});
          // @ts-expect-error
          op.put(writeTarget, { note: input.title });
          if (writeTarget.ns === "other") {
            op.put(writeTarget, { note: input.title });
          }
          membership.set(Membership.issue, issue);
          membership.set(Membership.role, "admin");
          // @ts-expect-error
          membership.set(Membership.user, membership);
          // @ts-expect-error
          issue.set(Issue.assignee, issue);
          return { id: issue };
        },
      }),
      rename: Operation({
        input: Schema.Struct({ title: Schema.String }),
        output: Schema.Struct({}),
        run(op, { title }) {
          op.self.set(Issue.title, title);
          op.self.set(Issue.assignee, userId);
          // @ts-expect-error
          op.self.set(Issue.assignee, otherId);
          // @ts-expect-error
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

type AddTag = typeof Taggable[typeof OwnedOperations]["addTag"];
type AddTagContext = Parameters<AddTag["run"]>[0];
type AddTagInput = Parameters<AddTag["run"]>[1];
export type _traitOwner = Expect<Extends<typeof Taggable, AddTag["owner"]>>;
export type _traitLocalKey = Expect<Equal<AddTag["localName"], "addTag">>;
export type _traitSelfDefault = Expect<Equal<AddTag["self"], true>>;
export type _traitInput = Expect<Equal<AddTagInput, { readonly tag: string }>>;
export type _traitHasSelf = Expect<
  Extends<AddTagContext["self"], { readonly _tag: "TxHandle" }>
>;

type Rebuild = typeof Taggable[typeof OwnedOperations]["rebuild"];
type RebuildContext = Parameters<Rebuild["run"]>[0];
export type _targetlessTrait = Expect<Equal<Rebuild["self"], false>>;
export type _targetlessTraitNoSelf = Expect<Equal<RebuildContext["self"], undefined>>;
export type _targetlessTraitNoCreate = Expect<Equal<RebuildContext["create"], undefined>>;

type Create = typeof Issue[typeof OwnedOperations]["create"];
type CreateContext = Parameters<Create["run"]>[0];
type CreateAttrs = Parameters<NonNullable<CreateContext["create"]>>[0];
export type _entityOwner = Expect<Extends<typeof Issue, Create["owner"]>>;
export type _entityTargetless = Expect<Equal<Create["self"], false>>;
export type _createNeedsEntityField = Expect<Extends<"title", keyof CreateAttrs>>;
export type _createNeedsTransitiveTraitField = Expect<Extends<"slug", keyof CreateAttrs>>;
const _completeCreate: CreateAttrs = { title: "Fix auth", slug: "fix-auth" };
// @ts-expect-error
const _missingEntityField: CreateAttrs = { slug: "fix-auth" };
// @ts-expect-error
const _missingTraitField: CreateAttrs = { title: "Fix auth" };

type Rename = typeof Issue[typeof OwnedOperations]["rename"];
type RenameContext = Parameters<Rename["run"]>[0];
export type _entityTargeted = Expect<Equal<Rename["self"], true>>;
export type _targetedNoCreate = Expect<Equal<RenameContext["create"], undefined>>;

type Dynamic = typeof Issue[typeof OwnedOperations]["dynamic"];
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
    // @ts-expect-error
    op.self.set(Issue.title, "x");
    return {};
  },
});

Operation({
  input: Schema.Struct({ title: Schema.String }),
  output: Schema.Struct({}),
  run(op, _input) {
    // @ts-expect-error
    op.create({});
    return {};
  },
});

void _completeCreate;
void _missingEntityField;
void _missingTraitField;
void BoundOperations;
void BoundEntity;
void Relation;
void Link;
