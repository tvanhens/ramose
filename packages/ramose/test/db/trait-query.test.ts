/**
 * Trait query roots, refs, asOf/history, live, and read policy
 * (issue #318).
 */

import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { Connection } from "../../src/internal/core/conn.ts";
import {
  Index,
  toWireDatom,
  type WireDatom,
} from "../../src/internal/core/index.ts";
import {
  Entity,
  Field,
  Policy as P,
  Query,
  Ref,
  Schema,
  Trait,
  lowerQueryObject,
  schemaTx,
  seedWrite,
  string,
  txBuilder,
  txOps,
} from "../../src/db/internal.ts";
import {
  filterDb,
  parsePolicy,
  query as coreQuery,
  type Principal,
} from "../../src/internal/core/index.ts";
import { client, fakePeer, settle, until, type Call } from "../peer.ts";

const Taggable = Trait("taggable", {
  tag: string(),
});

const Soft = Trait("soft", {
  note: string({ optional: true }),
  tags: Field.many(string()),
});

const Issue = Entity("issue", { title: string() }, { traits: [Taggable] });
const Doc = Entity("doc", { title: string() }, { traits: [Taggable] });
const Note = Entity("note", { title: string() }, { traits: [Soft] });
const Todo = Entity("todo", { title: string() });
const Favorite = Entity("favorite", { target: Ref(Taggable) });

const Catalog = Schema({
  issue: Issue,
  doc: Doc,
  note: Note,
  todo: Todo,
  favorite: Favorite,
});

const run = <A, E>(value: Effect.Effect<A, E> | Promise<A>): Promise<A> =>
  Effect.isEffect(value) ? Effect.runPromise(value) : value;

const collect = <A, E>(stream: Stream.Stream<A, E>) => {
  const seen: A[] = [];
  let error: unknown;
  const fiber = Effect.runFork(
    Stream.runForEach(stream, (a) => Effect.sync(() => seen.push(a))).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          error = Cause.squash(cause);
        }),
      ),
    ),
  );
  return {
    seen,
    get error() {
      return error;
    },
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
};

const snapshotOf = async (conn: Connection): Promise<{ t: number; datoms: WireDatom[] }> => {
  const datoms: WireDatom[] = [];
  for await (const chunk of conn.db().datoms(Index.EAVT, {})) {
    for (const d of chunk) datoms.push(toWireDatom(d));
  }
  return { t: conn.t, datoms };
};

const rowsOf = async <T>(
  db: Parameters<typeof coreQuery>[0],
  listing: Parameters<typeof lowerQueryObject>[0],
): Promise<readonly T[]> => {
  const { query } = lowerQueryObject(listing);
  const tuples = (await coreQuery(db, query)) as readonly T[][];
  return tuples.map((t) => t[0]!);
};

const open = async () => {
  const conn = await Connection.create();
  await conn.transact(schemaTx(Catalog) as unknown[]);
  return conn;
};

