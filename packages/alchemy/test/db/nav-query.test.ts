/**
 * Runtime tests for the navigational query surface (issue #18 minimum slice).
 */

import { describe, expect, test } from "bun:test";
import {
  Connection,
  QueryError,
  QueryParseError,
  TxError,
  fromJson,
  normalizePullPattern,
  pull,
  query as coreQuery,
  toJson,
} from "@ripple/core";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import {
  Attr,
  Catalog,
  Databases,
  Instant,
  Namespace,
  Ref,
  cardsOf,
  finalizeNavResult,
  pathOf,
  layer,
  lowerNavQuery,
  not,
  or,
  query,
  revsOf,
  type WhereNode,
} from "../../src/db/internal.ts";

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);

interface Reply {
  status: number;
  body: unknown;
}

const inProcessPeer = async () => {
  const conn = await Connection.create();
  /** Every op the peer answered, with the row count it sent back. */
  const seen: { op: string; body: any; rows?: number }[] = [];

  const answer = async (op: string, body: any): Promise<Reply> => {
    const call: (typeof seen)[number] = { op, body };
    seen.push(call);
    try {
      if (op === "transact") {
        const rep = await conn.transact(body.tx);
        return {
          status: 200,
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.length,
          },
        };
      }
      if (op === "q") {
        const db = conn.db();
        const result = await coreQuery(db, body.query, body.inputs ?? []);
        call.rows = Array.isArray(result) ? result.length : -1;
        return {
          status: 200,
          body: { t: db.effectiveT, root: db.effectiveT, result },
        };
      }
      if (op === "pull") {
        const db = conn.db();
        const pattern = normalizePullPattern(body.pattern);
        const eid =
          typeof body.eid === "number" ? body.eid : await db.entid(body.eid);
        if (eid === undefined) {
          return { status: 200, body: { t: db.effectiveT, result: null } };
        }
        return {
          status: 200,
          body: { t: db.effectiveT, result: await pull(db, eid, pattern) },
        };
      }
      return { status: 404, body: { error: `no such op ${op}` } };
    } catch (err) {
      if (err instanceof TxError) {
        return {
          status: 409,
          body: { error: err.message, tag: "TxRejected", code: err.code },
        };
      }
      if (err instanceof QueryParseError || err instanceof QueryError) {
        return { status: 400, body: { error: err.message } };
      }
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body =
      init.body === undefined ? {} : fromJson(JSON.parse(String(init.body)));
    const op = path.endsWith("/transact")
      ? "transact"
      : path.endsWith("/query")
        ? "q"
        : "pull";
    const reply = await answer(op, body);
    return new Response(JSON.stringify(toJson(reply.body)), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  function WebSocketImpl(this: unknown, _url: string) {
    const listeners = new Map<string, ((ev: any) => void)[]>();
    const emit = (type: string, ev: unknown) => {
      for (const cb of listeners.get(type) ?? []) cb(ev);
    };
    const socket = {
      readyState: 0,
      addEventListener: (type: string, cb: (ev: any) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), cb]);
      },
      send: (data: string) => {
        const frame = fromJson(JSON.parse(data)) as any;
        void answer(frame.op, frame).then((reply) =>
          emit("message", {
            data: JSON.stringify({
              id: frame.id,
              status: reply.status,
              body: toJson(reply.body),
            }),
          }),
        );
      },
      close: () => emit("close", {}),
    };
    queueMicrotask(() => emit("open", {}));
    return socket;
  }

  const runtime = ManagedRuntime.make(
    layer({
      url: "https://peer.local",
      fetch: fetchImpl,
      webSocket: WebSocketImpl as unknown as typeof WebSocket,
    }),
  );

  return {
    ripple: runtime.runSync(Databases),
    seen,
    dispose: () => runtime.dispose(),
  };
};

const User = Namespace("user", {
  name: Attr(Schema.String),
  friends: Attr(Ref.self, { cardinality: "many" }),
});

const Todo = Namespace("todo", {
  title: Attr(Schema.String),
  done: Attr(Schema.Boolean),
  due: Attr(Instant),
  owner: Attr(Ref(() => User)),
});

const Todos = Catalog({ user: User, todo: Todo });

