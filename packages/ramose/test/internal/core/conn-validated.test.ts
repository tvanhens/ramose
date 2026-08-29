import { expect, test } from "bun:test";
import { Connection } from "../../../src/internal/core/conn.ts";

test("validated transaction failure leaves the connection basis untouched", async () => {
  const conn = await Connection.create();
  await conn.transact([
    { ":db/id": "name", ":db/ident": ":item/name", ":db/valueType": ":db.type/string", ":db/cardinality": ":db.cardinality/one", ":db/unique": ":db.unique/identity" },
  ]);
  const beforeT = conn.t;
  await expect(conn.transactValidated(
    [{ ":item/name": "not-committed" }],
    () => {
      throw new Error("report rejected");
    },
  )).rejects.toThrow("report rejected");
  expect(conn.t).toBe(beforeT);
  expect(await conn.db().entid([":item/name", "not-committed"])).toBeUndefined();

  await expect(conn.transactValidated(
    [{ ":item/name": "not-applied" }],
    () => undefined,
    1_700_000_000_000,
    () => {
      throw new Error("pre-apply rejected");
    },
  )).rejects.toThrow("pre-apply rejected");
  expect(conn.t).toBe(beforeT);
  expect(await conn.db().entid([":item/name", "not-applied"])).toBeUndefined();

  const committed = await conn.transactValidated(
    [{ ":item/name": "committed" }],
    ({ dbAfter }) => dbAfter.entid([":item/name", "committed"]),
  );
  expect(committed.value).toBeNumber();
  expect(conn.t).toBe(beforeT + 1);
});

test("default transaction time is sampled when a serialized run begins", async () => {
  let now = 100;
  const conn = await Connection.create({ now: () => now });
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered!: () => void;
  const firstDidEnter = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });

  const first = conn.transactValidated([], async () => {
    firstEntered();
    await firstMayFinish;
  });
  await firstDidEnter;

  now = 200;
  const queued = conn.transact([]);
  now = 300;
  releaseFirst();
  await first;
  const report = await queued;
  const tx = await report.dbAfter.entity(report.txEid);
  expect((tx?.[":db/txInstant"] as Date).getTime()).toBe(300);

  now = 400;
  const explicit = await conn.transactValidated([], () => undefined, 777);
  const explicitTx = await explicit.report.dbAfter.entity(explicit.report.txEid);
  expect((explicitTx?.[":db/txInstant"] as Date).getTime()).toBe(777);
});
