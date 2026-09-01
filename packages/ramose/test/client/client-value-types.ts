import type { Eid, Equal, Expect } from "../../src/db/internal.ts";
import { Entity, Field, Query, Ref, string } from "../../src/db/internal.ts";
import type { AllRow } from "../../src/db/Pull.ts";
import type { ClientRef, EntityId, MutationRef } from "../../src/db/refs.ts";
import type { ClientValue, EntityHandle } from "../../src/client/index.ts";
import type { EntityResult } from "../../src/client/query.ts";

const Issue = Entity("issue", { title: Field(string()) });
type IssueEntity = typeof Issue;

export type _brandedId = Expect<
  Equal<ClientValue<Eid<IssueEntity>>, MutationRef<IssueEntity>>
>;

export type _bothIdentities = Expect<
  Equal<
    ClientValue<Eid<IssueEntity>>,
    EntityId<IssueEntity> | ClientRef<IssueEntity>
  >
>;

export type _brandedRow = Expect<
  Equal<
    ClientValue<{ readonly id: Eid<IssueEntity>; readonly title: string }>,
    { readonly id: MutationRef<IssueEntity>; readonly title: string }
  >
>;

export type _optionalRef = Expect<
  Equal<
    ClientValue<Eid<IssueEntity> | undefined>,
    MutationRef<IssueEntity> | undefined
  >
>;

export type _wildcardId = Expect<
  Equal<ClientValue<AllRow<IssueEntity>>[":db/id"], MutationRef>
>;

export type _unexpandedRef = Expect<
  Equal<
    ClientValue<{ readonly author: { readonly ":db/id": number } }>,
    { readonly author: { readonly ":db/id": MutationRef } }
  >
>;

declare const optionalDbId: ClientValue<{ readonly ":db/id"?: number }>;
export const _optionalDbIdRenders: MutationRef | undefined = optionalDbId[":db/id"];

declare const wildcard: ClientValue<AllRow<IssueEntity>>;
// @ts-expect-error — a rendered identity is not a number
export const _noArithmetic: number = wildcard[":db/id"] + 1;

export type _plainNumber = Expect<
  Equal<
    ClientValue<{ readonly rank: number; readonly title: string }>,
    { readonly rank: number; readonly title: string }
  >
>;

export type _opaqueValues = Expect<
  Equal<ClientValue<{ readonly at: Date; readonly blob: Uint8Array }>, {
    readonly at: Date;
    readonly blob: Uint8Array;
  }>
>;

const Person = Entity("person", { name: Field(string()) });
const Note = Entity("note", { body: Field(string()), author: Ref(Person) });

export type _handleIdentity = Expect<
  Equal<
    EntityResult<typeof Person, unknown, readonly unknown[]>[number]["id"],
    MutationRef<typeof Person>
  >
>;

declare const author: EntityHandle<unknown, unknown, typeof Person>;
Query.from(Note).where({ author: author.id });

declare const stranger: EntityHandle<unknown, unknown, IssueEntity>;
// @ts-expect-error
Query.from(Note).where({ author: stranger.id });
