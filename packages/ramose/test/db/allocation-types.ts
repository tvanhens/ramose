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

/**
 * Only entity-reference positions of the declared output codec are
 * addressable, and the decision is made on the schema: `count` decodes to the
 * same `number` an `EntityId` does, and is still not a path.
 */
const Output = Schema.Struct({
  issue: EntityId,
  nested: Schema.Struct({ child: EntityId }),
  many: Schema.Array(EntityId),
  title: Schema.String,
  count: Schema.Finite,
});
export type _paths = Expect<
  Equal<
    EntityRefPath<typeof Output>,
    | readonly ["issue"]
    | readonly ["nested", "child"]
    | readonly ["many", number]
  >
>;
export type _none = Expect<
  Equal<EntityRefPath<typeof Schema.Struct<{ title: typeof Schema.String }>>, never>
>;

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
  output: Schema.Struct({ count: Schema.Finite }),
  // @ts-expect-error an ordinary number decodes like an entity id but is not one
  allocates: { count: ["count"] },
  run: () => ({ count: 1 }),
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