describe("nav query", () => {
  test("Todo.owner.name path + lowerer", () => {
    const q = query(Todo)
      .where(Todo.done.eq(false), Todo.owner.name.startsWith("A"))
      .select({
        title: Todo.title,
        owner: Todo.owner.select({ name: User.name }),
      })
      .orderBy(Todo.due, "asc", { empty: "last" })
      .limit(20);

    const pred = Todo.owner.name.startsWith("A");
    expect(pred.path).toEqual([":todo/owner", ":user/name"]);
    expect(pred.op).toBe("startsWith");
    expect(pred.value).toBe("A");

    const lowered = lowerNavQuery(q.build());
    expect(Array.isArray(lowered.query.find[0])).toBe(true);
    expect((lowered.query.find[0] as unknown[])[0]).toBe("pull");
    expect(lowered.pullMap).toBeDefined();
    expect(
      lowered.query.where.some((c) => Array.isArray(c) && c[0] === "or"),
    ).toBe(true);
  });

  test("db.q navigational find-pull end to end", async () => {
    const peer = await inProcessPeer();
    const db = peer.ripple.db("todos", Todos);

    await run(db.install());
    await run(
      db.transact(function* (tx) {
        const alice = yield* tx.entity();
        yield* alice.add(User.name, "Alice");
        const bob = yield* tx.entity();
        yield* bob.add(User.name, "Bob");
        const t1 = yield* tx.entity();
        yield* t1.add(Todo.title, "ship");
        yield* t1.add(Todo.done, false);
        yield* t1.add(Todo.owner, alice.eid as never);
        yield* t1.add(Todo.due, new Date("2026-01-02"));
        const t2 = yield* tx.entity();
        yield* t2.add(Todo.title, "done already");
        yield* t2.add(Todo.done, true);
        yield* t2.add(Todo.owner, bob.eid as never);
        const t3 = yield* tx.entity();
        yield* t3.add(Todo.title, "also open");
        yield* t3.add(Todo.done, false);
        yield* t3.add(Todo.owner, bob.eid as never);
        yield* t3.add(Todo.due, new Date("2026-01-01"));
      }),
    );

    const openTodos = query(Todo)
      .where(Todo.done.eq(false))
      .orderBy(Todo.due, "asc", { empty: "last" })
      .select({
        title: Todo.title,
        due: Todo.due.optional,
        owner: Todo.owner.select({ name: User.name }),
      })
      .limit(20);

    const rows = await run(db.q(openTodos));
    expect(rows.map((r) => r.title)).toEqual(["also open", "ship"]);
    expect(rows[0]?.owner).toEqual({ name: "Bob" });
    expect(rows[1]?.owner).toEqual({ name: "Alice" });

    const aliceOnly = await run(
      db.q(
        query(Todo)
          .where(Todo.done.eq(false), Todo.owner.name.startsWith("A"))
          .select({ title: Todo.title }),
      ),
    );
    expect(aliceOnly).toEqual([{ title: "ship" }]);

    await peer.dispose();
  });
});

/** The scope clause every `:todo/*` query carries. */
const todoScope = [
  "or",
  ["?e", ":todo/title", "_"],
  ["?e", ":todo/done", "_"],
  ["?e", ":todo/due", "_"],
  ["?e", ":todo/owner", "_"],
];

