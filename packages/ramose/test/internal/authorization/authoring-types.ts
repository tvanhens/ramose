/**
 * Type-level fixtures for the read-authorization authoring language.
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error.
 */

import type { Equal, Expect, Extends } from "../../../src/db/equal.ts";
import type { PolicyTemplateIR } from "../../../src/internal/authorization/index.ts";
import {
  compileReadAuthorizationResult,
  read,
  type CompileReadAuthorizationInput,
  type ReadRule,
} from "../../../src/internal/authorization/index.ts";
import { Entity, Field, Ref, Schema, Trait, string } from "../../../src/db/internal.ts";

const User = Entity("user", {
  authId: Field.unique(string(), "upsert"),
});
const Workspace = Entity("workspace", {
  members: Field.many(Ref(User)),
});
const Tag = Entity("tag", { name: string() });
const Taggable = Trait("taggable", { tags: Field.many(Ref(Tag)) });
const Issue = Entity(
  "issue",
  {
    owner: Ref(User),
    workspace: Ref(Workspace),
    title: string(),
  },
  { traits: [Taggable] },
);

const _entity = read(Issue);
const _trait = read(Taggable);
const _fieldTitle = read(Issue.title);
const _fieldOwner = read(Issue.owner);

export type _readEntity = Expect<Extends<ReturnType<typeof _entity.when>, ReadRule>>;
export type _readTrait = Expect<Extends<ReturnType<typeof _trait.when>, ReadRule>>;
export type _readField = Expect<Extends<ReturnType<typeof _fieldTitle.when>, ReadRule>>;
export type _readOwnerField = Expect<Extends<ReturnType<typeof _fieldOwner.when>, ReadRule>>;

type CompileSuccess = Extract<
  ReturnType<typeof compileReadAuthorizationResult>,
  { readonly _tag: "Success" }
>["success"];
export type _compileResultIsTemplate = Expect<Equal<CompileSuccess, PolicyTemplateIR>>;
export type _inputHasRules = Expect<Extends<CompileReadAuthorizationInput["rules"], readonly ReadRule[]>>;

void User;
void Issue;
void Taggable;
void Schema;
