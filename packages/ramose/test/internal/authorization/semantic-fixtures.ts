/**
 * Shared authoring schema, catalog descriptor, and semantic scenarios.
 *
 * Compile lowers structurally. Trait composition, self-ref / ref-target,
 * equality, membership, and path reachability are asserted here by
 * compile → bind → validate against the extracted catalog — not by a
 * second compiler kernel.
 *
 * `validate.test.ts` / `bind.test.ts` / `install.test.ts` keep their own
 * descriptors: those copies are not a mechanical extract of this catalog
 * (orphaned trait, tag-grant, aliases/labels).
 */

import { expect } from "bun:test";
import * as Result from "effect/Result";
import {
  CatalogId,
  CatalogMismatch,
  CatalogVersion,
  DatabaseId,
  EntityId,
  FieldId,
  InvalidIR,
  OperationId,
  SchemaFingerprint,
  TraitId,
  bindPolicyTemplateResult,
  compileReadAuthorizationResult,
  validateBoundAuthorizationResult,
  claim,
  contains,
  eq,
  me,
  path,
  read,
  type CatalogBindingTarget,
  type CatalogDescriptor,
  type FieldRefTarget,
  type OwnerRef,
  type PolicyTemplateIR,
  type AuthRule,
  type ReadRule,
  type ValidatedAuthorizationIR,
} from "../../../src/internal/authorization/index.ts";
import { Entity, Field, Ref, Schema, Trait, string, type AnySchema } from "../../../src/db/internal.ts";

export const User = Entity("user", {
  authId: Field.unique(string(), "upsert"),
});
export const Workspace = Entity("workspace", {
  members: Field.many(Ref(User)),
});
export const Tag = Entity("tag", { name: string() });
export const Taggable = Trait("taggable", { tags: Field.many(Ref(User)) });
export const Issue = Entity(
  "issue",
  {
    owner: Ref(User),
    workspace: Ref(Workspace),
    title: string(),
    parent: Ref.self,
  },
  { traits: [Taggable] },
);
export const App = Schema({ user: User, workspace: Workspace, tag: Tag, issue: Issue });

export const orgClaim = {
  key: "org",
  optional: false,
  shape: { _tag: "scalar" as const, valueType: "string" as const },
};

export const teamsClaim = {
  key: "teams",
  optional: true,
  shape: { _tag: "array" as const, items: { _tag: "scalar" as const, valueType: "string" as const } },
};

export type CompileExtras = Omit<Partial<Parameters<typeof compileReadAuthorizationResult>[0]>, "rules">;

export const compileRules = (
  rules: readonly AuthRule[],
  extras: CompileExtras = {},
) =>
  compileReadAuthorizationResult({
    schema: extras.schema ?? App,
    rules,
    claims: extras.claims ?? [orgClaim],
    principal: extras.principal ?? { entity: User.authId },
    ...(extras.classes === undefined ? {} : { classes: extras.classes }),
  });

export const expectInvalid = (result: Result.Result<unknown, InvalidIR>, pattern: RegExp) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(InvalidIR);
    expect(result.failure._tag).toBe("InvalidIR");
    expect(result.failure.message).toMatch(pattern);
  }
};

export const expectOk = (result: Result.Result<PolicyTemplateIR, InvalidIR>): PolicyTemplateIR => {
  if (Result.isFailure(result)) {
    throw new Error(`expected success, got ${result.failure.message}`);
  }
  return result.success;
};

export const catalog = CatalogId.make("app");
export const database = DatabaseId.make("todos");
export const version = CatalogVersion.make("1");
export const fingerprint = SchemaFingerprint.make("schema");
export const issueOwner = { kind: "entity" as const, name: "issue" };
export const userOwner = { kind: "entity" as const, name: "user" };
export const taggableOwner = { kind: "trait" as const, name: "taggable" };
export const workspaceOwner = { kind: "entity" as const, name: "workspace" };

export const target: CatalogBindingTarget = {
  database,
  catalog,
  catalogVersion: version,
  schemaFingerprint: fingerprint,
};