describe("lowering: everything that changes the row set is the peer's", () => {
  test("order / limit / offset ride in the AST, `empty` always explicit", () => {
    const { query: q } = lowerNavQuery(
      query(Todo)
        .orderBy(Todo.due, "desc")
        .orderBy(Todo.title, "asc", { empty: "first" })
        .offset(5)
        .limit(20)
        .select({ title: Todo.title })
        .build(),
    );
    expect(q.order).toEqual([
      { var: "?o0", dir: "desc", empty: "last" },
      { var: "?o1", dir: "asc", empty: "first" },
    ]);
    expect(q.limit).toBe(20);
    expect(q.offset).toBe(5);
    // a sort key binds without dropping the rows that lack it: walk the
    // path, or prove it absent and ground null for the engine to place
    expect(q.where).toEqual([
      todoScope,
      ["?e", ":todo/title", "_"],
      [
        "or-join",
        ["?e", "?o0"],
        ["and", ["?e", ":todo/due", "?o0"]],
        ["and", ["not", ["?e", ":todo/due", "_"]], [["ground", [null]], ["?o0", "..."]]],
      ],
      [
        "or-join",
        ["?e", "?o1"],
        ["and", ["?e", ":todo/title", "?o1"]],
        ["and", ["not", ["?e", ":todo/title", "_"]], [["ground", [null]], ["?o1", "..."]]],
      ],
    ]);
  });

  test("a query with no order or paging lowers to none", () => {
    const { query: q } = lowerNavQuery(query(Todo).select({ title: Todo.title }).build());
    expect(q).toEqual({
      find: [["pull", "?e", [{ kind: "attr", attr: ":todo/title", reverse: false, as: "title" }]]],
      where: [todoScope, ["?e", ":todo/title", "_"]],
    });
    expect("order" in q || "limit" in q || "offset" in q).toBe(false);
  });

  test("a multi-hop sort key is a join chain in one branch, its absence in the other", () => {
    const { query: q } = lowerNavQuery(
      query(Todo).orderBy(Todo.owner.name).select({ title: Todo.title }).build(),
    );
    expect(q.where.at(-1)).toEqual([
      "or-join",
      ["?e", "?o0"],
      ["and", ["?e", ":todo/owner", "?j1"], ["?j1", ":user/name", "?o0"]],
      [
        "and",
        ["not", ["?e", ":todo/owner", "?j2"], ["?j2", ":user/name", "_"]],
        [["ground", [null]], ["?o0", "..."]],
      ],
    ]);
  });

  test("a path keeps its whole prefix past the second ref hop", () => {
    // `Todo.owner` is a User; `User.friends` is a self-ref; two ref hops in,
    // the path must still start at :todo/owner
    const p = Todo.owner.friends.name.startsWith("A");
    expect(p.path).toEqual([":todo/owner", ":user/friends", ":user/name"]);
    expect(cardsOf(Todo.owner.friends.name)).toEqual(["one", "many", "one"]);
    const { query: q } = lowerNavQuery(query(Todo).where(p).build());
    expect(q.where).toEqual([
      todoScope,
      ["?e", ":todo/owner", "?j0"],
      ["?j0", ":user/friends", "?j1"],
      ["?j1", ":user/name", "?v2"],
      [["starts-with?", "?v2", "A"]],
    ]);
  });

  test("ordering by :db/id sorts on the entity variable itself", () => {
    const { query: q } = lowerNavQuery(
      query(Todo).orderBy(Todo.id, "desc").select({ title: Todo.title }).build(),
    );
    expect(q.order).toEqual([{ var: "?e", dir: "desc", empty: "last" }]);
    expect(q.where).toEqual([todoScope, ["?e", ":todo/title", "_"]]);
  });

  test(":db/id predicates unify or compare the entity variable", () => {
    const eq = lowerNavQuery(query(Todo).where(Todo.id.eq(42)).build()).query.where;
    expect(eq).toEqual([todoScope, [["ground", 42], "?e"]]);
    const gt = lowerNavQuery(query(Todo).where(Todo.id.gt(42)).build()).query.where;
    expect(gt).toEqual([todoScope, [[">", "?e", 42]]]);
    const exists = lowerNavQuery(query(Todo).where(Todo.id.exists()).build()).query.where;
    expect(exists).toEqual([todoScope]);
    expect(() =>
      lowerNavQuery(query(Todo).where(Todo.id.missing()).build()),
    ).toThrow(/not defined on :db\/id/);
  });

  test("required selected fields become where clauses; optional and many do not", () => {
    const { query: q } = lowerNavQuery(
      query(Todo)
        .select({
          id: Todo.id,
          title: Todo.title,
          due: Todo.due.optional,
          owner: Todo.owner.select({
            name: User.name,
            friends: User.friends.select({ name: User.name.optional }),
          }),
        })
        .build(),
    );
    expect(q.where).toEqual([
      todoScope,
      ["?e", ":todo/title", "_"],
      // a required nested select is required through the ref, recursively
      ["?e", ":todo/owner", "?r0"],
      ["?r0", ":user/name", "_"],
    ]);
    // an optional nested select never touches the row set
    const optional = lowerNavQuery(
      query(Todo)
        .select({ owner: Todo.owner.select({ name: User.name }).optional })
        .build(),
    );
    expect(optional.query.where).toEqual([todoScope]);
    // a required ref whose sub-shape is all optional only needs the ref
    const bareRef = lowerNavQuery(
      query(Todo)
        .select({ owner: Todo.owner.select({ name: User.name.optional }) })
        .build(),
    );
    expect(bareRef.query.where).toEqual([todoScope, ["?e", ":todo/owner", "_"]]);
  });

  test("orderBy across a cardinality-many attribute is rejected at build time", () => {
    expect(() => query(User).orderBy(User.friends)).toThrow(/cardinality-many/);
    // through a card-one ref onto a many is still a set, and so is anything past it
    expect(() => query(Todo).orderBy(Todo.owner.friends)).toThrow(/cardinality-many/);
    expect(() => query(Todo).orderBy(Todo.owner.friends.name)).toThrow(
      /orderBy\(:todo\/owner → :user\/friends → :user\/name\) crosses a cardinality-many attribute/,
    );
    // card-one hops are fine
    expect(() => query(Todo).orderBy(Todo.owner.name)).not.toThrow();
  });

  test("finalizeNavResult reshapes rows and never sorts, drops or slices them", () => {
    const q = query(Todo)
      .orderBy(Todo.title, "asc")
      .offset(1)
      .limit(1)
      .select({ title: Todo.title })
      .build();
    const { pullMap } = lowerNavQuery(q);
    // out of order and over the limit on purpose: the peer already did both
    const raw = [[{ title: "b" }], [{ title: "a" }], [{ title: "c" }]];
    expect(finalizeNavResult(raw, pullMap)).toEqual([
      { title: "b" },
      { title: "a" },
      { title: "c" },
    ]);
    // a null pull cell (unreachable once required fields are in :where) is
    // still a row: the client never makes a page shorter than the peer sent
    expect(finalizeNavResult([[{ title: "a" }], [null]], pullMap)).toEqual([
      { title: "a" },
      null,
    ]);
    // no select: bare ids wrap as Eids, same count, same order
    expect(finalizeNavResult([[30], [10], [20]], undefined)).toEqual([
      { id: 30 },
      { id: 10 },
      { id: 20 },
    ]);
  });
});

describe("lowering: in / endsWith / matches / is", () => {
  const whereOf = (...preds: WhereNode[]) =>
    lowerNavQuery(query(Todo).where(...preds).build()).query.where;

  test("`in` binds the value, then filters it with a collection binding", () => {
    expect(whereOf(Todo.title.in(["ship", "also open"]))).toEqual([
      todoScope,
      ["?e", ":todo/title", "?v0"],
      [["ground", ["ship", "also open"]], ["?v0", "..."]],
    ]);
    // through a ref hop the join chain comes first, as ever
    expect(whereOf(Todo.owner.name.in(["Alice"]))).toEqual([
      todoScope,
      ["?e", ":todo/owner", "?j0"],
      ["?j0", ":user/name", "?v1"],
      [["ground", ["Alice"]], ["?v1", "..."]],
    ]);
  });

  test("`in([])` is a clause that matches nothing, on the peer", () => {
    expect(whereOf(Todo.title.in([]))).toEqual([
      todoScope,
      [["ground", []], ["?n0", "..."]],
    ]);
    expect(whereOf(Todo.id.in([]))).toEqual([
      todoScope,
      [["ground", []], ["?n0", "..."]],
    ]);
  });

  test("`in` on `:db/id` filters the entity variable itself", () => {
    expect(whereOf(Todo.id.in([1, 2, { id: 3 }]))).toEqual([
      todoScope,
      [["ground", [1, 2, 3]], ["?e", "..."]],
    ]);
  });

  test("`endsWith` and `matches` lower to the engine's string builtins", () => {
    expect(whereOf(Todo.title.endsWith("ing"))).toEqual([
      todoScope,
      ["?e", ":todo/title", "?v0"],
      [["ends-with?", "?v0", "ing"]],
    ]);
    // `re-find?` takes the pattern first, then the string
    expect(whereOf(Todo.title.matches(/^sh/))).toEqual([
      todoScope,
      ["?e", ":todo/title", "?v0"],
      [["re-find?", "^sh", "?v0"]],
    ]);
    expect(whereOf(Todo.title.matches("^sh"))).toEqual(
      whereOf(Todo.title.matches(/^sh/)),
    );
  });

  test("a flagged RegExp is rejected rather than silently unflagged", () => {
    expect(() => Todo.title.matches(/^sh/i)).toThrow(
      /cannot be lowered|no flags/,
    );
    expect(() => Todo.title.matches(/^sh/g)).toThrow();
  });

  test("`is` names the ref's target, as an eid or an Eid", () => {
    expect(whereOf(Todo.owner.is(42))).toEqual([
      todoScope,
      ["?e", ":todo/owner", 42],
    ]);
    expect(whereOf(Todo.owner.is({ id: 42 }))).toEqual([
      todoScope,
      ["?e", ":todo/owner", 42],
    ]);
    // on `:db/id` it unifies the entity variable, like `eq`
    expect(whereOf(Todo.id.is({ id: 7 }))).toEqual([
      todoScope,
      [["ground", 7], "?e"],
    ]);
    expect(() => Todo.owner.is("nope" as never)).toThrow(/entity id or an Eid/);
  });
});