describe("Query.from(Trait)", () => {
  test("membership lowers to :ramose/trait, not field presence", () => {
    const listing = Query.from(Taggable).select({ id: Taggable.id });
    const { query } = lowerQueryObject(listing);
    expect(query.where).toEqual([["isTaggable", "?q0"]]);
    expect(query.rules).toEqual([
      [["isTaggable", "?qm0"], ["?qm0", ":ramose/trait", ":taggable"]],
    ]);
  });

  test("returns every composer, including empty optional/many fields", async () => {
    const conn = await open();
    const tx = txBuilder(Catalog);
    Effect.runSync(tx.put(Issue, { title: "an issue", tag: "urgent" }));
    Effect.runSync(tx.put(Doc, { title: "a doc", tag: "later" }));
    Effect.runSync(tx.put(Note, { title: "empty note" }));
    Effect.runSync(tx.put(Todo, { title: "not taggable" }));
    const { tempids } = await conn.transact([...txOps(tx)]);
    const issueEid = tempids["tmp-1"]!;
    const docEid = tempids["tmp-2"]!;
    const noteEid = tempids["tmp-3"]!;

    const taggable = await rowsOf<{ readonly id: number; readonly tag: string }>(
      conn.db(),
      Query.from(Taggable),
    );
    expect(taggable.map((r) => r.id).sort()).toEqual([issueEid, docEid].sort());
    expect(new Set(Object.keys(taggable[0]!))).toEqual(new Set(["id", "tag"]));

    const emptySoft = await rowsOf<{ readonly id: number }>(
      conn.db(),
      Query.from(Soft).select({ id: Soft.id }),
    );
    expect(emptySoft).toEqual([{ id: noteEid }]);
    const defaultSoft = await rowsOf<Record<string, unknown>>(conn.db(), Query.from(Soft));
    expect(defaultSoft).toHaveLength(1);
    expect(defaultSoft[0]!.id).toBe(noteEid);
    expect("title" in defaultSoft[0]!).toBe(false);
  });

  test("entity-rooted queries filter and select composed fields", async () => {
    const conn = await open();
    const tx = txBuilder(Catalog);
    Effect.runSync(tx.put(Issue, { title: "urgent issue", tag: "urgent" }));
    Effect.runSync(tx.put(Issue, { title: "later issue", tag: "later" }));
    Effect.runSync(tx.put(Doc, { title: "urgent doc", tag: "urgent" }));
    await conn.transact([...txOps(tx)]);

    const issues = await rowsOf<{ readonly title: string; readonly tag: string }>(
      conn.db(),
      Query.from(Issue)
        .where(Query.is(Issue.tag, "urgent"))
        .select({ title: Issue.title, tag: Issue.tag }),
    );
    expect(issues).toEqual([{ title: "urgent issue", tag: "urgent" }]);

    const tagged = await rowsOf<{ readonly id: number; readonly tag: string }>(
      conn.db(),
      Query.from(Taggable).where(Query.is(Taggable.tag, "urgent")),
    );
    expect(tagged).toHaveLength(2);
    expect(new Set(tagged.map((r) => r.tag))).toEqual(new Set(["urgent"]));
  });
});

