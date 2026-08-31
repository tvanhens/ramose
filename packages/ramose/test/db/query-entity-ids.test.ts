
import { beforeAll, describe, expect, test } from "bun:test";
import {
  Entity,
  Field,
  Long,
  Q,
  Query,
  Ref,
  Schema,
  again,
  all,
  clientRef,
  lowerQueryObject,
  string,
} from "../../src/db/internal.ts";
import { compositionFromSchema, schemaTx } from "../../src/db/internal.ts";
import { Connection } from "../../src/internal/core/conn.ts";
import { restoreEngineTypeAssertions } from "../../src/internal/core/tx-provenance.ts";
import type { Db } from "../../src/internal/core/db.ts";
import { query as runQuery } from "../../src/internal/core/query/engine.ts";

const Author = Entity("author", { name: string() });
const Issue = Entity("issue", {
  title: string(),
  rank: Field(Long),
  author: Ref(Author),
});
const Node = Entity("node", {
  name: string(),
  children: Field.many(Ref.self),
});
const AppSchema = Schema({ author: Author, issue: Issue, node: Node });

let db: Db;
let ids: Record<string, number>;

beforeAll(async () => {
  const conn = await Connection.create({
    composition: compositionFromSchema(AppSchema),
  });
  await conn.transact(schemaTx(AppSchema) as never);
  const seed = [
    { ":db/id": "author", ":ramose/type": ":author", ":author/name": "Ada" },
    {
      ":db/id": "issue",
      ":ramose/type": ":issue",
      ":issue/title": "Offline",
      ":issue/rank": 1_000,
      ":issue/author": "author",
    },
    { ":db/id": "child", ":ramose/type": ":node", ":node/name": "child" },
    {
      ":db/id": "root",
      ":ramose/type": ":node",
      ":node/name": "root",
      ":node/children": ["child"],
    },
  ];
  restoreEngineTypeAssertions(seed);
  const written = await conn.transact(seed as never);
  ids = written.tempids;
  db = conn.db();
});

const opaque = { entity: (eid: number) => `handle:${eid}` };

const rows = async (
  value: unknown,
  lowering?: { readonly entity: (eid: number) => unknown },
): Promise<unknown> => {
  const lowered = lowerQueryObject(value as never, lowering);
  return lowered.finalize(await runQuery(db, lowered.query));
};