describe("lowering: or / not scope to the root entity variable", () => {
  const whereOf = (...preds: WhereNode[]) =>
    lowerNavQuery(query(Todo).where(...preds).build()).query.where;

  test("`or` is an or-join on `?e`, so branches need not bind alike", () => {
    expect(
      whereOf(or(Todo.done.eq(true), Todo.owner.name.eq("Alice"))),
    ).toEqual([
      todoScope,
      [
        "or-join",
        ["?e"],
        ["and", ["?e", ":todo/done", true]],
        ["and", ["?e", ":todo/owner", "?j0"], ["?j0", ":user/name", "Alice"]],
      ],
    ]);
  });

  test("`or()` with no branches matches nothing", () => {
    expect(whereOf(or())).toEqual([todoScope, [["ground", []], ["?n0", "..."]]]);
  });

  test("`not` is a not-join on `?e`, and nests", () => {
    expect(whereOf(not(Todo.done.eq(true)))).toEqual([
      todoScope,
      ["not-join", ["?e"], ["?e", ":todo/done", true]],
    ]);
    // not(missing) — the double negative the engine reads as "present"
    expect(whereOf(not(Todo.due.missing()))).toEqual([
      todoScope,
      ["not-join", ["?e"], ["not", ["?e", ":todo/due", "_"]]],
    ]);
    expect(whereOf(not(or(Todo.done.eq(true), Todo.due.missing())))).toEqual([
      todoScope,
      [
        "not-join",
        ["?e"],
        [
          "or-join",
          ["?e"],
          ["and", ["?e", ":todo/done", true]],
          ["and", ["not", ["?e", ":todo/due", "_"]]],
        ],
      ],
    ]);
  });

  test("or of not, and nested or, keep their branch-local join variables", () => {
    expect(
      whereOf(
        or(
          not(Todo.owner.name.eq("Alice")),
          or(Todo.owner.name.eq("Bob"), Todo.title.endsWith("!")),
        ),
      ),
    ).toEqual([
      todoScope,
      [
        "or-join",
        ["?e"],
        [
          "and",
          [
            "not-join",
            ["?e"],
            ["?e", ":todo/owner", "?j0"],
            ["?j0", ":user/name", "Alice"],
          ],
        ],
        [
          "and",
          [
            "or-join",
            ["?e"],
            [
              "and",
              ["?e", ":todo/owner", "?j1"],
              ["?j1", ":user/name", "Bob"],
            ],
            ["and", ["?e", ":todo/title", "?v2"], [["ends-with?", "?v2", "!"]]],
          ],
        ],
      ],
    ]);
  });

  test("`not` of a predicate that constrains nothing matches nothing", () => {
    // `:db/id` always exists, so its negation is empty — and the peer says so
    expect(whereOf(not(Todo.id.exists()))).toEqual([
      todoScope,
      [["ground", []], ["?n0", "..."]],
    ]);
  });
});