describe("trait refs", () => {
  test("schemaTx records :ramose/refTarget on a trait ref", () => {
    const tx = schemaTx(Catalog);
    expect(tx.find((op) => ":db/ident" in op && op[":db/ident"] === ":favorite/target")).toEqual({
      ":db/ident": ":favorite/target",
      ":db/valueType": ":db.type/ref",
      ":db/cardinality": ":db.cardinality/one",
      ":ramose/refTarget": ":taggable",
    });
  });

  test("accepts a composer and rejects a non-member", async () => {
    const conn = await open();
    const seed = txBuilder(Catalog);
    Effect.runSync(seed.put(Issue, { title: "an issue", tag: "urgent" }));
    Effect.runSync(seed.put(Todo, { title: "plain" }));
    const { tempids } = await conn.transact([...txOps(seed)]);
    const issueEid = tempids["tmp-1"]!;
    const todoEid = tempids["tmp-2"]!;

    const ok = txBuilder(Catalog);
    Effect.runSync(ok.put(Favorite, { target: issueEid }));
    const fav = await conn.transact([...txOps(ok)]);
    const favEid = fav.tempids["tmp-1"]!;
    expect((await conn.db().entity(favEid))?.[":favorite/target"]).toBe(issueEid);

    const bad = txBuilder(Catalog);
    Effect.runSync(bad.put(Favorite, { target: todoEid }));
    await expect(conn.transact([...txOps(bad)])).rejects.toMatchObject({
      code: "tx/wrong-entity",
      message: expect.stringContaining("is not a taggable"),
    });
  });

  test("same-tx create of a composer plus a favorite is admitted", async () => {
    const conn = await open();
    const tx = txBuilder(Catalog);
    const issue = Effect.runSync(tx.put(Issue, { title: "fresh", tag: "t" }));
    Effect.runSync(tx.put(Favorite, { target: issue }));
    const { tempids } = await conn.transact([...txOps(tx)]);
    const issueEid = tempids["tmp-1"]!;
    const favEid = tempids["tmp-2"]!;
    expect((await conn.db().entity(favEid))?.[":favorite/target"]).toBe(issueEid);
  });

  test("forward pull and backlink through a trait ref", async () => {
    const conn = await open();
    const tx = txBuilder(Catalog);
    const issue = Effect.runSync(tx.put(Issue, { title: "an issue", tag: "urgent" }));
    Effect.runSync(tx.put(Favorite, { target: issue }));
    const { tempids } = await conn.transact([...txOps(tx)]);
    const issueEid = tempids["tmp-1"]!;
    const favEid = tempids["tmp-2"]!;

    const forward = await rowsOf<{
      readonly target: { readonly id: number; readonly tag: string };
    }>(
      conn.db(),
      Query.from(Favorite).select({
        target: Favorite.target.select({
          id: Taggable.id,
          tag: Taggable.tag,
        }),
      }),
    );
    expect(forward).toEqual([{ target: { id: issueEid, tag: "urgent" } }]);

    const back = await rowsOf<{
      readonly id: number;
      readonly favorites: readonly { readonly id: number }[];
    }>(
      conn.db(),
      Query.from(Taggable).select({
        id: Taggable.id,
        favorites: Favorite.target.reverse.select({ id: Favorite.id }),
      }),
    );
    expect(back).toEqual([{ id: issueEid, favorites: [{ id: favEid }] }]);
  });

  test("membership and refs survive asOf and history", async () => {
    const conn = await open();
    const first = txBuilder(Catalog);
    Effect.runSync(first.put(Issue, { title: "an issue", tag: "urgent" }));
    const created = await conn.transact([...txOps(first)]);
    const t1 = created.t;
    const issueEid = created.tempids["tmp-1"]!;

    const second = txBuilder(Catalog);
    Effect.runSync(second.put(Favorite, { target: issueEid }));
    const t2 = (await conn.transact([...txOps(second)])).t;
    const favsNow = await rowsOf<{ readonly id: number }>(
      conn.db(),
      Query.from(Favorite).select({ id: Favorite.id }),
    );
    expect(favsNow).toHaveLength(1);

    const favsThen = await rowsOf<{ readonly id: number }>(
      conn.db().asOf(t1),
      Query.from(Favorite).select({ id: Favorite.id }),
    );
    expect(favsThen).toEqual([]);

    const taggableThen = await rowsOf<{ readonly id: number }>(
      conn.db().asOf(t1),
      Query.from(Taggable).select({ id: Taggable.id }),
    );
    expect(taggableThen.map((r) => r.id)).toEqual([issueEid]);

    const favsAtT2 = await rowsOf<{ readonly id: number }>(
      conn.db().asOf(t2),
      Query.from(Favorite).select({ id: Favorite.id }),
    );
    expect(favsAtT2).toHaveLength(1);

    const favEid = favsNow[0]!.id;
    await conn.transact([[":db/retractEntity", favEid]]);
    expect(
      await rowsOf<{ readonly id: number }>(
        conn.db(),
        Query.from(Favorite).select({ id: Favorite.id }),
      ),
    ).toEqual([]);
    const hist = await conn.db().history().datomsArray(Index.EAVT, {
      e: favEid,
      a: conn.db().attr(":favorite/target")!.id,
    });
    expect(hist.some((d) => d.op === false)).toBe(true);
  });
});

