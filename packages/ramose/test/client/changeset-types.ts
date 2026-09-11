import * as S from "effect/Schema";
import { Entity, Schema, string } from "../../src/db/index.ts";
import { createClient } from "../../src/client/index.ts";
import type { EntityId } from "../../src/db/refs.ts";

const Task = Entity("plannedTask", { title: string() }, { operations: (Operation) => ({
  rename: Operation({ input: S.Struct({ title: S.String }), output: S.Struct({}), run: () => ({}) }),
  create: Operation({ self: false, input: S.Struct({ title: S.String }), output: S.Struct({}), run: () => ({}) }),
}) });
const App = Schema("planned-app", { plannedTask: Task });

export const types = async (id: EntityId<typeof Task>) => {
  const client = createClient({ url: "https://example.com", database: "app", schema: App, auth: () => ({ token: "token", cacheKey: "key" }) });
  const operations = client.changesets.operations(Task);
  operations.create({ title: "new" });
  operations.rename(id, { title: "renamed" });
  // @ts-expect-error Transaction input comes from the operation schema.
  operations.rename(id, { title: 42 });
  // @ts-expect-error Targeted transactions require a target.
  operations.rename({ title: "missing target" });
  // @ts-expect-error Only declared operations can be proposed.
  operations.missing(id, {});
  const view = client.changesets.open("proposal", "revision");
  const rows = await view.read(view.query.from(Task));
  operations.rename(rows[0]!.id, { title: rows[0]!.data.title });
  // @ts-expect-error A snapshot entity cannot mutate the live database.
  rows[0]!.mutate.rename({ title: "unsafe" });
  // @ts-expect-error A snapshot has no optimistic client state.
  rows[0]!.local.pending;
};