describe("predicates and combinators end to end: the peer counts the rows", () => {
  const seed = (peer: Awaited<ReturnType<typeof inProcessPeer>>) => {
    const db = peer.ripple.db("todos", Todos);
    return run(
      Effect.gen(function* () {
        yield* db.install();
        yield* db.transact(function* (tx) {
          const alice = yield* tx.entity();
          yield* alice.add(User.name, "Alice");
          const bob = yield* tx.entity();
          yield* bob.add(User.name, "Bob");
          const mk = function* (title: string, done: boolean, owner: unknown) {
            const t = yield* tx.entity();
            yield* t.add(Todo.title, title);
            yield* t.add(Todo.done, done);
            if (owner !== undefined) yield* t.add(Todo.owner, owner as never);
          };
          yield* mk("ship it", false, alice.eid);
          yield* mk("write docs", false, bob.eid);
          yield* mk("done already", true, bob.eid);
          yield* mk("orphan", false, undefined);
        });
        // the eids come back through the query surface itself
        const users = yield* db.q(
          query(User).orderBy(User.name, "asc").select({ id: User.id }),
        );
        return { db, alice: users[0]!.id, bob: users[1]!.id };
      }),
    );
  };

  const titles = async (
    peer: Awaited<ReturnType<typeof inProcessPeer>>,
    db: Awaited<ReturnType<typeof seed>>["db"],
    ...preds: WhereNode[]
  ) => {
    peer.seen.length = 0;
    const rows = await run(
      db.q(
        query(Todo)
          .where(...preds)
          .orderBy(Todo.title, "asc")
          .select({ title: Todo.title }),
      ),
    );
    // the row count is the peer's, not something the client filtered down to
    expect(peer.seen[0]?.rows).toBe(rows.length);
    return rows.map((r) => r.title);
  };

  test("in / endsWith / matches / is run on the peer", async () => {
    const peer = await inProcessPeer();
    const { db, alice } = await seed(peer);

    expect(await titles(peer, db, Todo.title.in(["ship it", "orphan"]))).toEqual(
      ["orphan", "ship it"],
    );
    expect(await titles(peer, db, Todo.title.in([]))).toEqual([]);
    expect(
      await titles(peer, db, Todo.owner.name.in(["Alice", "Nobody"])),
    ).toEqual(["ship it"]);
    expect(await titles(peer, db, Todo.title.endsWith("docs"))).toEqual([
      "write docs",
    ]);
    expect(await titles(peer, db, Todo.title.matches(/^(ship|write)/))).toEqual([
      "ship it",
      "write docs",
    ]);
    expect(await titles(peer, db, Todo.owner.is(alice))).toEqual(["ship it"]);
    expect(await titles(peer, db, Todo.owner.is({ id: alice }))).toEqual([
      "ship it",
    ]);
    // a repeated value in the list is still one row, not two
    expect(
      await titles(peer, db, Todo.title.in(["ship it", "ship it"])),
    ).toEqual(["ship it"]);

    await peer.dispose();
  });

  test("`in` composes with a limit the peer applies after the filter", async () => {
    const peer = await inProcessPeer();
    const { db } = await seed(peer);
    peer.seen.length = 0;
    const rows = await run(
      db.q(
        query(Todo)
          .where(Todo.title.in(["ship it", "write docs", "orphan"]))
          .orderBy(Todo.title, "asc")
          .limit(2)
          .select({ title: Todo.title }),
      ),
    );
    expect(rows.map((r) => r.title)).toEqual(["orphan", "ship it"]);
    expect(peer.seen[0]?.rows).toBe(2);
    await peer.dispose();
  });

  test("or / not run on the peer, and nest", async () => {
    const peer = await inProcessPeer();
    const { db, bob } = await seed(peer);

    expect(
      await titles(peer, db, or(Todo.done.eq(true), Todo.owner.missing())),
    ).toEqual(["done already", "orphan"]);
    expect(await titles(peer, db, not(Todo.done.eq(true)))).toEqual([
      "orphan",
      "ship it",
      "write docs",
    ]);
    // not(missing) is "present"
    expect(await titles(peer, db, not(Todo.owner.missing()))).toEqual([
      "done already",
      "ship it",
      "write docs",
    ]);
    expect(await titles(peer, db, or())).toEqual([]);
    expect(
      await titles(
        peer,
        db,
        not(or(Todo.owner.is(bob), Todo.owner.missing())),
      ),
    ).toEqual(["ship it"]);
    // combinators are conjunctive with the rest of `.where`
    expect(
      await titles(
        peer,
        db,
        Todo.done.eq(false),
        or(Todo.owner.name.eq("Bob"), Todo.title.matches("^or")),
      ),
    ).toEqual(["orphan", "write docs"]);

    await peer.dispose();
  });

  test("`or` branches that bind different variables do not duplicate rows", async () => {
    const peer = await inProcessPeer();
    const { db } = await seed(peer);
    // "write docs" satisfies both branches; it must come back once
    expect(
      await titles(
        peer,
        db,
        or(Todo.owner.name.eq("Bob"), Todo.title.startsWith("write")),
      ),
    ).toEqual(["done already", "write docs"]);
    await peer.dispose();
  });
});

/** The scope clause every `:user/*` query carries. */
const userScope = [
  "or",
  ["?e", ":user/name", "_"],
  ["?e", ":user/friends", "_"],
];