describe("trait read policy", () => {
  const Actor = Entity("actor", { sub: Field.unique(string(), "upsert") });
  const Secret = Entity("secret", { code: string() }, { traits: [Taggable] });
  const PolicyCatalog = Schema({
    actor: Actor,
    issue: Issue,
    secret: Secret,
  });

  const compileView = async (
    arms: Parameters<typeof P.policy>[1],
  ) => {
    const conn = await Connection.create();
    await conn.transact(schemaTx(PolicyCatalog) as unknown[]);
    const seed = txBuilder(PolicyCatalog);
    Effect.runSync(seed.put(Actor, { sub: "a1" }));
    Effect.runSync(seed.put(Issue, { title: "public", tag: "public-tag" }));
    Effect.runSync(seed.put(Secret, { code: "s", tag: "TOP-SECRET" }));
    const { tempids } = await conn.transact([...txOps(seed)]);
    const authored = P.policy(
      {
        schema: PolicyCatalog,
        principal: Actor.sub,
        classes: ["member"] as const,
        schemaClasses: ["member"] as const,
      },
      arms,
    );
    const policy = parsePolicy(JSON.parse(P.compile(authored)));
    const principal: Principal = {
      kind: "user",
      class: "member",
      sub: "a1",
      eid: tempids["tmp-1"]!,
      claims: { sub: "a1" },
      db: "test",
    };
    return {
      conn,
      policy,
      view: filterDb(conn.db(), conn.db(), policy, principal),
      issueEid: tempids["tmp-2"]!,
      secretEid: tempids["tmp-3"]!,
    };
  };

  test("a missing trait arm hides trait fields on an otherwise readable entity", async () => {
    const { view, issueEid, policy } = await compileView({
      actor: { read: true },
      issue: { read: true },
    });
    expect(policy.ns?.taggable).toBeUndefined();
    const issueRow = await view.entity(issueEid);
    expect(issueRow?.[":issue/title"]).toBe("public");
    expect(issueRow?.[":taggable/tag"]).toBeUndefined();
  });

  test("trait read ANDs the entity row rule across composers", async () => {
    const { view, issueEid, secretEid, policy } = await compileView({
      actor: { read: true },
      issue: { read: true },
      traits: { taggable: { read: true } },
    });
    expect(policy.ns?.taggable).toBeDefined();
    expect(policy.ns?.secret).toBeUndefined();

    const issueRow = await view.entity(issueEid);
    expect(issueRow?.[":taggable/tag"]).toBe("public-tag");
    expect(await view.entity(secretEid)).toBeUndefined();

    const listing = Query.from(Taggable).select({ id: Taggable.id, tag: Taggable.tag });
    const { query } = lowerQueryObject(listing);
    const on = (await coreQuery(view, query)) as readonly [
      { readonly id: number; readonly tag: string },
    ][];
    const off = (await coreQuery(view, query, [], { pushdown: false })) as readonly [
      { readonly id: number; readonly tag: string },
    ][];
    expect(on).toEqual([[{ id: issueEid, tag: "public-tag" }]]);
    expect(off).toEqual(on);
  });

  test("a named trait rule does not filter Query.from(Trait) id rows", async () => {
    const Owned = Trait("owned", {
      owner: Ref(() => Actor),
      tag: string(),
    });
    const Ticket = Entity("ticket", { title: string() }, { traits: [Owned] });
    const Catalog = Schema({ actor: Actor, ticket: Ticket });
    const conn = await Connection.create();
    await conn.transact(schemaTx(Catalog) as unknown[]);
    const { tempids } = await conn.transact([
      { ":db/id": "alice", ":actor/sub": "alice" },
      { ":db/id": "bob", ":actor/sub": "bob" },
      {
        ":db/id": "mine",
        ":ticket/title": "alice-ticket",
        ":owned/owner": "alice",
        ":owned/tag": "a",
      },
      {
        ":db/id": "theirs",
        ":ticket/title": "bob-ticket",
        ":owned/owner": "bob",
        ":owned/tag": "b",
      },
    ]);
    const mine = tempids.mine!;
    const theirs = tempids.theirs!;
    const own = (me: P.Me<typeof Actor>) => Query.is(Owned.owner, me);
    const authored = P.policy(
      {
        schema: Catalog,
        principal: Actor.sub,
        classes: ["member"] as const,
        schemaClasses: ["member"] as const,
      },
      {
        actor: { read: true },
        ticket: { read: true },
        traits: { owned: { read: own } },
      },
    );
    const policy = parsePolicy(JSON.parse(P.compile(authored)));
    const principal: Principal = {
      kind: "user",
      class: "member",
      sub: "alice",
      eid: tempids.alice!,
      claims: { sub: "alice" },
      db: "test",
    };
    const view = filterDb(conn.db(), conn.db(), policy, principal);
    const listing = Query.from(Owned).select({ id: Owned.id });
    const { query } = lowerQueryObject(listing);
    const on = (await coreQuery(view, query)) as readonly [{ readonly id: number }][];
    const off = (await coreQuery(view, query, [], { pushdown: false })) as readonly [
      { readonly id: number },
    ][];
    const ids = (rows: readonly [{ readonly id: number }][]) =>
      rows.map((r) => r[0]!.id).sort();
    expect(ids(on)).toEqual([mine, theirs].sort());
    expect(ids(off)).toEqual(ids(on));
    expect((await view.entity(theirs))?.[":owned/tag"]).toBeUndefined();
    expect((await view.entity(mine))?.[":owned/tag"]).toBe("a");
  });

  test("P.field on the trait arm compiles once under ns.taggable", () => {
    const authored = P.policy(
      {
        schema: PolicyCatalog,
        principal: Actor.sub,
        classes: ["member"] as const,
        schemaClasses: ["member"] as const,
      },
      {
        issue: { read: true },
        secret: { read: true },
        traits: {
          taggable: {
            read: true,
            attrs: [P.field(Taggable.tag, { read: P.class("member") }) as never],
          },
        },
      },
    );
    const compiled = JSON.parse(P.compile(authored)) as {
      ns?: Record<string, unknown>;
      attrs: Record<string, unknown>;
    };
    expect(compiled.ns?.taggable).toBeDefined();
    expect(compiled.attrs[":taggable/tag"]).toEqual({
      read: [{ _tag: "allow", class: ["member"], rule: true }],
    });
  });
});