const entityId = (name: string) => EntityId.make({ catalog, name });
const traitId = (name: string) => TraitId.make({ catalog, name });
const fieldId = (owner: OwnerRef, localName: string) => FieldId.make({ catalog, owner, localName });

const scalarField = (
  owner: OwnerRef,
  localName: string,
  options: { readonly unique?: "upsert" | "strict" } = {},
): CatalogDescriptor["fields"][number] => ({
  id: fieldId(owner, localName),
  valueType: "string",
  cardinality: "one",
  ...(options.unique === undefined ? {} : { unique: options.unique }),
  index: options.unique !== undefined,
  optional: false,
  owned: false,
});

const refField = (
  owner: OwnerRef,
  localName: string,
  refTarget: FieldRefTarget,
  cardinality: "one" | "many" = "one",
): CatalogDescriptor["fields"][number] => ({
  id: fieldId(owner, localName),
  valueType: "ref",
  refTarget,
  cardinality,
  index: false,
  optional: false,
  owned: false,
});

/** Extracted from the former authoring-test catalog — do not invent a new one. */
export const catalogDescriptor = (): CatalogDescriptor => ({
  id: catalog,
  database,
  version,
  fingerprint,
  entities: [
    { id: entityId("user"), traits: [] },
    { id: entityId("workspace"), traits: [] },
    { id: entityId("issue"), traits: [traitId("taggable")] },
    { id: entityId("tag"), traits: [] },
  ],
  traits: [{ id: traitId("taggable"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    refField(issueOwner, "owner", { _tag: "entity", entity: entityId("user") }),
    refField(issueOwner, "workspace", { _tag: "entity", entity: entityId("workspace") }),
    scalarField(issueOwner, "title"),
    refField(issueOwner, "parent", { _tag: "self" }),
    refField(workspaceOwner, "members", { _tag: "entity", entity: entityId("user") }, "many"),
    refField(taggableOwner, "tags", { _tag: "entity", entity: entityId("user") }, "many"),
    scalarField({ kind: "entity", name: "tag" }, "name"),
  ],
  operations: [
    {
      id: OperationId.make({ catalog, owner: issueOwner, localName: "rename", target: "required" }),
      input: {
        _tag: "struct",
        fields: [{ key: "title", optional: false, shape: { _tag: "scalar", valueType: "string" } }],
      },
    },
  ],
  traitComposition: [
    {
      composer: entityId("issue"),
      trait: traitId("taggable"),
      transitive: [traitId("taggable")],
    },
  ],
});

export const bindAndValidate = (
  template: PolicyTemplateIR,
  descriptor: CatalogDescriptor = catalogDescriptor(),
): Result.Result<ValidatedAuthorizationIR, InvalidIR | CatalogMismatch> =>
  Result.gen(function* () {
    const bound = yield* bindPolicyTemplateResult({ target, descriptor, template });
    return yield* validateBoundAuthorizationResult({ bound, descriptor });
  });

export type SemanticReject = {
  readonly name: string;
  readonly compile: () => Result.Result<PolicyTemplateIR, InvalidIR>;
  readonly descriptor: () => CatalogDescriptor;
  readonly installFails: RegExp;
};

const appReject = (
  name: string,
  rules: readonly ReadRule[],
  installFails: RegExp,
  extras: CompileExtras = {},
): SemanticReject => ({
  name,
  compile: () => compileRules(rules, extras),
  descriptor: catalogDescriptor,
  installFails,
});

const Labeled = Trait("labeled", { labels: Field.many(Ref(Tag)) });
const Note = Entity("note", { title: string() }, { traits: [Labeled] });
const LabeledApp = Schema({ user: User, tag: Tag, note: Note });

const labeledDescriptor = (): CatalogDescriptor => ({
  id: catalog,
  database,
  version,
  fingerprint,
  entities: [
    { id: entityId("user"), traits: [] },
    { id: entityId("tag"), traits: [] },
    { id: entityId("note"), traits: [traitId("labeled")] },
  ],
  traits: [{ id: traitId("labeled"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    scalarField({ kind: "entity", name: "tag" }, "name"),
    scalarField({ kind: "entity", name: "note" }, "title"),
    refField({ kind: "trait", name: "labeled" }, "labels", { _tag: "entity", entity: entityId("tag") }, "many"),
  ],
  operations: [],
  traitComposition: [
    { composer: entityId("note"), trait: traitId("labeled"), transitive: [traitId("labeled")] },
  ],
});

const Linkable = Trait("linkable", {
  parent: Ref.self,
  label: string(),
});
const LinkedIssue = Entity("issue", { owner: Ref(User) }, { traits: [Linkable] });
const LinkedApp = Schema({ user: User, issue: LinkedIssue });

const linkedDescriptor = (): CatalogDescriptor => ({
  id: catalog,
  database,
  version,
  fingerprint,
  entities: [
    { id: entityId("user"), traits: [] },
    { id: entityId("issue"), traits: [traitId("linkable")] },
  ],
  traits: [{ id: traitId("linkable"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    refField(issueOwner, "owner", { _tag: "entity", entity: entityId("user") }),
    refField({ kind: "trait", name: "linkable" }, "parent", { _tag: "self" }),
    scalarField({ kind: "trait", name: "linkable" }, "label"),
  ],
  operations: [],
  traitComposition: [
    { composer: entityId("issue"), trait: traitId("linkable"), transitive: [traitId("linkable")] },
  ],
});

const Member = Trait("member", {});
const Base = Trait("base", {});
const Extra = Trait("extra", {}, { traits: [Base] });
const Person = Entity("person", { authId: Field.unique(string(), "upsert") }, { traits: [Member] });
const Guest = Entity("guest", { authId: Field.unique(string(), "upsert") });
const Holder = Entity("holder", { authId: Field.unique(string(), "upsert") }, { traits: [Extra] });
const Bag = Entity("bag", {
  holder: Ref(Member),
  owner: Ref(Person),
  guest: Ref(Guest),
  base: Ref(Base),
  extra: Ref(Extra),
});
const Bags = Schema({ person: Person, guest: Guest, holder: Holder, bag: Bag });

const bagsDescriptor = (): CatalogDescriptor => ({
  id: catalog,
  database,
  version,
  fingerprint,
  entities: [
    { id: entityId("person"), traits: [traitId("member")] },
    { id: entityId("guest"), traits: [] },
    { id: entityId("holder"), traits: [traitId("extra")] },
    { id: entityId("bag"), traits: [] },
  ],
  traits: [
    { id: traitId("member"), traits: [] },
    { id: traitId("base"), traits: [] },
    { id: traitId("extra"), traits: [traitId("base")] },
  ],
  fields: [
    scalarField({ kind: "entity", name: "person" }, "authId", { unique: "upsert" }),
    scalarField({ kind: "entity", name: "guest" }, "authId", { unique: "upsert" }),
    scalarField({ kind: "entity", name: "holder" }, "authId", { unique: "upsert" }),
    refField({ kind: "entity", name: "bag" }, "holder", { _tag: "trait", trait: traitId("member") }),
    refField({ kind: "entity", name: "bag" }, "owner", { _tag: "entity", entity: entityId("person") }),
    refField({ kind: "entity", name: "bag" }, "guest", { _tag: "entity", entity: entityId("guest") }),
    refField({ kind: "entity", name: "bag" }, "base", { _tag: "trait", trait: traitId("base") }),
    refField({ kind: "entity", name: "bag" }, "extra", { _tag: "trait", trait: traitId("extra") }),
  ],
  operations: [],
  traitComposition: [
    { composer: entityId("person"), trait: traitId("member"), transitive: [traitId("member")] },
    {
      composer: entityId("holder"),
      trait: traitId("extra"),
      transitive: [traitId("extra"), traitId("base")],
    },
  ],
});

const Actor = Trait("actor", {});
const ActorUser = Entity("user", { authId: Field.unique(string(), "upsert") }, { traits: [Actor] });
const Stranger = Entity("stranger", { authId: Field.unique(string(), "upsert") });
const ActorResource = Entity("resource", {
  userRef: Ref(ActorUser),
  actorRef: Ref(Actor),
  manyActorRefs: Field.many(Ref(Actor)),
  strangerRef: Ref(Stranger),
});
const ActorResources = Schema({ user: ActorUser, stranger: Stranger, resource: ActorResource });

const actorDescriptor = (): CatalogDescriptor => ({
  id: catalog,
  database,
  version,
  fingerprint,
  entities: [
    { id: entityId("user"), traits: [traitId("actor")] },
    { id: entityId("stranger"), traits: [] },
    { id: entityId("resource"), traits: [] },
  ],
  traits: [{ id: traitId("actor"), traits: [] }],
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    scalarField({ kind: "entity", name: "stranger" }, "authId", { unique: "upsert" }),
    refField({ kind: "entity", name: "resource" }, "userRef", { _tag: "entity", entity: entityId("user") }),
    refField({ kind: "entity", name: "resource" }, "actorRef", { _tag: "trait", trait: traitId("actor") }),
    refField({ kind: "entity", name: "resource" }, "manyActorRefs", { _tag: "trait", trait: traitId("actor") }, "many"),
    refField({ kind: "entity", name: "resource" }, "strangerRef", { _tag: "entity", entity: entityId("stranger") }),
  ],
  operations: [],
  traitComposition: [
    { composer: entityId("user"), trait: traitId("actor"), transitive: [traitId("actor")] },
  ],
});

const LooseResource = Entity("resource", {
  userRef: Ref(User),
  looseRef: Field(Ref),
  otherLoose: Field(Ref),
});
const LooseResources = Schema({ user: User, resource: LooseResource });

const looseDescriptor = (): CatalogDescriptor => ({
  id: catalog,
  database,
  version,
  fingerprint,
  entities: [
    { id: entityId("user"), traits: [] },
    { id: entityId("resource"), traits: [] },
  ],
  traits: [],
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    refField({ kind: "entity", name: "resource" }, "userRef", { _tag: "entity", entity: entityId("user") }),
    refField({ kind: "entity", name: "resource" }, "looseRef", { _tag: "untargeted" }),
    refField({ kind: "entity", name: "resource" }, "otherLoose", { _tag: "untargeted" }),
  ],
  operations: [],
  traitComposition: [],
});

const External = Entity("external", { name: string() });
const OrphanTrait = Trait("orphan", {});
const OrphanResource = Entity("resource", {
  userRef: Ref(User),
  external: Ref(External),
  externals: Field.many(Ref(External)),
  orphan: Ref(OrphanTrait),
  looseRef: Field(Ref),
  parent: Ref.self,
});
const OrphanResources = Schema({ user: User, resource: OrphanResource });

const orphanResourceBase = (): Omit<CatalogDescriptor, "fields"> => ({
  id: catalog,
  database,
  version,
  fingerprint,
  entities: [
    { id: entityId("user"), traits: [] },
    { id: entityId("resource"), traits: [] },
  ],
  traits: [],
  operations: [],
  traitComposition: [],
});

const missingExternalDescriptor = (): CatalogDescriptor => ({
  ...orphanResourceBase(),
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    refField({ kind: "entity", name: "resource" }, "userRef", { _tag: "entity", entity: entityId("user") }),
    refField({ kind: "entity", name: "resource" }, "external", { _tag: "entity", entity: entityId("external") }),
    refField({ kind: "entity", name: "resource" }, "looseRef", { _tag: "untargeted" }),
    refField({ kind: "entity", name: "resource" }, "parent", { _tag: "self" }),
  ],
});

const missingOrphanTraitDescriptor = (): CatalogDescriptor => ({
  ...orphanResourceBase(),
  fields: [
    scalarField(userOwner, "authId", { unique: "upsert" }),
    refField({ kind: "entity", name: "resource" }, "userRef", { _tag: "entity", entity: entityId("user") }),
    refField({ kind: "entity", name: "resource" }, "orphan", { _tag: "trait", trait: traitId("orphan") }),
    refField({ kind: "entity", name: "resource" }, "looseRef", { _tag: "untargeted" }),
    refField({ kind: "entity", name: "resource" }, "parent", { _tag: "self" }),
  ],
});

const extra = (
  name: string,
  schema: AnySchema,
  rules: readonly ReadRule[],
  descriptor: () => CatalogDescriptor,
  installFails: RegExp,
  extras: CompileExtras = {},
): SemanticReject => ({
  name,
  compile: () =>
    compileRules(rules, { principal: { entity: User.authId }, claims: [], ...extras, schema }),
  descriptor,
  installFails,
});

export const semanticRejects: readonly SemanticReject[] = [
  appReject("incompatible eq: title vs me", [read(Issue).when(eq(Issue.title, me))], /incompatible equality/),
  appReject("incompatible eq: title vs number", [read(Issue).when(eq(Issue.title, 1))], /incompatible equality/),
  appReject("incompatible eq: distinct entity refs", [read(Issue).when(eq(Issue.owner, Issue.workspace))], /incompatible equality/),
  appReject("eq card-many members", [read(Workspace).when(eq(Workspace.members, me))], /incompatible equality|card-many|contains/),
  appReject("eq card-many tags", [read(Issue).when(eq(Issue.tags, me))], /incompatible equality|card-many|contains/),
  appReject("contains card-one owner", [read(Issue).when(contains(Issue.owner, me))], /membership requires a collection/),
  appReject("contains me as collection", [read(Issue).when(contains(me, Issue.owner))], /membership requires a collection/),
  appReject("contains scalar members vs string", [read(Workspace).when(contains(Workspace.members, "x"))], /incompatible membership/),
  appReject("contains scalar claim as collection", [read(Issue).when(contains(claim("org"), "x"))], /membership requires a collection/),
  appReject(
    "contains string-array claim vs me",
    [read(Issue).when(contains(claim("teams"), me))],
    /incompatible membership/,
    { claims: [orgClaim, teamsClaim] },
  ),
  appReject("wrong owner: user.authId from issue", [read(Issue).when(eq(User.authId, "x"))], /wrong owner/),
  appReject(
    "wrong owner: workspace.members after issue.owner",
    [read(Issue).when(contains(path(Issue.owner, Workspace.members), me))],
    /wrong owner/,
  ),
  appReject("wrong owner: user.authId from title focus", [read(Issue.title).when(eq(User.authId, "x"))], /wrong owner/),
  appReject(
    "intermediate non-ref",
    [read(Issue).when(eq(path(Issue.title, User.authId), me))],
    /non-ref traversal/,
  ),
  appReject(
    "intermediate many hop",
    [read(Issue).when(eq(path(Issue.workspace, Workspace.members, User.authId), "x"))],
    /intermediate many-valued traversal/,
  ),
  appReject(
    "principal title is not unique",
    [read(Issue).when(eq(Issue.owner, me))],
    /principal field is not unique/,
    { principal: { entity: Issue.title } },
  ),
  appReject(
    "principal trait field is not unique",
    [read(Issue).when(eq(Issue.owner, me))],
    /principal field is not unique|principal field must be entity-owned/,
    { principal: { entity: Taggable.tags } },
  ),
  extra(
    "incompatible membership: labels vs me",
    LabeledApp,
    [read(Labeled).when(contains(Labeled.labels, me))],
    labeledDescriptor,
    /incompatible membership/,
  ),
  extra(
    "trait self-ref then entity field is the wrong owner",
    LinkedApp,
    [read(LinkedIssue).when(eq(path(Linkable.parent, LinkedIssue.owner), me))],
    linkedDescriptor,
    /wrong owner/,
  ),
  extra(
    "me does not match a trait the principal does not compose",
    Bags,
    [read(Bag).when(eq(Bag.holder, me))],
    bagsDescriptor,
    /incompatible equality/,
    { principal: { entity: Guest.authId } },
  ),
  extra(
    "refs incompatible when entity does not compose the trait",
    Bags,
    [read(Bag).when(eq(Bag.holder, Bag.guest))],
    bagsDescriptor,
    /incompatible equality/,
    { principal: { entity: Person.authId } },
  ),
  extra(
    "eq fails when the entity does not compose the trait",
    ActorResources,
    [read(ActorResource).when(eq(ActorResource.strangerRef, ActorResource.actorRef))],
    actorDescriptor,
    /incompatible equality/,
    { principal: { entity: ActorUser.authId } },
  ),
  extra(
    "exactly one untargeted ref is incompatible",
    LooseResources,
    [read(LooseResource).when(eq(LooseResource.looseRef, LooseResource.userRef))],
    looseDescriptor,
    /incompatible equality/,
  ),
  extra(
    "untargeted ref is incompatible with me",
    LooseResources,
    [read(LooseResource).when(eq(LooseResource.looseRef, me))],
    looseDescriptor,
    /incompatible equality/,
  ),
  extra(
    "cannot traverse from an untargeted ref",
    LooseResources,
    [read(LooseResource).when(eq(path(LooseResource.looseRef, User.authId), "x"))],
    looseDescriptor,
    /untargeted ref/,
  ),
  extra(
    "out-of-catalog terminal entity ref",
    OrphanResources,
    [read(OrphanResource).when(eq(OrphanResource.external, OrphanResource.external))],
    missingExternalDescriptor,
    /missing field ref target entity 'external'/,
  ),
  extra(
    "out-of-catalog terminal trait ref",
    OrphanResources,
    [read(OrphanResource).when(eq(OrphanResource.orphan, OrphanResource.orphan))],
    missingOrphanTraitDescriptor,
    /missing field ref target trait 'orphan'/,
  ),
];

export const semanticAccepts: ReadonlyArray<{
  readonly name: string;
  readonly compile: () => Result.Result<PolicyTemplateIR, InvalidIR>;
  readonly descriptor: () => CatalogDescriptor;
}> = [
  {
    name: "me matches a ref to a composed trait",
    compile: () =>
      compileRules([read(Bag).when(eq(Bag.holder, me))], {
        schema: Bags,
        claims: [],
        principal: { entity: Person.authId },
      }),
    descriptor: bagsDescriptor,
  },
  {
    name: "entity ref matches a composed trait ref",
    compile: () =>
      compileRules([read(Bag).when(eq(Bag.holder, Bag.owner))], {
        schema: Bags,
        claims: [],
        principal: { entity: Person.authId },
      }),
    descriptor: bagsDescriptor,
  },
  {
    name: "trait refs compatible when one composes the other",
    compile: () =>
      compileRules([read(Bag).when(eq(Bag.base, Bag.extra))], {
        schema: Bags,
        claims: [],
        principal: { entity: Holder.authId },
      }),
    descriptor: bagsDescriptor,
  },
  {
    name: "eq(userRef, actorRef) when User composes Actor",
    compile: () =>
      compileRules([read(ActorResource).when(eq(ActorResource.userRef, ActorResource.actorRef))], {
        schema: ActorResources,
        claims: [],
        principal: { entity: ActorUser.authId },
      }),
    descriptor: actorDescriptor,
  },
  {
    name: "contains(manyActorRefs, userRef) via installation eqCompatible",
    compile: () =>
      compileRules(
        [read(ActorResource).when(contains(ActorResource.manyActorRefs, ActorResource.userRef))],
        { schema: ActorResources, claims: [], principal: { entity: ActorUser.authId } },
      ),
    descriptor: actorDescriptor,
  },
  {
    name: "two untargeted refs are compatible",
    compile: () =>
      compileRules([read(LooseResource).when(eq(LooseResource.looseRef, LooseResource.otherLoose))], {
        schema: LooseResources,
        claims: [],
        principal: { entity: User.authId },
      }),
    descriptor: looseDescriptor,
  },
  {
    name: "after a trait self-ref, a trait-owned field stays reachable",
    compile: () =>
      compileRules([read(LinkedIssue).when(eq(path(Linkable.parent, Linkable.label), "x"))], {
        schema: LinkedApp,
        claims: [],
        principal: { entity: User.authId },
      }),
    descriptor: linkedDescriptor,
  },
  {
    name: "contains string-array claim vs string lit",
    compile: () =>
      compileRules([read(Issue).when(contains(claim("teams"), "admin"))], {
        claims: [orgClaim, teamsClaim],
      }),
    descriptor: catalogDescriptor,
  },
];

export { Labeled, Note, LabeledApp, Linkable, LinkedIssue, LinkedApp, Bags, Bag, Person, Guest, Holder };
export { ActorResources, ActorResource, ActorUser, LooseResources, LooseResource, OrphanResources, OrphanResource, External };