describe("entity ids in a lowered projection", () => {
  test("an entity row renders its own id and every nested ref cell", async () => {
    const value = Query.from(Issue);

    expect(await rows(value)).toEqual([{
      id: ids.issue,
      title: "Offline",
      rank: 1_000,
      author: { id: ids.author },
    }]);
    expect(await rows(value, opaque)).toEqual([{
      id: `handle:${ids.issue}`,
      title: "Offline",
      rank: 1_000,
      author: { id: `handle:${ids.author}` },
    }]);
  });

  test("`.ids()` renders the id it exists to return", async () => {
    const value = Query.from(Issue).ids();
    expect(await rows(value)).toEqual([{ id: ids.issue }]);
    expect(await rows(value, opaque)).toEqual([{ id: `handle:${ids.issue}` }]);
  });

  test("a select projection of an id field renders it too, bare as it always was", async () => {
    const value = Query.from(Issue).select({ id: Issue.id, title: Issue.title });
    expect(await rows(value)).toEqual([{ id: ids.issue, title: "Offline" }]);
    expect(await rows(value, opaque))
      .toEqual([{ id: `handle:${ids.issue}`, title: "Offline" }]);
  });

  test("a projected value that is not an id is left alone", async () => {
    const value = Query.from(Issue).select({ rank: Issue.rank });
    expect(await rows(value, opaque)).toEqual([{ rank: 1_000 }]);
  });

  test("rendering is read at finalize time, so one lowering follows its value", async () => {
    let generation = 0;
    const lowered = lowerQueryObject(Query.from(Issue).ids() as never, {
      entity: (eid) => `generation-${generation}:${eid}`,
    });
    const result = await runQuery(db, lowered.query);
    expect(lowered.finalize(result)).toEqual([{ id: `generation-0:${ids.issue}` }]);
    generation = 1;
    expect(lowered.finalize(result)).toEqual([{ id: `generation-1:${ids.issue}` }]);
  });

  test("a wildcard renders its ids too, at every depth", async () => {
    const value = Query.from(Issue).select({ author: Issue.author.select(all(Author)) });
    const [row] = (await rows(value, opaque)) as readonly {
      readonly author: Record<string, unknown>;
    }[];
    expect(row!.author[":db/id"]).toBe(`handle:${ids.author}`);
    expect(row!.author[":author/name"]).toBe("Ada");
  });

  test("a paging cursor carries opaque ids, and only resolves back on this replica", async () => {
    const handles = new Map([[`handle:${ids.issue}`, ids.issue]]);
    const lowering = { ...opaque, resolveEntity: (id: unknown) => handles.get(id as string) };
    const page = lowerQueryObject(
      Query.from(Issue).orderBy(Issue.title).limit(1).after(null) as never,
      lowering,
    );
    const result = (await page.finalize(await runQuery(db, page.query))) as {
      readonly cursor: { readonly keys: readonly unknown[] } | null;
    };
    expect(result.cursor?.keys).toContain(`handle:${ids.issue}`);

    const next = lowerQueryObject(
      Query.from(Issue).orderBy(Issue.title).limit(1).after(result.cursor as never) as never,
      lowering,
    );
    expect((next.query as { after: readonly unknown[] }).after).toContain(ids.issue);

    expect(() =>
      lowerQueryObject(
        Query.from(Issue).orderBy(Issue.title).limit(1).after(
          { _tag: "Cursor", keys: ["Offline", "handle:from-another-replica"] } as never,
        ) as never,
        lowering,
      )
    ).toThrow(/cannot resolve/);
  });

  test("a cursor sorted by a reference carries and resolves an opaque id", async () => {
    const handles = new Map([
      [`handle:${ids.issue}`, ids.issue],
      [`handle:${ids.author}`, ids.author],
    ]);
    const lowering = { ...opaque, resolveEntity: (id: unknown) => handles.get(id as string) };
    const sorted = Query.from(Issue).orderBy(Issue.author).limit(1);

    const page = lowerQueryObject(sorted.after(null) as never, lowering);
    const result = (await page.finalize(await runQuery(db, page.query))) as {
      readonly cursor: { readonly keys: readonly unknown[] } | null;
    };
    const keys = result.cursor?.keys ?? [];
    expect(keys).toContain(`handle:${ids.author}`);
    for (const key of keys) expect(typeof key).not.toBe("number");

    const next = lowerQueryObject(sorted.after(result.cursor as never) as never, lowering);
    expect((next.query as { after: readonly unknown[] }).after).toContain(ids.author);

    expect(() =>
      lowerQueryObject(
        sorted.after({ _tag: "Cursor", keys: [ids.author, ids.issue] } as never) as never,
        lowering,
      )
    ).toThrow(/cannot resolve/);
  });

  test("an entity-valued extremum renders, and a counted one is a count", async () => {
    const smallest = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      return Q.value(Q.min(issue));
    });
    expect(await rows(smallest)).toBe(ids.issue);
    expect(await rows(smallest, opaque)).toBe(`handle:${ids.issue}`);

    const howMany = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      return Q.value(Q.count(issue));
    });
    expect(await rows(howMany, opaque)).toBe(1);
  });

  test("a reference named without an expansion renders too", async () => {
    const bare = Query.from(Issue).select({ author: Issue.author });
    expect(await rows(bare)).toEqual([{ author: { ":db/id": ids.author } }]);
    expect(await rows(bare, opaque))
      .toEqual([{ author: { ":db/id": `handle:${ids.author}` } }]);

    expect(await rows(Query.from(Issue).select({ rank: Issue.rank }), opaque))
      .toEqual([{ rank: 1_000 }]);
  });

  test("an aggregate over a select extras record renders its focus", async () => {
    const value = Query.from(Issue).select(
      { title: Issue.title },
      { newest: Q.max(Q.focus) },
    );
    expect(await rows(value, opaque))
      .toEqual([{ title: "Offline", newest: `handle:${ids.issue}` }]);
  });

  test("a recursive pull renders every descendant's id under its own alias", async () => {
    const value = Query.from(Node).where({ name: "root" }).select({
      id: Node.id,
      name: Node.name,
      children: Node.children.select(again(2), { limit: 10 }),
    });
    const [row] = (await rows(value, opaque)) as readonly {
      readonly id: unknown;
      readonly children: readonly { readonly id: unknown; readonly children: readonly unknown[] }[];
    }[];
    expect(row!.id).toBe(`handle:${ids.root}`);
    expect(row!.children.map((child) => child.id))
      .toEqual([`handle:${ids.child}`]);
  });

  test("a row's shape is the same through `.one()`, a list, and a page", () => {
    const list = lowerQueryObject(Query.from(Issue) as never, opaque);
    const one = lowerQueryObject(Query.from(Issue).one() as never, opaque);
    const page = lowerQueryObject(
      Query.from(Issue).orderBy(Issue.title).after(null) as never,
      opaque,
    );

    expect(one.rowShape).toBe(list.rowShape);
    expect(page.rowShape).toBe(list.rowShape);
    expect(one.shape).not.toBe(list.shape);
    expect(page.shape).not.toBe(list.shape);
    expect([list.result, one.result, page.result]).toEqual(["rows", "row", "page"]);
    expect(lowerQueryObject(Query.from(Issue).ids() as never, opaque).rowShape)
      .not.toBe(list.rowShape);
  });

  test("a row with no public identity fails the query rather than leaking the number", async () => {
    const lowered = lowerQueryObject(Query.from(Issue).ids() as never, {
      entity: () => {
        throw new Error("no opaque identity");
      },
    });
    const result = await runQuery(db, lowered.query);
    expect(() => lowered.finalize(result)).toThrow("no opaque identity");
  });
});

