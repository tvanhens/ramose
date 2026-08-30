/**
 * Compile-time contract for named client-ref allocation slots (#475).
 * `bun run typecheck` compiles this file.
 */

// @effect-diagnostics floatingEffect:off

import * as Schema from "effect/Schema";
import type { Equal, Expect } from "../../src/db/equal.ts";
import {
  Entity,
  EntityId,
  Operation,
  string,
  type AllocationSlots,
  type ClientRef,
  type EntityRefPath,
} from "../../src/db/internal.ts";

const Issue = Entity("allocIssue", { title: string() });

/** Only entity-reference positions of the declared output are addressable. */
type Output = {
  readonly issue: number;
  readonly nested: { readonly child: number };
  readonly title: string;
};
export type _paths = Expect<
  Equal<EntityRefPath<Output>, readonly ["issue"] | readonly ["nested", "child"]>
>;
export type _none = Expect<Equal<EntityRefPath<{ readonly title: string }>, never>>;

const created = Operation({
  input: Schema.Struct({ title: Schema.String }),
  output: Schema.Struct({
    issue: EntityId,
    nested: Schema.Struct({ child: EntityId }),
  }),
  allocates: { issue: ["issue"], child: ["nested", "child"] },
  run: () => ({ issue: 1, nested: { child: 2 } }),
});
export type _slots = Expect<Equal<typeof created.allocations, AllocationSlots>>;

Operation({
  input: Schema.Struct({}),
  output: Schema.Struct({ title: Schema.String }),
  // @ts-expect-error a title is not an entity-reference position
  allocates: { title: ["title"] },
  run: () => ({ title: "x" }),
});

Operation({
  input: Schema.Struct({}),
  output: Schema.Struct({ issue: EntityId }),
  // @ts-expect-error an output position that does not exist cannot be allocated
  allocates: { issue: ["missing"] },
  run: () => ({ issue: 1 }),
});

/** A client ref is branded by the entity it will name. */
declare const issueRef: ClientRef<typeof Issue>;
export type _brand = Expect<Equal<typeof issueRef & string, ClientRef<typeof Issue>>>;
