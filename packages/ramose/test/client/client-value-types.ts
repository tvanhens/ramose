
import type { Eid, Equal, Expect } from "../../src/db/internal.ts";
import { Entity, Field, Query, Ref, string } from "../../src/db/internal.ts";
import type { AllRow } from "../../src/db/Pull.ts";
import type { ClientRef, EntityId, MutationRef } from "../../src/db/refs.ts";
import type { ClientValue, EntityHandle } from "../../src/client/index.ts";
import type { EntityResult } from "../../src/client/graph.ts";

const Issue = Entity("issue", { title: Field(string()) });
type IssueEntity = typeof Issue;

export type _brandedId = Expect<
  Equal<ClientValue<Eid<IssueEntity>>, MutationRef<IssueEntity>>
>;

/** Both halves are reachable, and each is what it says. */
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

/** Both halves of an optional ref cell travel. */
export type _optionalRef = Expect<
  Equal<
    ClientValue<Eid<IssueEntity> | undefined>,
    MutationRef<IssueEntity> | undefined
  >
>;

/**
 * A wildcard row types its id as a plain `number` — there is no namespace at
 * that position to brand it against — so nothing about the *value's* type says
 * it is an identity. The lowering renders it opaquely all the same, which is
 * why the rewrite is by key here.
 */
export type _wildcardId = Expect<
  Equal<ClientValue<AllRow<IssueEntity>>[":db/id"], MutationRef>
>;

/** An unexpanded reference cell is the same shape, one level down. */
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

/** A numeric field is a number, whatever it happens to hold. */
export type _plainNumber = Expect<
  Equal<
    ClientValue<{ readonly rank: number; readonly title: string }>,
    { readonly rank: number; readonly title: string }
  >
>;

/** Values with structure of their own are not walked into. */
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