describe("lowering: some / every / none quantify over a many hop", () => {
  const whereOf = (...preds: WhereNode[]) =>
    lowerNavQuery(query(User).where(...preds).build()).query.where;

  test("`some` is the existential join the hop already was", () => {
    expect(whereOf(User.friends.some(User.name.eq("Ada")))).toEqual([
      userScope,
      ["?e", ":user/friends", "?x0"],
      ["?x0", ":user/name", "Ada"],
    ]);
  });

  test("`none` is the same join, negated on the root", () => {
    expect(whereOf(User.friends.none(User.name.eq("Ada")))).toEqual([
      userScope,
      [
        "not-join",
        ["?e"],
        ["?e", ":user/friends", "?x0"],
        ["?x0", ":user/name", "Ada"],
      ],
    ]);
  });

  test("`every` is `no element fails`: a not-join inside a not-join", () => {
    expect(whereOf(User.friends.every(User.name.startsWith("A")))).toEqual([
      userScope,
      [
        "not-join",
        ["?e"],
        ["?e", ":user/friends", "?x0"],
        [
          "not-join",
          ["?x0"],
          ["?x0", ":user/name", "?v1"],
          [["starts-with?", "?v1", "A"]],
        ],
      ],
    ]);
    // an inner node that constrains nothing holds of every element
    expect(whereOf(User.friends.every(User.id.exists()))).toEqual([userScope]);
  });

  test("the inner node may be a combinator, or another quantifier", () => {
    expect(
      whereOf(User.friends.some(or(User.name.eq("Ada"), User.name.missing()))),
    ).toEqual([
      userScope,
      ["?e", ":user/friends", "?x0"],
      [
        "or-join",
        ["?x0"],
        ["and", ["?x0", ":user/name", "Ada"]],
        ["and", ["not", ["?x0", ":user/name", "_"]]],
      ],
    ]);
    // friends-of-friends: the inner quantifier is rooted at the element
    expect(
      whereOf(User.friends.some(User.friends.none(User.name.eq("Bob")))),
    ).toEqual([
      userScope,
      ["?e", ":user/friends", "?x0"],
      [
        "not-join",
        ["?x0"],
        ["?x0", ":user/friends", "?x1"],
        ["?x1", ":user/name", "Bob"],
      ],
    ]);
  });

  test("quantifiers need a cardinality-many ref to quantify over", () => {
    // the type says `never` for both; these are the runtime guards behind it
    const quantify = (attr: unknown) =>
      (attr as typeof User.friends).some(User.name.eq("Ada"));
    expect(() => quantify(Todo.owner)).toThrow(
      /only a cardinality-many attribute has elements/,
    );
    const Post = Namespace("post", {
      tags: Attr(Schema.String, { cardinality: "many" }),
    });
    expect(() => quantify(Post.tags)).toThrow(/must be a ref/);
  });
});

describe("lowering: reverse refs walk a ref hop backwards", () => {
  const whereOf = (...preds: WhereNode[]) =>
    lowerNavQuery(query(User).where(...preds).build()).query.where;

  test("the path keeps the ref's ident; the hop is reversed and many", () => {
    const back = Todo.owner.reverse;
    expect(pathOf(back)).toEqual([":todo/owner"]);
    expect(cardsOf(back)).toEqual(["many"]);
    expect(revsOf(back)).toEqual([true]);
    // walking on from the backlink continues forwards, in the owning namespace
    expect(pathOf(back.title)).toEqual([":todo/owner", ":todo/title"]);
    expect(cardsOf(back.title)).toEqual(["many", "one"]);
    expect(revsOf(back.title)).toEqual([true, false]);
  });

  test("a reversed hop flips the datom, and nothing else", () => {
    expect(whereOf(Todo.owner.reverse.title.eq("ship"))).toEqual([
      userScope,
      ["?j0", ":todo/owner", "?e"],
      ["?j0", ":todo/title", "ship"],
    ]);
    expect(whereOf(Todo.owner.reverse.exists())).toEqual([
      userScope,
      ["_", ":todo/owner", "?e"],
    ]);
    expect(whereOf(Todo.owner.reverse.missing())).toEqual([
      userScope,
      ["not", ["_", ":todo/owner", "?e"]],
    ]);
  });

  test("a backlink is a many hop, so it quantifies", () => {
    expect(whereOf(Todo.owner.reverse.some(Todo.done.eq(true)))).toEqual([
      userScope,
      ["?x0", ":todo/owner", "?e"],
      ["?x0", ":todo/done", true],
    ]);
    expect(whereOf(Todo.owner.reverse.none(Todo.done.eq(false)))).toEqual([
      userScope,
      [
        "not-join",
        ["?e"],
        ["?x0", ":todo/owner", "?e"],
        ["?x0", ":todo/done", false],
      ],
    ]);
    expect(whereOf(Todo.owner.reverse.every(Todo.done.eq(true)))).toEqual([
      userScope,
      [
        "not-join",
        ["?e"],
        ["?x0", ":todo/owner", "?e"],
        ["not-join", ["?x0"], ["?x0", ":todo/done", true]],
      ],
    ]);
  });

  test("`.reverse.select` is a reverse pull spec, and drops no rows", () => {
    const { query: q } = lowerNavQuery(
      query(User)
        .select({
          name: User.name,
          todos: Todo.owner.reverse.select({ title: Todo.title }),
        })
        .build(),
    );
    expect(q.find).toEqual([
      [
        "pull",
        "?e",
        [
          { kind: "attr", attr: ":user/name", reverse: false, as: "name" },
          {
            kind: "attr",
            attr: ":todo/owner",
            reverse: true,
            as: "todos",
            sub: [
              { kind: "attr", attr: ":todo/title", reverse: false, as: "title" },
            ],
          },
        ],
      ],
    ]);
    // a backlink is a possibly-empty array: it never becomes a required clause
    expect(q.where).toEqual([userScope, ["?e", ":user/name", "_"]]);
  });

  test("a forward hop after a backlink keeps the backlink reversed", () => {
    // `Todo.owner.reverse.owner.name` — from a User: the todos that point at
    // me, then *their* owner, then that owner's name. The first hop stays
    // backwards; the two that follow are ordinary forward hops.
    const path = Todo.owner.reverse.owner.name;
    expect(pathOf(path)).toEqual([
      ":todo/owner",
      ":todo/owner",
      ":user/name",
    ]);
    expect(cardsOf(path)).toEqual(["many", "one", "one"]);
    expect(revsOf(path)).toEqual([true, false, false]);
    // the intermediate ref hop carries the flags too
    expect(revsOf(Todo.owner.reverse.owner)).toEqual([true, false]);

    expect(whereOf(path.eq("Ada"))).toEqual([
      userScope,
      // reversed first, then forward — not a three-hop forward chain
      ["?j0", ":todo/owner", "?e"],
      ["?j0", ":todo/owner", "?j1"],
      ["?j1", ":user/name", "Ada"],
    ]);
  });

  test("a bare backlink in a shape is rejected: ask for a shape", () => {
    expect(() =>
      lowerNavQuery(
        query(User).select({ todos: Todo.owner.reverse }).build(),
      ),
    ).toThrow(/backlinks need a shape/);
  });

  test("orderBy across a backlink is rejected like any many hop", () => {
    expect(() => query(User).orderBy(Todo.owner.reverse)).toThrow(
      /cardinality-many/,
    );
    expect(() => query(User).orderBy(Todo.owner.reverse.title)).toThrow(
      /orderBy\(:todo\/owner → :todo\/title\) crosses a cardinality-many attribute/,
    );
  });
});