describe("trait live queries", () => {
  test("a write of a composer wakes Query.from(Trait)", async () => {
    const server = await Connection.create();
    await server.transact(schemaTx(Catalog) as unknown[]);
    const http = async (call: Call) => {
      if (call.url.endsWith("/transact")) {
        const rep = await server.transact(call.body.tx);
        return {
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
            clientTxId: call.body.clientTxId,
          },
        };
      }
      if (call.url.endsWith("/query")) {
        const result = await coreQuery(server.db(), call.body.query, call.body.inputs ?? []);
        return { body: { t: server.t, result } };
      }
      return { body: { t: server.t } };
    };
    const peer = fakePeer({ http });
    const c = client(peer);
    const db = c.ramose.db("board", Catalog);
    const listing = Query.from(Taggable).select({ id: Taggable.id, tag: Taggable.tag });
    await run(db.query(listing));
    const snap = await snapshotOf(server);
    peer.socket.push({ op: "resync", t: snap.t, datoms: snap.datoms });
    await settle();

    const live = collect(db.effect.live(listing));
    await until(() => live.seen.length > 0);
    expect(live.seen.at(-1)).toEqual([]);

    await run(
      seedWrite(db, function* (tx) {
        yield* tx.put(Issue, { title: "live issue", tag: "urgent" });
      }),
    );
    await until(() => (live.seen.at(-1) as readonly unknown[] | undefined)?.length === 1);
    const row = (live.seen.at(-1) as readonly { readonly tag: string }[])[0]!;
    expect(row.tag).toBe("urgent");
    expect("title" in row).toBe(false);

    await live.stop();
    await c.dispose();
  });
});