/** A well-formed sealed handle: 54 base64url characters and a canonical tail. */
const sealed = (seed: string): string => `${seed.repeat(54).slice(0, 54)}A`;

describe("entity identities at a filter position", () => {
  const bind = (entries: Record<string, number>) => {
    const handles = new Map(Object.entries(entries));
    return {
      ...opaque,
      resolveEntity: (id: unknown) => handles.get(id as string),
    };
  };

  const binding = () =>
    bind({
      [`handle:${ids.author}`]: ids.author!,
      [`handle:${ids.issue}`]: ids.issue!,
    });

  test("a reference filter resolves the identity a row published", async () => {
    const listing = Query.from(Issue).where({
      author: `handle:${ids.author}` as never,
    });

    expect(await rows(listing, binding())).toEqual([{
      id: `handle:${ids.issue}`,
      title: "Offline",
      rank: 1_000,
      author: { id: `handle:${ids.author}` },
    }]);
  });

  test("the row cell itself filters, past the `{ id }` it is wrapped in", async () => {
    const listing = Query.from(Issue).where({
      author: { id: `handle:${ids.author}` } as never,
    });

    expect(await rows(listing, binding())).toHaveLength(1);
  });

  test("a filter stage takes the same identity the object literal does", async () => {
    const listing = Query.from(Issue).where(
      Query.is(Issue.author, `handle:${ids.author}` as never),
    );

    expect(await rows(listing, binding())).toHaveLength(1);
  });

  test("an identity filters the focus itself, through `id` and through `byId`", async () => {
    const byField = Query.from(Issue).where({ id: `handle:${ids.issue}` as never });
    const byStage = Query.from(Issue).where(
      Query.byId(`handle:${ids.issue}` as never),
    );

    expect(await rows(byField, binding())).toHaveLength(1);
    expect(await rows(byStage, binding())).toHaveLength(1);
  });

  test("an identity this replica cannot place answers nothing, and never as a literal", async () => {
    const stranger = sealed("z");
    const listing = Query.from(Issue).where({ author: stranger as never });
    const lowered = lowerQueryObject(listing as never, binding());

    expect(JSON.stringify(lowered.query)).not.toContain(stranger);
    expect(await rows(listing, binding())).toEqual([]);
  });

  test("an identity issued to another replica is not visible here, which is not an error", async () => {
    const elsewhere = bind({ [sealed("w")]: ids.author! });
    const listing = Query.from(Issue).where({ author: sealed("v") as never });

    expect(await rows(listing, elsewhere)).toEqual([]);
  });

  test("the same query stops being empty once the replica holds the entity", async () => {
    const listing = Query.from(Issue).where({ author: sealed("p") as never });

    expect(await rows(listing, bind({}))).toEqual([]);
    expect(await rows(listing, bind({ [sealed("p")]: ids.author! })))
      .toHaveLength(1);
  });

  test("a client ref answers wherever the client can place it", async () => {
    const ref = clientRef();
    const listing = Query.from(Issue).where({ author: ref as never });

    expect(await rows(listing, bind({ [ref]: ids.author! }))).toHaveLength(1);
    expect(await rows(listing, bind({}))).toEqual([]);
  });

  test("an unplaceable identity inside or / not is one arm that fails, not a broken query", async () => {
    const either = Query.from(Issue).where(
      Query.any(
        Query.is(Issue.author, `handle:${ids.author}` as never),
        Query.is(Issue.author, sealed("q") as never),
      ),
    );
    expect(await rows(either, binding())).toHaveLength(1);

    const notStranger = Query.from(Issue).where(
      Query.not(Query.is(Issue.author, sealed("q") as never)),
    );
    expect(await rows(notStranger, binding())).toHaveLength(1);

    const notAda = Query.from(Issue).where(
      Query.not(Query.is(Issue.author, `handle:${ids.author}` as never)),
    );
    expect(await rows(notAda, binding())).toEqual([]);
  });

  test("a lowering reports whether it read the binding at all", () => {
    const plain = lowerQueryObject(
      Query.from(Issue).where({ title: "Offline" }) as never,
      binding(),
    );
    const bound = lowerQueryObject(
      Query.from(Issue).where({ author: sealed("p") as never }) as never,
      binding(),
    );

    expect(plain.bindsEntities).toBe(false);
    expect(bound.bindsEntities).toBe(true);
  });

  test("`Q.in` keeps the members this replica can place and drops the rest", async () => {
    const authored = (members: readonly string[]) =>
      Query.q(function* () {
        const issue = yield* Query.entities(Issue);
        const author = yield* Q.fact(issue, Issue.author);
        yield* Q.in(author.v, members as never);
        return { id: issue };
      });

    expect(
      await rows(authored([`handle:${ids.author}`, sealed("q")]), binding()),
    ).toHaveLength(1);
    expect(await rows(authored([sealed("q")]), binding())).toEqual([]);
  });

  test("an identity where no entity can be held is refused, not answered emptily", () => {
    expect(() =>
      lowerQueryObject(
        Query.from(Issue).where({ title: sealed("p") as never }) as never,
        binding(),
      )
    ).toThrow(/an entity identity is not a value/);

    expect(() =>
      lowerQueryObject(
        Query.from(Issue).where(
          Query.startsWith(Issue.title, clientRef() as never),
        ) as never,
        binding(),
      )
    ).toThrow(/an entity identity is not a value/);
  });

  test("a reference filter needs a replica to resolve against", () => {
    expect(() =>
      lowerQueryObject(
        Query.from(Issue).where({ author: sealed("p") as never }) as never,
      )
    ).toThrow(/only meaningful against the replica/);
  });

  test("a reference position takes an entity, and says so when given something else", () => {
    expect(() =>
      lowerQueryObject(
        Query.from(Issue).where({ author: { name: "Ada" } as never }) as never,
        binding(),
      )
    ).toThrow(/takes an entity/);
  });

  test("a pull-phase filter says it cannot resolve one, rather than matching nothing", () => {
    const nested = (where: readonly unknown[]) => () =>
      Query.from(Node).select({
        children: Node.children.select({ name: Node.name }, {
          where: where as never,
        }),
      });

    expect(nested([Query.is(Node.name, sealed("p") as never)]))
      .toThrow(/before any replica binding exists/);
    expect(nested([Query.is(Node.name, { id: sealed("p") } as never)]))
      .toThrow(/before any replica binding exists/);
    expect(
      nested([(v: never) => Q.in(v, [clientRef()] as never)]),
    ).toThrow(/before any replica binding exists/);
  });
});