describe("quantifiers and backlinks end to end", () => {
  /**
   * Ada — friends [Bob],       todos "a1" done, "a2" done
   * Bob — friends [Ada, Cyd],  todos "b1" open
   * Cyd — friends [],          no todos      (the vacuous-truth case)
   */
  const seed = (peer: Awaited<ReturnType<typeof inProcessPeer>>) => {
    const db = peer.ripple.db("todos", Todos);
    return run(
      Effect.gen(function* () {
        yield* db.install();
        yield* db.transact(function* (tx) {
          const ada = yield* tx.entity();
          yield* ada.add(User.name, "Ada");
          const bob = yield* tx.entity();
          yield* bob.add(User.name, "Bob");
          const cyd = yield* tx.entity();
          yield* cyd.add(User.name, "Cyd");
          yield* ada.add(User.friends, bob.eid as never);
          yield* bob.add(User.friends, ada.eid as never);
          yield* bob.add(User.friends, cyd.eid as never);
          const mk = function* (title: string, done: boolean, owner: unknown) {
            const t = yield* tx.entity();
            yield* t.add(Todo.title, title);
            yield* t.add(Todo.done, done);
            yield* t.add(Todo.owner, owner as never);
          };
          yield* mk("a1", true, ada.eid);
          yield* mk("a2", true, ada.eid);
          yield* mk("b1", false, bob.eid);
        });
        return db;
      }),
    );
  };

  const names = async (
    peer: Awaited<ReturnType<typeof inProcessPeer>>,
    db: Awaited<ReturnType<typeof seed>>,
    ...preds: WhereNode[]
  ) => {
    peer.seen.length = 0;
    const rows = await run(
      db.q(
        query(User)
          .where(...preds)
          .orderBy(User.name, "asc")
          .select({ name: User.name }),
      ),
    );
    expect(peer.seen[0]?.rows).toBe(rows.length);
    return rows.map((r) => r.name);
  };

  test("some / every / none over a card-many ref, on the peer", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);

    expect(await names(peer, db, User.friends.some(User.name.eq("Ada")))).toEqual(
      ["Bob"],
    );
    expect(await names(peer, db, User.friends.none(User.name.eq("Cyd")))).toEqual(
      ["Ada", "Cyd"],
    );
    // Cyd has no friends at all, and `every` is true of nothing
    expect(
      await names(peer, db, User.friends.every(User.name.startsWith("B"))),
    ).toEqual(["Ada", "Cyd"]);
    // friends-of-friends: the inner quantifier is rooted at the element
    expect(
      await names(peer, db, User.friends.some(User.friends.some(User.name.eq("Cyd")))),
    ).toEqual(["Ada"]);

    await peer.dispose();
  });

  test("a backlink filters, and `every` over it is vacuously true", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);

    expect(await names(peer, db, Todo.owner.reverse.exists())).toEqual([
      "Ada",
      "Bob",
    ]);
    expect(await names(peer, db, Todo.owner.reverse.missing())).toEqual(["Cyd"]);
    expect(
      await names(peer, db, Todo.owner.reverse.title.eq("b1")),
    ).toEqual(["Bob"]);
    expect(
      await names(peer, db, Todo.owner.reverse.some(Todo.done.eq(false))),
    ).toEqual(["Bob"]);
    // Ada's todos are all done; Cyd has none, so nothing of hers fails
    expect(
      await names(peer, db, Todo.owner.reverse.every(Todo.done.eq(true))),
    ).toEqual(["Ada", "Cyd"]);
    expect(
      await names(peer, db, Todo.owner.reverse.none(Todo.done.eq(false))),
    ).toEqual(["Ada", "Cyd"]);

    await peer.dispose();
  });

  test("a forward hop after a backlink runs backwards-then-forwards", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);

    // `Todo.owner.reverse.owner.name` from a User: the todos that point at me,
    // then their owner, then that owner's name. `:todo/owner` is card-one, so
    // that owner *is* me — the path means "I own a todo, and I am named X".
    // Lowered as three forward hops (the bug) no user matches at all, because
    // a user has no `:todo/owner` datom of its own.
    expect(
      await names(peer, db, Todo.owner.reverse.owner.name.eq("Ada")),
    ).toEqual(["Ada"]);
    expect(
      await names(peer, db, Todo.owner.reverse.owner.name.eq("Bob")),
    ).toEqual(["Bob"]);
    // Cyd owns no todo, so there is no backlink to walk forwards from
    expect(
      await names(peer, db, Todo.owner.reverse.owner.name.eq("Cyd")),
    ).toEqual([]);

    await peer.dispose();
  });

  test("a backlink in a shape is an array, empty rather than a dropped row", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);
    peer.seen.length = 0;

    const rows = await run(
      db.q(
        query(User)
          .orderBy(User.name, "asc")
          .select({
            name: User.name,
            todos: Todo.owner.reverse.select({ title: Todo.title }),
          }),
      ),
    );
    expect(
      rows.map((r) => ({
        name: r.name,
        todos: r.todos.map((t) => t.title).sort(),
      })),
    ).toEqual([
      { name: "Ada", todos: ["a1", "a2"] },
      { name: "Bob", todos: ["b1"] },
      // no backlinks is an empty array, not a missing row
      { name: "Cyd", todos: [] },
    ]);
    expect(peer.seen[0]?.rows).toBe(3);

    await peer.dispose();
  });

  test("a backlink paged by the peer still counts whole rows", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);
    peer.seen.length = 0;
    const rows = await run(
      db.q(
        query(User)
          .where(Todo.owner.reverse.exists())
          .orderBy(User.name, "desc")
          .limit(1)
          .select({
            name: User.name,
            todos: Todo.owner.reverse.select({ title: Todo.title }),
          }),
      ),
    );
    expect(rows.map((r) => r.name)).toEqual(["Bob"]);
    expect(peer.seen[0]?.rows).toBe(1);
    await peer.dispose();
  });
});

