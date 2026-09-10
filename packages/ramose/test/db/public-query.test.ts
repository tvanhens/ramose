import { expect, test } from "bun:test";
import { Entity, Query, Schema, boolean, string, type Row } from "ramose/db";
import { compositionFromSchema, lowerQueryObject, schemaTx, type Equal, type Expect } from "../../src/db/internal.ts";
import { Connection } from "../../src/internal/core/conn.ts";
import { query as runQuery } from "../../src/internal/core/query/engine.ts";
import { restoreEngineTypeAssertions } from "../../src/internal/core/tx-provenance.ts";

const Task = Entity("public-task", { title: string(), done: boolean() });
const App = Schema("public-query", { "public-task": Task });

const titles = Query.build(function* (q) {
  const task = yield* Query.entities(Task);
  const title = yield* q.fact(task, Task.title);
  return q.rows({ title: title.v });
});
export type PublicTitle = Expect<Equal<Row<typeof titles>["title"], string>>;
const typedRow: Row<typeof titles> = { title: "Ship" };

const named = Query.rule("named", function* (q, task: Query.Var) {
  const title = yield* q.fact(task, Task.title);
  return title.v;
});

const namedTitles = Query.build(function* (q) {
  const task = yield* Query.entities(Task);
  const title = yield* named(task);
  return q.rows({ title });
});

const complete = Query.rule("complete", function* (q) {
  const task = yield* Query.entities(Task);
  yield* q.fact(task, Task.done, true);
  return task;
});

const countComplete = Query.build(function* (q) {
  const task = yield* complete();
  return q.value(q.count(task));
});

test("public queries execute fluent filters, scoped clauses, and parameterized rules", async () => {
  const conn = await Connection.create({ composition: compositionFromSchema(App) });
  await conn.transact(schemaTx(App) as never);
  const seed = [{ ":db/id": "task", ":ramose/type": ":public-task", ":public-task/title": "Ship", ":public-task/done": true }];
  restoreEngineTypeAssertions(seed);
  await conn.transact(seed as never);
  const execute = async (value: Query.AnyQueryObject) => {
    const lowered = lowerQueryObject(value);
    return lowered.finalize(await runQuery(conn.db(), lowered.query));
  };
  expect(await execute(titles)).toEqual([typedRow]);
  expect(await execute(namedTitles)).toEqual([typedRow]);
  expect(await execute(countComplete)).toBe(1);
  expect(await execute(Query.from(Task).where(Query.startsWith(Task.title, "Sh")).select({ title: Task.title }))).toEqual([typedRow]);
  expect(() => named()).toThrow("takes 1 argument");
});
