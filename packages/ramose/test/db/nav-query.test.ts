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
} from "../../src/internal/core/index.ts";
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
    ramose: runtime.runSync(Databases),
    seen,
    dispose: () => runtime.dispose(),
  };
};

const User = Namespace("user", {
  name: Attr(Schema.String),
  friends: Attr(Ref.self, { cardinality: "many" }),
  tags: Attr(Schema.String, { cardinality: "many" }),
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
    const db = peer.ramose.db("todos", Todos);

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

describe("a select field is a direct attribute, never a flattened path", () => {
  /**
   * `select({ ownerName: Todo.owner.name })` reads like a join, but a pull
   * field names one attribute of the entity it pulls: lowering it would ask
   * the *todo* for `:user/name`. It is rejected at the type level (see
   * nav-query-types.ts) and here, where the cast defeats the type.
   */
  const hopped = <T>(field: T) => field as never;

  test("a flattened multi-hop field is rejected, with the nested select to write", () => {
    expect(() =>
      lowerNavQuery(
        query(Todo)
          .select({ ownerName: hopped(Todo.owner.name) })
          .build(),
      ),
    ).toThrow(
      `ramose/query: select field "ownerName": Todo.owner.name is a multi-hop path (:todo/owner → :user/name) — a select field must be a direct attribute of the queried namespace. Use a nested select: { owner: Todo.owner.select({ name: User.name }) }`,
    );
  });

  test("`.optional` does not make a hop a direct attribute", () => {
    expect(() =>
      lowerNavQuery(
        query(Todo)
          .select({ ownerName: hopped(Todo.owner.name.optional) })
          .build(),
      ),
    ).toThrow(/multi-hop|nested select/);
  });

  test("a nested select rooted two hops in is rejected too", () => {
    expect(() =>
      lowerNavQuery(
        query(Todo)
          .select({
            friends: hopped(Todo.owner.friends.select({ name: User.name })),
          })
          .build(),
      ),
    ).toThrow(/multi-hop|nested select/);
    // …and so is a backlink walked one hop further
    expect(() =>
      lowerNavQuery(
        query(User)
          .select({ title: hopped(Todo.owner.reverse.title) })
          .build(),
      ),
    ).toThrow(/multi-hop|nested select/);
  });

  test("the nested select the message points at still lowers", () => {
    const { query: q, pullMap } = lowerNavQuery(
      query(Todo)
        .select({
          title: Todo.title,
          owner: Todo.owner.select({ name: User.name }),
        })
        .build(),
    );
    expect(pullMap).toBeDefined();
    expect(q.find).toEqual([
      [
        "pull",
        "?e",
        [
          { kind: "attr", attr: ":todo/title", reverse: false, as: "title" },
          {
            kind: "attr",
            attr: ":todo/owner",
            reverse: false,
            as: "owner",
            sub: [
              { kind: "attr", attr: ":user/name", reverse: false, as: "name" },
            ],
          },
        ],
      ],
    ]);
    // the required halves are the *todo's* attrs, and the ref's target's
    expect(q.where).toEqual([
      todoScope,
      ["?e", ":todo/title", "_"],
      ["?e", ":todo/owner", "?r0"],
      ["?r0", ":user/name", "_"],
    ]);
  });

  /** One hop is still a direct attribute — a backlink shape is not a path. */
  test("a one-hop backlink select is unaffected", () => {
    const { query: q } = lowerNavQuery(
      query(User)
        .select({ todos: Todo.owner.reverse.select({ title: Todo.title }) })
        .build(),
    );
    expect(q.find).toEqual([
      [
        "pull",
        "?e",
        [
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
    const db = peer.ramose.db("todos", Todos);
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
  ["?e", ":user/tags", "_"],
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

  test("quantifiers need a cardinality-many attribute to quantify over", () => {
    // the type says `never`; this is the runtime guard behind it
    const quantify = (attr: unknown) =>
      (attr as typeof User.friends).some(User.name.eq("Ada"));
    expect(() => quantify(Todo.owner)).toThrow(
      /only a cardinality-many attribute has elements/,
    );
  });
});

describe("lowering: `.each` is the element of a cardinality-many attribute", () => {
  const whereOf = (...preds: WhereNode[]) =>
    lowerNavQuery(query(User).where(...preds).build()).query.where;
  /** the types reject these; the casts are how the runtime guards are reached */
  const loose = (p: unknown) => p as WhereNode;

  test("a scalar quantifier binds the element and compares it directly", () => {
    // `some` is the existential the bare predicate already was, said out loud
    expect(whereOf(User.tags.some(User.tags.each.eq("a")))).toEqual([
      userScope,
      ["?e", ":user/tags", "?x0"],
      [["=", "?x0", "a"]],
    ]);
    expect(whereOf(User.tags.none(User.tags.each.eq("spam")))).toEqual([
      userScope,
      ["not-join", ["?e"], ["?e", ":user/tags", "?x0"], [["=", "?x0", "spam"]]],
    ]);
    // `every` is `no element fails`, so it is vacuously true of no elements
    expect(whereOf(User.tags.every(User.tags.each.startsWith("a")))).toEqual([
      userScope,
      [
        "not-join",
        ["?e"],
        ["?e", ":user/tags", "?x0"],
        ["not-join", ["?x0"], [["starts-with?", "?x0", "a"]]],
      ],
    ]);
  });

  test("every operator has an element spelling on the bound variable", () => {
    /** the clause one element predicate becomes, inside the hop that binds it */
    const opOf = (p: Parameters<typeof User.tags.some>[0]) =>
      (whereOf(User.tags.some(p)) as any[])[2];
    expect(opOf(User.tags.each.ne("a"))).toEqual([["not=", "?x0", "a"]]);
    expect(opOf(User.tags.each.gt("a"))).toEqual([[">", "?x0", "a"]]);
    expect(opOf(User.tags.each.endsWith("z"))).toEqual([
      ["ends-with?", "?x0", "z"],
    ]);
    expect(opOf(User.tags.each.includes("z"))).toEqual([
      ["includes?", "?x0", "z"],
    ]);
    expect(opOf(User.tags.each.matches(/^a/))).toEqual([
      ["re-find?", "^a", "?x0"],
    ]);
    // `?x0` is bound by the hop, so the collection binding filters it
    expect(opOf(User.tags.each.in(["a", "b"]))).toEqual([
      ["ground", ["a", "b"]],
      ["?x0", "..."],
    ]);
    // the element exists by construction; `in([])` and `missing` match nothing
    expect(whereOf(User.tags.some(User.tags.each.exists()))).toEqual([
      userScope,
      ["?e", ":user/tags", "?x0"],
    ]);
    expect(opOf(User.tags.each.in([]))).toEqual([["ground", []], ["?n1", "..."]]);
    expect(opOf(User.tags.each.missing())).toEqual([
      ["ground", []],
      ["?n1", "..."],
    ]);
  });

  test("combinators nest around element predicates", () => {
    expect(
      whereOf(
        User.tags.every(
          or(User.tags.each.startsWith("a"), User.tags.each.eq("keep")),
        ),
      ),
    ).toEqual([
      userScope,
      [
        "not-join",
        ["?e"],
        ["?e", ":user/tags", "?x0"],
        [
          "not-join",
          ["?x0"],
          [
            "or-join",
            ["?x0"],
            ["and", [["starts-with?", "?x0", "a"]]],
            ["and", [["=", "?x0", "keep"]]],
          ],
        ],
      ],
    ]);
    // and a quantifier is an ordinary where-node, so `or` / `not` take it
    expect(
      whereOf(not(User.tags.every(User.tags.each.startsWith("a")))).length,
    ).toBe(2);
  });

  test("an element cursor is only meaningful inside its own collection", () => {
    // a card-one attribute has no elements to cursor over
    expect(() => (User.name as unknown as typeof User.tags).each).toThrow(
      /only a cardinality-many attribute has elements/,
    );
    // …nor does the element of one
    expect(() => (User.tags.each as unknown as typeof User.tags).each).toThrow(
      /only a cardinality-many attribute has elements/,
    );
    // a foreign element cursor is not in scope, in a quantifier or a where
    expect(() =>
      User.friends.some(loose(User.tags.each.eq("x"))),
    ).toThrow(/User.tags.each is only meaningful inside/);
    expect(() =>
      User.friends.where(loose(User.tags.each.eq("x"))),
    ).toThrow(/User.tags.each is only meaningful inside/);
    // and it is nothing at all in the query's own where or orderBy
    expect(() => query(User).where(loose(User.tags.each.eq("x")))).toThrow(
      /User.tags.each is only meaningful inside/,
    );
    expect(() =>
      query(User).where(or(not(loose(User.tags.each.eq("x"))))),
    ).toThrow(/User.tags.each is only meaningful inside/);
    expect(() =>
      query(User).orderBy(User.tags.each as never),
    ).toThrow(/User.tags.each is only meaningful inside/);
    // a scalar's elements are values: a path predicate has nothing to walk
    expect(() => User.tags.every(loose(User.name.eq("Ada")))).toThrow(
      /elements of a cardinality-many scalar are values/,
    );
    expect(() =>
      User.tags.every(loose(User.friends.some(User.name.eq("Ada")))),
    ).toThrow(/elements of a cardinality-many scalar are values/);
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
    const db = peer.ramose.db("todos", Todos);
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

describe("lowering: nested where / orderBy / limit on a collection", () => {
  const pullOf = (q: Parameters<typeof lowerNavQuery>[0]) =>
    (lowerNavQuery(q).query.find[0] as unknown[])[2] as any[];

  test("a filtered backlink lowers into the nested pull spec, not the query", () => {
    const { query: q } = lowerNavQuery(
      query(User)
        .where(User.name.startsWith("A"))
        .limit(3)
        .select({
          name: User.name,
          todos: Todo.owner.reverse
            .where(Todo.done.eq(false))
            .orderBy(Todo.due, "desc")
            .limit(5)
            .select({ title: Todo.title }),
        })
        .build(),
    );
    expect((q.find[0] as unknown[])[2]).toEqual([
      { kind: "attr", attr: ":user/name", reverse: false, as: "name" },
      {
        kind: "attr",
        attr: ":todo/owner",
        reverse: true,
        as: "todos",
        where: [{ path: [":todo/done"], op: "=", value: false }],
        order: [{ path: [":todo/due"], dir: "desc" }],
        limit: 5,
        sub: [{ kind: "attr", attr: ":todo/title", reverse: false, as: "title" }],
      },
    ]);
    // the outer query is untouched: the collection filter is not a row filter,
    // and the collection is still not a required clause
    expect(q.where).toEqual([
      userScope,
      ["?e", ":user/name", "?v0"],
      [["starts-with?", "?v0", "A"]],
      ["?e", ":user/name", "_"],
    ]);
    expect(q.limit).toBe(3);
    expect(q.order).toBeUndefined();
  });

  test("a forward card-many ref carries where / offset / limit too", () => {
    const spec = pullOf(
      query(User)
        .select({
          friends: User.friends
            .where(User.name.startsWith("A"))
            .orderBy(User.name, "asc", { empty: "first" })
            .offset(1)
            .limit(2)
            .select({ name: User.name }),
        })
        .build(),
    )[0];
    expect(spec).toEqual({
      kind: "attr",
      attr: ":user/friends",
      reverse: false,
      as: "friends",
      where: [{ path: [":user/name"], op: "starts-with?", value: "A" }],
      order: [{ path: [":user/name"], dir: "asc", empty: "first" }],
      offset: 1,
      limit: 2,
      sub: [{ kind: "attr", attr: ":user/name", reverse: false, as: "name" }],
    });
  });

  test("a nested collection never becomes a required clause", () => {
    const { query: q } = lowerNavQuery(
      query(User)
        .select({
          todos: Todo.owner.reverse
            .where(Todo.done.eq(false))
            .select({ title: Todo.title }),
        })
        .build(),
    );
    expect(q.where).toEqual([userScope]);
  });

  test("combinators, multi-hop paths and reversed hops inside a nested where", () => {
    const [spec] = pullOf(
      query(User)
        .select({
          todos: Todo.owner.reverse
            .where(
              or(Todo.done.eq(true), Todo.due.missing()),
              Todo.owner.name.eq("Ada"),
              not(Todo.title.startsWith("draft")),
              Todo.id.in([1, 2]),
            )
            .select({ title: Todo.title }),
        })
        .build(),
    );
    expect(spec.where).toEqual([
      {
        or: [
          { path: [":todo/done"], op: "=", value: true },
          { path: [":todo/due"], op: "missing" },
        ],
      },
      // a multi-hop path walks from the element: todo → owner → name
      { path: [":todo/owner", ":user/name"], op: "=", value: "Ada" },
      { not: { path: [":todo/title"], op: "starts-with?", value: "draft" } },
      { path: [":db/id"], op: "in", value: [1, 2] },
    ]);
  });

  test("`some` is a longer path; `none` is its negation; a reversed hop flags", () => {
    const [spec] = pullOf(
      query(Todo)
        .select({
          // from a Todo element: the todos of my owner (a backlink hop)
          siblings: Todo.owner.reverse
            .where(
              Todo.owner.reverse.some(Todo.done.eq(true)),
              Todo.owner.reverse.none(Todo.title.eq("z")),
            )
            .select({ title: Todo.title }),
        })
        .build(),
    );
    expect(spec.where).toEqual([
      {
        path: [":todo/owner", ":todo/done"],
        reverse: [true, false],
        op: "=",
        value: true,
      },
      {
        not: {
          path: [":todo/owner", ":todo/title"],
          reverse: [true, false],
          op: "=",
          value: "z",
        },
      },
    ]);
  });

  test("`every` inside a nested where is a quantifier the engine walks", () => {
    const [spec] = pullOf(
      query(User)
        .select({
          // my friends all of whose own friends are named A…, and all of whose
          // tags start with "a" — an element with no value at all fails the
          // first, which is exactly what an existential cannot say
          friends: User.friends
            .where(
              User.friends.every(User.name.startsWith("A")),
              User.tags.every(User.tags.each.startsWith("a")),
            )
            .select({ name: User.name }),
        })
        .build(),
    );
    expect(spec.where).toEqual([
      {
        every: {
          path: [":user/friends"],
          pred: { path: [":user/name"], op: "starts-with?", value: "A" },
        },
      },
      {
        every: {
          path: [":user/tags"],
          pred: { path: [], op: "starts-with?", value: "a" },
        },
      },
    ]);
  });

  test("a negation underneath a `some` wraps the hop, rather than folding it", () => {
    const [spec] = pullOf(
      query(User)
        .select({
          friends: User.friends
            .where(
              // `∃x ¬P` — not the negation of an existential, so the hop is an
              // explicit quantifier the engine walks element by element
              User.friends.some(not(User.name.eq("Bob"))),
              User.friends.some(User.friends.none(User.name.eq("Cyd"))),
              User.friends.some(User.tags.every(User.tags.each.eq("a"))),
            )
            .select({ name: User.name }),
        })
        .build(),
    );
    expect(spec.where).toEqual([
      {
        some: {
          path: [":user/friends"],
          pred: { not: { path: [":user/name"], op: "=", value: "Bob" } },
        },
      },
      {
        some: {
          path: [":user/friends"],
          pred: {
            not: { path: [":user/friends", ":user/name"], op: "=", value: "Cyd" },
          },
        },
      },
      {
        some: {
          path: [":user/friends"],
          pred: {
            every: {
              path: [":user/tags"],
              pred: { path: [], op: "=", value: "a" },
            },
          },
        },
      },
    ]);
  });

  test("a card-many scalar carries the same constraints, with an empty path", () => {
    const [spec] = pullOf(
      query(User)
        .select({
          tags: User.tags
            .where(User.tags.each.startsWith("a"))
            .orderBy(User.tags.each, "desc")
            .offset(1)
            .limit(3),
        })
        .build(),
    );
    expect(spec).toEqual({
      kind: "attr",
      attr: ":user/tags",
      reverse: false,
      as: "tags",
      // `path: []` is the value itself — the element of a scalar collection
      where: [{ path: [], op: "starts-with?", value: "a" }],
      order: [{ path: [], dir: "desc" }],
      offset: 1,
      limit: 3,
    });
    // a bare card-many scalar is still the whole collection
    expect(pullOf(query(User).select({ tags: User.tags }).build())[0]).toEqual({
      kind: "attr",
      attr: ":user/tags",
      reverse: false,
      as: "tags",
    });
  });

  test("a scalar collection never becomes a required clause either", () => {
    const { query: q } = lowerNavQuery(
      query(User)
        .select({
          name: User.name,
          tags: User.tags.where(User.tags.each.startsWith("a")).limit(1),
        })
        .build(),
    );
    expect(q.where).toEqual([userScope, ["?e", ":user/name", "_"]]);
  });

  test("what a nested constraint still refuses to say", () => {
    const todos = Todo.owner.reverse;
    // only a cardinality-many attribute has elements
    const constrain = (attr: unknown) =>
      (attr as typeof todos).where(Todo.done.eq(false));
    expect(() => constrain(Todo.owner)).toThrow(
      /where\(\.\.\.\) on :todo\/owner — nested where/,
    );
    expect(() => constrain(User.name)).toThrow(/nested where/);

    // the predicate must be rooted at the element
    expect(() => todos.where(User.name.eq("Ada"))).toThrow(
      /rooted at the collection's element, which is a :todo\/… entity — :user\/name/,
    );
    // …and a scalar element is a value, which no path walks from
    expect(() =>
      User.tags.where(User.name.eq("Ada") as never),
    ).toThrow(/rooted at the collection's element, which is a value/);
    expect(() =>
      User.tags.orderBy(User.name as never),
    ).toThrow(/rooted at the collection's element, which is a value/);
    // a foreign element cursor is out of scope in a nested where or orderBy
    expect(() =>
      todos.where(User.tags.each.eq("x") as never),
    ).toThrow(/User.tags.each is only meaningful inside/);
    expect(() =>
      todos.orderBy(User.tags.each as never),
    ).toThrow(/User.tags.each is only meaningful inside/);

    // a sort key is still a value, not a set
    expect(() => todos.orderBy(Todo.owner.reverse.title as never)).toThrow(
      /crosses a cardinality-many attribute/,
    );

    // a constrained *ref* collection is still a shape, not a bare field
    expect(() =>
      lowerNavQuery(
        query(User).select({ todos: todos.limit(2) as never }).build(),
      ),
    ).toThrow(/filtered collection needs a shape/);
    // …and a scalar one has no shape to ask for
    expect(() =>
      (User.tags.limit(2) as never as typeof todos).select({
        title: Todo.title,
      }),
    ).toThrow(/cardinality-many scalar — its elements are values/);
    // an element cursor is not a select field
    expect(() =>
      lowerNavQuery(
        query(User).select({ tags: User.tags.each as never }).build(),
      ),
    ).toThrow(/is an element cursor, not a select field/);
  });
});

describe("nested collections end to end: filtered on the peer, `[]` never a drop", () => {
  /**
   * Ada — a-old (open, Jan 1), a-open (open, Jan 3), a-done (done, Jan 2)
   * Bob — b-done, b-done2 (both done)  → filters to nothing
   * Cyd — c-open (open, Jan 5); friends [Ada]
   * Ada friends [Bob, Cyd]
   */
  const seed = (peer: Awaited<ReturnType<typeof inProcessPeer>>) => {
    const db = peer.ramose.db("todos", Todos);
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
          yield* ada.add(User.friends, cyd.eid as never);
          yield* cyd.add(User.friends, ada.eid as never);
          const mk = function* (
            title: string,
            done: boolean,
            due: string,
            owner: unknown,
          ) {
            const t = yield* tx.entity();
            yield* t.add(Todo.title, title);
            yield* t.add(Todo.done, done);
            yield* t.add(Todo.due, new Date(due));
            yield* t.add(Todo.owner, owner as never);
          };
          yield* mk("a-old", false, "2026-01-01", ada.eid);
          yield* mk("a-open", false, "2026-01-03", ada.eid);
          yield* mk("a-done", true, "2026-01-02", ada.eid);
          yield* mk("b-done", true, "2026-01-01", bob.eid);
          yield* mk("b-done2", true, "2026-01-04", bob.eid);
          yield* mk("c-open", false, "2026-01-05", cyd.eid);
        });
        return db;
      }),
    );
  };

  test("a filtered backlink pages inside the outer page, and never drops a row", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);
    peer.seen.length = 0;

    const rows = await run(
      db.q(
        query(User)
          .orderBy(User.name, "asc")
          .limit(2)
          .select({
            name: User.name,
            todos: Todo.owner.reverse
              .where(Todo.done.eq(false))
              .orderBy(Todo.due, "asc")
              .limit(1)
              .select({ title: Todo.title }),
          }),
      ),
    );
    expect(rows).toEqual([
      { name: "Ada", todos: [{ title: "a-old" }] },
      // every todo of Bob's filters out — an empty array, not a missing row
      { name: "Bob", todos: [] },
    ]);
    // the outer :limit counted rows the client keeps; the peer sent two
    expect(peer.seen[0]?.rows).toBe(2);
    await peer.dispose();
  });

  test("nested offset + limit page the filtered, ordered collection", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);

    const page = (offset: number) =>
      run(
        db.q(
          query(User)
            .where(User.name.eq("Ada"))
            .select({
              name: User.name,
              todos: Todo.owner.reverse
                .where(Todo.done.eq(false))
                .orderBy(Todo.due, "desc")
                .offset(offset)
                .limit(1)
                .select({ title: Todo.title }),
            }),
        ),
      );
    expect((await page(0))[0]?.todos).toEqual([{ title: "a-open" }]);
    expect((await page(1))[0]?.todos).toEqual([{ title: "a-old" }]);
    // past the end of the collection is `[]`, and still a row
    expect((await page(9))[0]?.todos).toEqual([]);
    await peer.dispose();
  });

  test("a forward card-many ref filters the same way", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);
    peer.seen.length = 0;

    const rows = await run(
      db.q(
        query(User)
          .orderBy(User.name, "asc")
          .select({
            name: User.name,
            friends: User.friends
              .where(User.name.startsWith("C"))
              .select({ name: User.name }),
          }),
      ),
    );
    expect(rows).toEqual([
      { name: "Ada", friends: [{ name: "Cyd" }] },
      { name: "Bob", friends: [] },
      { name: "Cyd", friends: [] },
    ]);
    expect(peer.seen[0]?.rows).toBe(3);
    await peer.dispose();
  });

  test("a multi-hop nested predicate walks from the element", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);

    const rows = await run(
      db.q(
        query(User)
          .orderBy(User.name, "asc")
          .select({
            name: User.name,
            // my friends' todos are not mine: the element is the friend's todo
            todos: Todo.owner.reverse
              .where(Todo.owner.name.eq("Ada"), Todo.done.eq(false))
              .orderBy(Todo.title, "asc")
              .select({ title: Todo.title }),
          }),
      ),
    );
    expect(rows).toEqual([
      { name: "Ada", todos: [{ title: "a-old" }, { title: "a-open" }] },
      { name: "Bob", todos: [] },
      { name: "Cyd", todos: [] },
    ]);
    await peer.dispose();
  });
});

describe("card-many scalars end to end: `.each` on the peer", () => {
  /**
   * Ada — tags [a1, a2, a3]        every tag starts with "a"
   * Bob — tags [a1, b1]            one does not
   * Cyd — no tags at all           the vacuous-truth case
   * Ada's friends are Bob and Cyd.
   */
  const seed = (peer: Awaited<ReturnType<typeof inProcessPeer>>) => {
    const db = peer.ramose.db("todos", Todos);
    return run(
      Effect.gen(function* () {
        yield* db.install();
        yield* db.transact(function* (tx) {
          const ada = yield* tx.entity();
          yield* ada.add(User.name, "Ada");
          for (const t of ["a1", "a2", "a3"]) yield* ada.add(User.tags, t);
          const bob = yield* tx.entity();
          yield* bob.add(User.name, "Bob");
          for (const t of ["a1", "b1"]) yield* bob.add(User.tags, t);
          const cyd = yield* tx.entity();
          yield* cyd.add(User.name, "Cyd");
          yield* ada.add(User.friends, bob.eid as never);
          yield* ada.add(User.friends, cyd.eid as never);
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

  test("every / none / some over a card-many scalar, on the peer", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);

    // Cyd has no tags at all, and `every` is true of nothing — same rule as
    // the many-ref quantifiers, and the reason she comes back here
    expect(
      await names(peer, db, User.tags.every(User.tags.each.startsWith("a"))),
    ).toEqual(["Ada", "Cyd"]);
    expect(await names(peer, db, User.tags.none(User.tags.each.eq("b1")))).toEqual(
      ["Ada", "Cyd"],
    );
    expect(await names(peer, db, User.tags.some(User.tags.each.eq("a1")))).toEqual(
      ["Ada", "Bob"],
    );
    // a bare predicate on a many scalar already means `some`
    expect(await names(peer, db, User.tags.eq("a1"))).toEqual(["Ada", "Bob"]);
    // …and the element comparisons are the peer's, not a client-side filter
    expect(
      await names(peer, db, User.tags.every(User.tags.each.in(["a1", "a2", "a3"]))),
    ).toEqual(["Ada", "Cyd"]);
    expect(
      await names(
        peer,
        db,
        or(User.tags.none(User.tags.each.exists()), User.tags.every(User.tags.each.gt("a2"))),
      ),
    ).toEqual(["Cyd"]);

    await peer.dispose();
  });

  test("a filtered, ordered, paged scalar collection is still one row", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);
    peer.seen.length = 0;

    const rows = await run(
      db.q(
        query(User)
          .orderBy(User.name, "asc")
          .select({
            name: User.name,
            tags: User.tags
              .where(User.tags.each.startsWith("a"))
              .orderBy(User.tags.each, "desc")
              .limit(2),
          }),
      ),
    );
    expect(rows).toEqual([
      { name: "Ada", tags: ["a3", "a2"] },
      { name: "Bob", tags: ["a1"] },
      // a collection that filters to nothing is `[]`, never a dropped row
      { name: "Cyd", tags: [] },
    ]);
    expect(peer.seen[0]?.rows).toBe(3);

    // paging the collection changes what is inside a row, never how many
    const paged = await run(
      db.q(
        query(User)
          .where(User.name.eq("Ada"))
          .select({
            tags: User.tags.orderBy(User.tags.each, "asc").offset(1).limit(1),
          }),
      ),
    );
    expect(paged).toEqual([{ tags: ["a2"] }]);

    await peer.dispose();
  });

  test("`every` inside a nested where filters the collection, per element", async () => {
    const peer = await inProcessPeer();
    const db = await seed(peer);
    peer.seen.length = 0;

    const rows = await run(
      db.q(
        query(User)
          .orderBy(User.name, "asc")
          .select({
            name: User.name,
            // the friends all of whose tags start with "a" — Cyd has none at
            // all, so she is vacuously one of them; Bob's "b1" is not
            friends: User.friends
              .where(User.tags.every(User.tags.each.startsWith("a")))
              .select({ name: User.name }),
          }),
      ),
    );
    expect(rows).toEqual([
      { name: "Ada", friends: [{ name: "Cyd" }] },
      { name: "Bob", friends: [] },
      { name: "Cyd", friends: [] },
    ]);
    expect(peer.seen[0]?.rows).toBe(3);

    await peer.dispose();
  });
});

describe("paging end to end: the peer pages, the client keeps what it gets", () => {
  const seed = (peer: Awaited<ReturnType<typeof inProcessPeer>>) => {
    const db = peer.ramose.db("todos", Todos);
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