describe("paging end to end: the peer pages, the client keeps what it gets", () => {
  const seed = (peer: Awaited<ReturnType<typeof inProcessPeer>>) => {
    const db = peer.ripple.db("todos", Todos);
    return run(
      Effect.gen(function* () {
        yield* db.install();
        yield* db.transact(function* (tx) {
          const alice = yield* tx.entity();
          yield* alice.add(User.name, "Alice");
          const bob = yield* tx.entity();
          yield* bob.add(User.name, "Bob");
          const nameless = yield* tx.entity();
          yield* nameless.add(User.friends, alice.eid as never);
          const mk = function* (title: string, due: Date | undefined, owner: unknown) {
            const t = yield* tx.entity();
            yield* t.add(Todo.title, title);
            yield* t.add(Todo.done, false);
            if (due !== undefined) yield* t.add(Todo.due, due);
            if (owner !== undefined) yield* t.add(Todo.owner, owner as never);
          };
          yield* mk("c-bob", new Date("2026-01-03"), bob.eid);
          yield* mk("a-alice", new Date("2026-01-01"), alice.eid);
          yield* mk("d-nobody", undefined, undefined);
          yield* mk("b-nameless", new Date("2026-01-02"), nameless.eid);
        });
        return db;
      }),
    );
  };

  test("offset + limit: the peer returns exactly the page, ordered", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);
    peer.seen.length = 0;

    const page = query(Todo)
      .orderBy(Todo.due, "desc")
      .offset(1)
      .limit(2)
      .select({ title: Todo.title, due: Todo.due.optional });
    const rows = await run(db.q(page));
    expect(rows.map((r) => r.title)).toEqual(["b-nameless", "a-alice"]);

    const [call] = peer.seen;
    expect(call?.op).toBe("q");
    // the wire query carried the paging, and the peer sent back only the page
    expect(call?.body.query).toMatchObject({ offset: 1, limit: 2, order: [{ var: "?o0", dir: "desc", empty: "last" }] });
    expect(call?.rows).toBe(rows.length);
    await peer.dispose();
  });

  test("a sort key behind a missing ref keeps the row and places it per `empty`", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);
    const byOwner = (empty: "first" | "last") =>
      db.q(
        query(Todo)
          .orderBy(Todo.owner.name, "asc", { empty })
          .orderBy(Todo.title, "asc")
          .select({ title: Todo.title }),
      );
    // no owner, and an owner with no name, both have no sort key
    expect((await run(byOwner("last"))).map((r) => r.title)).toEqual([
      "a-alice",
      "c-bob",
      "b-nameless",
      "d-nobody",
    ]);
    expect((await run(byOwner("first"))).map((r) => r.title)).toEqual([
      "b-nameless",
      "d-nobody",
      "a-alice",
      "c-bob",
    ]);
    await peer.dispose();
  });

  test("a required field is the peer's drop, so limit counts kept rows", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);
    peer.seen.length = 0;
    const rows = await run(
      db.q(
        query(Todo)
          .orderBy(Todo.title, "asc")
          .limit(2)
          .select({ title: Todo.title, owner: Todo.owner.select({ name: User.name }) }),
      ),
    );
    // b-nameless (owner without a name) and d-nobody are dropped before the limit
    expect(rows.map((r) => r.title)).toEqual(["a-alice", "c-bob"]);
    expect(peer.seen[0]?.rows).toBe(2);
    await peer.dispose();
  });

  test("no select: an ordered, paged list of Eids", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);
    const all = await run(db.q(query(Todo).orderBy(Todo.title, "asc")));
    const titles = await run(db.q(query(Todo).orderBy(Todo.title, "asc").select({ id: Todo.id, title: Todo.title })));
    expect(all.map((e) => e.id)).toEqual(titles.map((r) => r.id));
    expect(titles.map((r) => r.title)).toEqual(["a-alice", "b-nameless", "c-bob", "d-nobody"]);
    const page = await run(db.q(query(Todo).orderBy(Todo.title, "desc").offset(1).limit(2)));
    expect(page).toEqual([all[2]!, all[1]!]);
    await peer.dispose();
  });
});

