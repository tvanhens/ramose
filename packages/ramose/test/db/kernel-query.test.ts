/**
 * The redesigned query surface: `Query.q(body)` over the kernel (`Q.fact`,
 * comparisons, `Q.or`/`Q.not`, rules), the pipeable stdlib, and whole-query
 * delegation — lowering shape and end-to-end against the real engine
 * through an in-process peer.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { pipe } from "effect/Function";
import {
  Connection,
  QueryError as CoreQueryError,
  QueryParseError,
  TxError,
  fromJson,
  normalizePullPattern,
  pull,
  query as coreQuery,
  toJson,
  toWireDatom,
} from "../../src/internal/core/index.ts";
import {
  Field,
  Schema as DbSchema,
  Databases,
  Instant,
  Long,
  Entity,
  NotOne,
  Q,
  Query,
  Ref,
  layer,
  lowerQueryObject,
  values,
  type Db,
  seedWrite,
} from "../../src/db/internal.ts";
import { entityShape } from "../../src/db/query/fluent.ts";

const run = <A, E>(value: Effect.Effect<A, E> | Promise<A>): Promise<A> =>
  Effect.isEffect(value) ? Effect.runPromise(value) : value;
const runFail = async <A, E>(value: Effect.Effect<A, E> | Promise<A>): Promise<unknown> => {
  if (Effect.isEffect(value)) return Effect.runPromise(Effect.flip(value));
  try {
    await value;
    throw new Error("expected failure");
  } catch (error) {
    return error;
  }
};

// ── in-process peer (the nav harness, trimmed to q/pull/transact) ──────────

interface Reply {
  status: number;
  body: unknown;
}

const inProcessPeer = async () => {
  const conn = await Connection.create();
  const seen: { op: string; body: any }[] = [];

  const answer = async (op: string, body: any): Promise<Reply> => {
    seen.push({ op, body });
    try {
      if (op === "sync") {
        return { status: 200, body: { t: conn.t, from: body.from ?? 0 } };
      }
      if (op === "transact") {
        const rep = await conn.transact(body.tx);
        return {
          status: 200,
          body: {
            t: rep.t,
            txEid: rep.txEid,
            tempids: rep.tempids,
            datoms: rep.txData.map(toWireDatom),
          },
        };
      }
      if (op === "q") {
        const db = body.asOf !== undefined ? conn.db().asOf(body.asOf) : conn.db();
        const result = await coreQuery(db, body.query, body.inputs ?? []);
        return { status: 200, body: { t: db.effectiveT, result } };
      }
      if (op === "pull") {
        const db = conn.db();
        const pattern = normalizePullPattern(body.pattern);
        const eid = typeof body.eid === "number" ? body.eid : await db.entid(body.eid);
        if (eid === undefined) {
          return { status: 200, body: { t: db.effectiveT, result: null } };
        }
        return { status: 200, body: { t: db.effectiveT, result: await pull(db, eid, pattern) } };
      }
      return { status: 404, body: { error: `no such op ${op}` } };
    } catch (err) {
      if (err instanceof TxError) {
        return { status: 409, body: { error: err.message, tag: "TxRejected", code: err.code } };
      }
      if (err instanceof QueryParseError || err instanceof CoreQueryError) {
        return { status: 400, body: { error: err.message } };
      }
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  };

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init.body === undefined ? {} : fromJson(JSON.parse(String(init.body)));
    const op = path.endsWith("/transact") ? "transact" : path.endsWith("/query") ? "q" : "pull";
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
            data: JSON.stringify({ id: frame.id, status: reply.status, body: toJson(reply.body) }),
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

// ── the fixture catalog (the design record's running example) ──────────────

const User = Entity("user", {
  name: Field.unique(Schema.String, "upsert"),
  age: Field(Long, { optional: true }),
  tags: Field.many(Schema.String),
});

const Issue = Entity("issue", {
  title: Field(Schema.String),
  done: Field(Schema.Boolean),
  rank: Field(Long),
  owner: Field(Ref(() => User)),
});

const Comment = Entity("comment", {
  issue: Field(Ref(() => Issue)),
  author: Field(Ref(() => User)),
  text: Field(Schema.String),
  at: Field(Instant),
});

const Team = Entity("team", {
  name: Field(Schema.String),
  members: Field.many(Ref(() => User)),
  parent: Field(Ref.self, { optional: true }),
});

const Tracker = DbSchema({ user: User, issue: Issue, comment: Comment, team: Team });

/** Seed the running example; answers the eids the tests bind. */
const seed = async (db: Db<typeof Tracker>) => {
  const out: Record<string, { readonly id: number }> = {};
  await db.install();
  await run(
    seedWrite(db, function* (tx) {
      const ada = yield* tx.entity();
      yield* ada.set(User.name, "Ada");
      yield* ada.set(User.age, 36);
      yield* ada.set(User.tags, "alpha");
      yield* ada.set(User.tags, "beta");
      yield* ada.set(User.tags, "azure");
      const grace = yield* tx.entity();
      yield* grace.set(User.name, "Grace");
      yield* grace.set(User.age, 45);
      yield* grace.set(User.tags, "gamma");

      const ship = yield* tx.entity();
      yield* ship.set(Issue.title, "ship the release");
      yield* ship.set(Issue.done, false);
      yield* ship.set(Issue.rank, 3);
      yield* ship.set(Issue.owner, ada.eid as never);
      const fix = yield* tx.entity();
      yield* fix.set(Issue.title, "fix the flake");
      yield* fix.set(Issue.done, false);
      yield* fix.set(Issue.rank, 1);
      yield* fix.set(Issue.owner, grace.eid as never);
      const docs = yield* tx.entity();
      yield* docs.set(Issue.title, "archive the docs");
      yield* docs.set(Issue.done, true);
      yield* docs.set(Issue.rank, 2);
      yield* docs.set(Issue.owner, ada.eid as never);

      // Ada commented on "fix the flake"; nobody commented on "ship"
      const c1 = yield* tx.entity();
      yield* c1.set(Comment.issue, fix.eid as never);
      yield* c1.set(Comment.author, ada.eid as never);
      yield* c1.set(Comment.text, "on it");
      yield* c1.set(Comment.at, new Date("2026-01-01T00:00:00.000Z"));

      // Lin has no age — the `missing` combinator's witness
      const lin = yield* tx.entity();
      yield* lin.set(User.name, "Lin");

      const root = yield* tx.entity();
      yield* root.set(Team.name, "root");
      yield* root.set(Team.members, ada.eid as never);
      const eng = yield* tx.entity();
      yield* eng.set(Team.name, "eng");
      yield* eng.set(Team.parent, root.eid as never);
      yield* eng.set(Team.members, grace.eid as never);

    }),
  );
  // `.eid` inside the body is a tempid — read the real ids back with the
  // surface under test
  const byName = <A extends { readonly ident: string }>(nameAttr: A) =>
    Query.q(function* () {
      const f = yield* Q.fact(Q._, nameAttr);
      return { id: f.e, name: f.v };
    });
  for (const [attr, keys] of [
    [User.name, { Ada: "ada", Grace: "grace" }],
    [Issue.title, { "ship the release": "ship", "fix the flake": "fix", "archive the docs": "docs" }],
    [Team.name, { root: "root", eng: "eng" }],
  ] as const) {
    const rows = (await db.query(byName(attr))) as unknown as readonly {
      id: number | { readonly id: number };
      name: string;
    }[];
    for (const r of rows) {
      const key = (keys as Record<string, string>)[r.name as string];
      if (key !== undefined) {
        const id = typeof r.id === "number" ? r.id : r.id.id;
        out[key] = { id };
      }
    }
  }
  return out;
};

// ── the design record's inbox, both spellings ──────────────────────────────

const inboxPipe = (me: number) =>
  Query.q(() =>
    pipe(
      Query.entities(Issue),
      Query.is(Issue.done, false),
      Query.none(Comment.issue, Query.is(Comment.author, me)),
      Query.select({ id: Issue.id, title: Issue.title }),
      Query.orderBy("title"),
      Query.limit(50),
    ),
  );

const inboxGen = (me: number) =>
  Query.q(function* () {
    const issue = yield* Query.entities(Issue);
    yield* Query.is(Issue.done, false)(issue);
    yield* Query.none(Comment.issue, Query.is(Comment.author, me))(issue);
    return Q.pull(issue, { id: Issue.id, title: Issue.title });
  });

describe("lowering", () => {
  test("the inbox pipe: entailment skips membership, cursor lowers, literals substitute", () => {
    const { query } = lowerQueryObject(inboxPipe(42));
    // membership is entailed by [?e :issue/done false] — no rules section
    expect(query.rules).toBeUndefined();
    const where = query.where as unknown[];
    expect(where).toContainEqual(["?q0", ":issue/done", false]);
    // the quantifier is a not-join on the focus, with the param substituted
    const notJoin = where.find((c) => Array.isArray(c) && c[0] === "not-join") as unknown[];
    expect(notJoin).toBeDefined();
    expect(JSON.stringify(notJoin)).toContain('":comment/author",42');
    // find is a pull; title is required; the cursor is on the wire
    expect((query.find as unknown[][])[0]![0]).toBe("pull");
    expect(where).toContainEqual(["?q0", ":issue/title", "_"]);
    expect(query.order).toEqual([{ var: "?o0", dir: "asc", empty: "last" }]);
    expect(query.limit).toBe(50);
  });

  test("both spellings lower to the same logic", () => {
    const p = lowerQueryObject(inboxPipe(7).logic());
    const g = lowerQueryObject(inboxGen(7));
    expect(g.query.where).toEqual(p.query.where);
    expect(g.query.find).toEqual(p.query.find);
  });

  test("lowering is deterministic — two constructions of the same inline-literal chain share a wire", () => {
    const a = JSON.stringify(lowerQueryObject(inboxPipe(7)).query);
    const b = JSON.stringify(lowerQueryObject(inboxPipe(7)).query);
    expect(a).toBe(b);
    const fluentA = Query.from(Issue)
      .where({ done: false })
      .where(Query.none(Comment.issue, Query.is(Comment.author, 7)))
      .select({ id: Issue.id, title: Issue.title })
      .orderBy("title")
      .limit(50);
    const fluentB = Query.from(Issue)
      .where({ done: false })
      .where(Query.none(Comment.issue, Query.is(Comment.author, 7)))
      .select({ id: Issue.id, title: Issue.title })
      .orderBy("title")
      .limit(50);
    expect(JSON.stringify(lowerQueryObject(fluentA).query)).toBe(
      JSON.stringify(lowerQueryObject(fluentB).query),
    );
  });

  test("the unfiltered listing carries the membership rule", () => {
    const listing = Query.q(() => pipe(Query.entities(Issue), Query.select({ id: Issue.id })));
    const { query } = lowerQueryObject(listing);
    expect(query.where).toEqual([["isIssue", "?q0"]]);
    const rules = query.rules as unknown[][];
    expect(rules).toHaveLength(1);
    expect(rules[0]![0]).toEqual(["isIssue", "?qm0"]);
    const or = rules[0]![1] as unknown[];
    expect(or[0]).toBe("or");
    expect(or).toContainEqual(["?qm0", ":issue/title", "_"]);
    expect(or).toContainEqual(["?qm0", ":issue/owner", "_"]);
  });

  test("open refuses a cursor; logic() strips it", () => {
    const outer = Query.q(function* () {
      const { focus } = yield* inboxPipe(1).open();
      return Q.pull(focus, { title: Issue.title });
    });
    expect(() => lowerQueryObject(outer)).toThrow(/does not delegate/);

    const stripped = Query.q(function* () {
      const { focus } = yield* inboxPipe(1).logic().open();
      return Q.pull(focus, { title: Issue.title });
    });
    const { query } = lowerQueryObject(stripped);
    expect(query.limit).toBeUndefined();
    expect(query.order).toBeUndefined();
  });

  test("is(N.id, constant) unifies the focus — it does not emit a :db/id pattern", () => {
    const q = Query.q(() =>
      pipe(Query.entities(Issue), Query.is(Issue.id, 5), Query.select({ title: Issue.title })),
    );
    const { query } = lowerQueryObject(q);
    const where = query.where as unknown[];
    expect(where).toContainEqual([["ground", 5], "?q0"]);
    expect(where.some((c) => Array.isArray(c) && c[1] === ":db/id")).toBe(false);
  });

  test("is(N.id, literal) substitutes and unifies", () => {
    const q = Query.q(() =>
      pipe(Query.entities(Issue), Query.is(Issue.id, 42), Query.select({ title: Issue.title })),
    );
    const { query } = lowerQueryObject(q);
    const where = query.where as unknown[];
    expect(where).toContainEqual([["ground", 42], "?q0"]);
    expect(where.some((c) => Array.isArray(c) && c[1] === ":db/id")).toBe(false);
  });

  test("byId lowers to the same wire as is(N.id, …)", () => {
    const byConst = Query.q(() => pipe(Query.entities(Issue), Query.byId(5), Query.select({ title: Issue.title })));
    const isConst = Query.q(() =>
      pipe(Query.entities(Issue), Query.is(Issue.id, 5), Query.select({ title: Issue.title })),
    );
    expect(lowerQueryObject(byConst).query).toEqual(lowerQueryObject(isConst).query);

    const byLit = Query.q(() =>
      pipe(Query.entities(Issue), Query.byId(42), Query.select({ title: Issue.title })),
    );
    const isLit = Query.q(() =>
      pipe(Query.entities(Issue), Query.is(Issue.id, 42), Query.select({ title: Issue.title })),
    );
    expect(lowerQueryObject(byLit).query).toEqual(lowerQueryObject(isLit).query);
  });
});

describe("filter by entity id", () => {
  test("the engine rejects [?e :db/id v] — :db/id is not an attribute", async () => {
    const conn = await Connection.create();
    await expect(
      coreQuery(conn.db(), { find: ["?e"], where: [["?e", ":db/id", 5]] }),
    ).rejects.toThrow(/unknown attribute :db\/id/);
  });

  test("is(N.id, constant) filters at the peer", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    const byConst = Query.q(() =>
      pipe(
        Query.entities(Issue),
        Query.is(Issue.id, ids.ship!.id),
        Query.select({ id: Issue.id, title: Issue.title }),
      ),
    );
    const rows = await db.query(byConst);
    expect(rows).toEqual([{ id: ids.ship!.id as never, title: "ship the release" }]);

    await peer.dispose();
  });

  test("is(N.id, literal) and byId(literal) agree against the engine", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    const isLit = Query.q(() =>
      pipe(
        Query.entities(Issue),
        Query.is(Issue.id, ids.fix!.id),
        Query.select({ id: Issue.id, title: Issue.title }),
      ),
    );
    const byIdLit = Query.q(() =>
      pipe(
        Query.entities(Issue),
        Query.byId(ids.fix!.id),
        Query.select({ id: Issue.id, title: Issue.title }),
      ),
    );
    const isRows = await db.query(isLit);
    const byIdRows = await db.query(byIdLit);
    expect(isRows).toEqual([{ id: ids.fix!.id as never, title: "fix the flake" }]);
    expect(byIdRows).toEqual(isRows);

    const commentId = (
      (await run(
        db.query(
          Query.q(function* () {
            const f = yield* Q.fact(Q._, Comment.text);
            return { id: f.e, text: f.v };
          }),
        ),
      )) as readonly { id: { id: number }; text: string }[]
    ).find((r) => r.text === "on it")!.id;

    const byComment = Query.q(() =>
      pipe(
        Query.entities(Comment),
        Query.byId(commentId.id),
        Query.select({ id: Comment.id, text: Comment.text }),
      ),
    );
    const comments = await db.query(byComment);
    expect(comments).toEqual([{ id: commentId.id as never, text: "on it" }]);

    const miss = await db.query(
      Query.q(() =>
        pipe(
          Query.entities(Issue),
          Query.byId(commentId.id),
          Query.select({ id: Issue.id, title: Issue.title }),
        ),
      ),
    );
    expect(miss).toEqual([]);

    await peer.dispose();
  });
});

describe("db.query end to end", () => {
  test("the inbox: quantifier, inline values, order, limit", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    // Ada commented on "fix the flake", so her inbox is only "ship ..."
    const ada = await db.query(inboxPipe(ids.ada!.id));
    expect(ada.map((r) => r.title)).toEqual(["ship the release"]);
    // Grace commented on nothing: both open issues, ordered by title
    const grace = await db.query(inboxPipe(ids.grace!.id));
    expect(grace.map((r) => r.title)).toEqual(["fix the flake", "ship the release"]);
    // rows carry the branded id cell
    expect(ada[0]!.id).toBe(ids.ship!.id as never);

    await peer.dispose();
  });

  test("generator spelling: fact-first bodies and record projections", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    const owners = Query.q(function* () {
      const owned = yield* Q.fact(Q._, Issue.owner);
      const name = yield* Q.fact(owned.v, User.name);
      const title = yield* Q.fact(owned.e, Issue.title);
      return { issue: owned.e, title: title.v, owner: name.v };
    });
    const rows = await db.query(owners);
    const byTitle = [...rows].sort((a, b) => String(a.title).localeCompare(String(b.title)));
    expect(byTitle.map((r) => [r.title, r.owner])).toEqual([
      ["archive the docs", "Ada"],
      ["fix the flake", "Grace"],
      ["ship the release", "Ada"],
    ]);
    // entity cells come back wrapped
    expect(byTitle[1]!.issue).toEqual(ids.fix as never);

    await peer.dispose();
  });

  test("Q.or joins on closed-over handles", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const q = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const t = yield* Q.fact(issue, Issue.title);
      yield* Q.or(Q.startsWith(t.v, "ship"), Q.startsWith(t.v, "fix"));
      return { title: t.v };
    });
    const rows = await db.query(q);
    expect(rows.map((r) => r.title).sort()).toEqual(["fix the flake", "ship the release"]);

    await peer.dispose();
  });

  test("traversals refocus: follow in pipe, backlink in a generator", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    const ownersOfOpen = Query.q(() =>
      pipe(
        Query.entities(Issue),
        Query.is(Issue.done, false),
        Query.follow(Issue.owner),
        Query.select({ name: User.name }),
      ),
    );
    const rows = await db.query(ownersOfOpen);
    expect(rows.map((r) => r.name).sort()).toEqual(["Ada", "Grace"]);

    const commenters = Query.q(function* () {
      const comment = yield* Q.fact(Q._, Comment.issue, ids.fix!.id);
      const author = yield* Query.follow(Comment.author)(comment.e);
      const name = yield* Q.fact(author, User.name);
      return { name: name.v };
    });
    const who = await db.query(commenters);
    expect(who).toEqual([{ name: "Ada" }]);

    await peer.dispose();
  });

  test("a userland combinator is indistinguishable from a shipped one", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    // defined with public primitives only, lifted with the same adapter
    const rankAbove = (min: number) =>
      Query.stage(function* (e) {
        const f = yield* Q.fact(e, Issue.rank);
        yield* Q.gt(f.v, min);
      });

    const q = Query.q(() =>
      pipe(Query.entities(Issue), rankAbove(1), Query.select({ title: Issue.title, rank: Issue.rank })),
    );
    const rows = await db.query(q);
    expect(rows.map((r) => r.title).sort()).toEqual(["archive the docs", "ship the release"]);

    await peer.dispose();
  });

  test("named rules: recursion expands on the engine", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    // membership in a team, directly or through a subteam chain
    const inTeam: Query.RuleValue = Query.rule("team/inTeam", function* (u, t) {
      yield* Q.or(
        function* () {
          yield* Q.fact(t, Team.members, u);
        },
        function* () {
          const sub = yield* Q.fact(Q._, Team.parent, t);
          yield* inTeam(u, sub.e);
        },
      );
    });

    const membersOf = (teamId: number) =>
      Query.q(function* () {
        const user = yield* Query.entities(User);
        yield* inTeam(user, teamId);
        const name = yield* Q.fact(user, User.name);
        return { name: name.v };
      });

    const root = await db.query(membersOf(ids.root!.id));
    expect(root.map((r) => r.name).sort()).toEqual(["Ada", "Grace"]);
    const eng = await db.query(membersOf(ids.eng!.id));
    expect(eng.map((r) => r.name)).toEqual(["Grace"]);

    await peer.dispose();
  });

  test("promotion: an instantiated fragment is one call from a named rule", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const ownerOf = Query.rule("issue/ownerOf", Query.follow(Issue.owner));
    const q = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.done, false)(issue);
      const owner = yield* ownerOf(issue);
      const name = yield* Q.fact(owner, User.name);
      return { name: name.v };
    });
    const { query } = lowerQueryObject(q);
    // the return var joined the head: a two-place rule on the wire
    const def = (query.rules as unknown[][]).find((r) => (r[0] as unknown[])[0] === "issue/ownerOf")!;
    expect((def[0] as unknown[]).length).toBe(3);

    const rows = await db.query(q);
    expect(rows.map((r) => r.name).sort()).toEqual(["Ada", "Grace"]);

    await peer.dispose();
  });

  test("open: whole-query composition; enrich derives from it", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const openIssues = Query.q(() =>
      pipe(Query.entities(Issue), Query.is(Issue.done, false), Query.select({ title: Issue.title })),
    );

    const withOwner = Query.q(function* () {
      const { focus, cols } = yield* openIssues.open();
      const owner = yield* Query.follow(Issue.owner)(focus);
      const name = yield* Q.fact(owner, User.name);
      return Q.row(cols, { owner: name.v });
    });
    const rows = await db.query(withOwner);
    const sorted = [...rows].sort((a, b) => String(a.title).localeCompare(String(b.title)));
    expect(sorted).toEqual([
      { title: "fix the flake", owner: "Grace" },
      { title: "ship the release", owner: "Ada" },
    ]);

    // the boilerplate-free transformer: aggregates over the attr-free fact
    const withLastUpdated = Query.enrich(function* (e) {
      const f = yield* Q.fact(e);
      return { lastUpdated: Q.max(f.t) };
    });
    const enriched = await db.query(withLastUpdated(openIssues));
    expect(enriched).toHaveLength(2);
    for (const r of enriched) {
      expect(typeof r.lastUpdated).toBe("number");
      expect(r.lastUpdated as number).toBeGreaterThan(0);
      expect(r.lastUpdated as number).toBeLessThan(1_000_000);
      expect(typeof r.title).toBe("string");
    }

    await peer.dispose();
  });

  test("teamDigest: multi-root rows, a correlated open, pull cells in a record", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    const teamDigest = (me: number) =>
      Query.q(function* () {
        const team = yield* Query.entities(Team);
        yield* Q.fact(team, Team.members, me);
        const issue = yield* Query.entities(Issue);
        yield* Query.is(Issue.done, false)(issue);
        const owner = yield* Query.follow(Issue.owner)(issue);
        yield* Q.fact(team, Team.members, owner);
        return Q.rows({
          team: Q.pull(team, { name: Team.name }),
          esc: Q.pull(issue, { title: Issue.title }),
        });
      });

    const ada = await db.query(teamDigest(ids.ada!.id));
    expect(ada).toEqual([{ team: { name: "root" }, esc: { title: "ship the release" } }] as never);
    const grace = await db.query(teamDigest(ids.grace!.id));
    expect(grace).toEqual([{ team: { name: "eng" }, esc: { title: "fix the flake" } }] as never);

    await peer.dispose();
  });

  test("refine keeps the row and adds constraints", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const openIssues = Query.q(() =>
      pipe(Query.entities(Issue), Query.is(Issue.done, false), Query.select({ title: Issue.title })),
    );
    const adaOnly = Query.refine(function* (e) {
      const owner = yield* Query.follow(Issue.owner)(e);
      yield* Q.fact(owner, User.name, "Ada");
    })(openIssues);
    const rows = await db.query(adaOnly);
    expect(rows).toEqual([{ title: "ship the release" }] as never);

    await peer.dispose();
  });

  test("aggregate cells group by the record's other cells", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const perOwner = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const owner = yield* Query.follow(Issue.owner)(issue);
      const name = yield* Q.fact(owner, User.name);
      return { owner: name.v, n: Q.count(issue) };
    });
    const rows = await db.query(perOwner);
    const sorted = [...rows].sort((a, b) => String(a.owner).localeCompare(String(b.owner)));
    expect(sorted).toEqual([
      { owner: "Ada", n: 2 },
      { owner: "Grace", n: 1 },
    ] as never);

    await peer.dispose();
  });

  test("aggregates sum rows, not distinct values — the bound entity rides in :with", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    // a second rank-2 issue: sum must see both rows, not one distinct 2
    await run(
      seedWrite(db, function* (tx) {
        const dupe = yield* tx.entity();
        yield* dupe.set(Issue.title, "the duplicate rank");
        yield* dupe.set(Issue.done, true);
        yield* dupe.set(Issue.rank, 2);
        yield* dupe.set(Issue.owner, ids.ada!.id as never);
      }),
    );

    const totals = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const r = yield* Q.fact(issue, Issue.rank);
      return { total: Q.sum(r.v), n: Q.count(r.v), distinct: Q.countDistinct(r.v) };
    });
    // ranks are 3, 1, 2, 2
    expect(await db.query(totals)).toEqual([{ total: 8, n: 4, distinct: 3 }] as never);

    // the fact's e-position rides in :with; an aggregated entity var needs none
    const lowered = lowerQueryObject(totals);
    expect(lowered.query.with).toHaveLength(1);
    const perOwner = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const owner = yield* Query.follow(Issue.owner)(issue);
      const name = yield* Q.fact(owner, User.name);
      return { owner: name.v, n: Q.count(issue) };
    });
    expect(lowerQueryObject(perOwner).query.with).toBeUndefined();

    // grouped: the duplicate values stay two rows inside their group too
    const perDone = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const d = yield* Q.fact(issue, Issue.done);
      const r = yield* Q.fact(issue, Issue.rank);
      return { done: d.v, total: Q.sum(r.v) };
    });
    const rows = await db.query(perDone);
    const sorted = [...rows].sort((a, b) => Number(a.done) - Number(b.done));
    expect(sorted).toEqual([
      { done: false, total: 4 },
      { done: true, total: 4 },
    ] as never);

    await peer.dispose();
  });

  test("an ungrouped aggregate answers one row over the empty set", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    // no non-aggregate cell: the whole (empty) match set is the one group
    const stats = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.title, "no such issue")(issue);
      const r = yield* Q.fact(issue, Issue.rank);
      return { n: Q.count(issue), total: Q.sum(r.v), top: Q.max(r.v), mean: Q.avg(r.v) };
    });
    expect(await db.query(stats)).toEqual([
      { n: 0, total: 0, top: null, mean: null },
    ] as never);

    // …so one() always has its row, and rows[0].n needs no ?? 0
    const count = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.title, "no such issue")(issue);
      return { n: Q.count(issue) };
    });
    expect(await db.query(count.one())).toEqual({ n: 0 } as never);

    // a projection with a group key correctly stays []: no rows, no groups
    const grouped = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.title, "no such issue")(issue);
      const t = yield* Q.fact(issue, Issue.title);
      return { title: t.v, n: Q.count(issue) };
    });
    expect(await db.query(grouped)).toEqual([]);

    // a non-empty match set is untouched by the synthesis
    const open = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.done, false)(issue);
      return { n: Q.count(issue) };
    });
    expect(await db.query(open)).toEqual([{ n: 2 }] as never);

    await peer.dispose();
  });

  test("where, missing, every, and Q.in", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const inList = Query.q(() =>
      pipe(
        Query.entities(Issue),
        Query.matching(Issue.title, (t) => Q.in(t, ["fix the flake", "not a title"])),
        Query.select({ title: Issue.title }),
      ),
    );
    expect(await db.query(inList)).toEqual([{ title: "fix the flake" }] as never);

    const ageless = Query.q(() =>
      pipe(Query.entities(User), Query.missing(User.age), Query.select({ name: User.name })),
    );
    expect(await db.query(ageless)).toEqual([{ name: "Lin" }] as never);

    // every comment is Ada's — vacuously true of uncommented issues
    const allAda = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.every(Comment.issue, (c) =>
        (function* () {
          const author = yield* Query.follow(Comment.author)(c);
          yield* Q.fact(author, User.name, "Ada");
        })(),
      )(issue);
      const t = yield* Q.fact(issue, Issue.title);
      return { title: t.v };
    });
    const rows = await db.query(allAda);
    expect(rows.map((r) => r.title).sort()).toEqual([
      "archive the docs",
      "fix the flake",
      "ship the release",
    ]);

    await peer.dispose();
  });

  test("one() / oneOrFail(): forced limit, unwrapped row, NotOne on the miss", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const byTitle = (title: string) =>
      Query.q(() =>
        pipe(
          Query.entities(Issue),
          Query.is(Issue.title, title),
          Query.select({ title: Issue.title, rank: Issue.rank }),
        ),
      );

    // lowering forces the limit: one row for one(), two so a second match is witnessed
    expect(lowerQueryObject(byTitle("x").one()).query.limit).toBe(1);
    expect(lowerQueryObject(byTitle("x").oneOrFail()).query.limit).toBe(2);

    const hit = await db.query(byTitle("ship the release").one());
    expect(hit).toEqual({ title: "ship the release", rank: 3 } as never);
    expect(await db.query(byTitle("nope").one())).toBeNull();

    const exact = await db.query(byTitle("fix the flake").oneOrFail());
    expect(exact.rank).toBe(1);

    const missing = await runFail(db.query(byTitle("nope").oneOrFail()));
    expect(missing).toBeInstanceOf(NotOne);
    expect((missing as NotOne).found).toBe(0);

    const openIssues = Query.q(() =>
      pipe(Query.entities(Issue), Query.is(Issue.done, false), Query.select({ title: Issue.title })),
    );
    const two = await runFail(db.query(openIssues.oneOrFail()));
    expect((two as NotOne).found).toBe(2);

    await peer.dispose();
  });

  test("after(): keyset pages walk the sort, cursor ends on the short page", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const byRank = Query.q(() =>
      pipe(
        Query.entities(Issue),
        Query.select({ title: Issue.title, rank: Issue.rank }),
        Query.orderBy("rank"),
        Query.limit(2),
      ),
    );

    const p1 = await db.query(byRank.after(null));
    expect(p1.rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(p1.cursor).not.toBeNull();

    const p2 = await db.query(byRank.after(p1.cursor));
    expect(p2.rows.map((r) => r.rank)).toEqual([3]);
    // shorter than its limit: the page is over
    expect(p2.cursor).toBeNull();

    // the seek is the peer's — the wire carries `after` with the tie-breaker
    const lowered = lowerQueryObject(byRank.after(p1.cursor));
    expect((lowered.query.after as unknown[]).length).toBe(2);
    expect((lowered.query.order as unknown[]).length).toBe(2);

    // paging an unsorted query has no position to seek from
    const unsorted = Query.q(() => pipe(Query.entities(Issue), Query.select({ title: Issue.title })));
    expect(() => lowerQueryObject(unsorted.after(null))).toThrow(/sorted query/);

    // a cursor only continues the query that minted it
    const oneKey = Query.q(() =>
      pipe(Query.entities(Issue), Query.select({ rank: Issue.rank }), Query.orderBy("rank"), Query.orderBy(Issue.title)),
    );
    expect(() => lowerQueryObject(oneKey.after(p1.cursor))).toThrow(/does not fit/);

    await peer.dispose();
  });

  test("conditional clauses are ordinary JS with the immutable builder", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    let board = Query.from(Issue);
    const owner = ids.ada;
    if (owner) board = board.where({ owner });
    const adas = await db.query(board.select({ title: Issue.title }));
    expect(adas.map((r) => r.title).sort()).toEqual(["archive the docs", "ship the release"]);

    const all = await db.query(Query.from(Issue).select({ title: Issue.title }));
    expect(all).toHaveLength(3);

    await peer.dispose();
  });

  test("time is ordinary clauses: updatedSince windows on the basis t", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    const report = await run(
      seedWrite(db, function* (tx) {
        const late = yield* tx.entity();
        yield* late.set(Issue.title, "the late arrival");
        yield* late.set(Issue.done, false);
        yield* late.set(Issue.rank, 9);
        yield* late.set(Issue.owner, ids.ada!.id as never);
      }),
    );

    const recent = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.updatedSince(report.t)(issue);
      const t = yield* Q.fact(issue, Issue.title);
      return { title: t.v };
    });
    const rows = await db.query(recent);
    expect(rows.map((r) => r.title)).toEqual(["the late arrival"]);

    await peer.dispose();
  });
});

// ── post-group filters: aggregate cells as comparison operands ─────────────

describe("post-group filters (:having)", () => {
  const busyOwners = Query.q(function* () {
    const issue = yield* Query.entities(Issue);
    const owner = yield* Query.follow(Issue.owner)(issue);
    const n = Q.count(issue);
    yield* Q.gt(n, 1);
    return { owner, n };
  });

  test("lowering: an aggregate comparison routes to :having, named by (as …)", () => {
    const { query } = lowerQueryObject(busyOwners);
    expect(query.find).toEqual(["?q0", ["as", ["count", "?q1"], "?qh0"]]);
    expect(query.where).toEqual([["?q1", ":issue/owner", "?q0"]]);
    expect(query.having).toEqual([[[">", "?qh0", 1]]]);

    // one fn over one var is one cell — the compared spec need not be the
    // same object as the projected one
    const inline = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const owner = yield* Query.follow(Issue.owner)(issue);
      yield* Q.gt(Q.count(issue), 1);
      return { owner, n: Q.count(issue) };
    });
    expect(lowerQueryObject(inline).query.having).toEqual(query.having);
  });

  test("lowering: group-key filters stay ordinary clauses in :where", () => {
    const q = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const r = yield* Q.fact(issue, Issue.rank);
      yield* Q.gt(r.v, 0); // a row filter: no :having needed for a group key
      const n = Q.count(issue);
      yield* Q.lte(n, 10);
      return { rank: r.v, n };
    });
    const { query } = lowerQueryObject(q);
    expect(query.having).toEqual([[["<=", expect.stringMatching(/^\?qh/), 10]]]);
    expect(JSON.stringify(query.where)).toContain('[[">","?q0",0]]');
    expect(JSON.stringify(query.having)).not.toContain('">"');
  });

  test("e2e: owners with more than one issue", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    const rows = await db.query(busyOwners);
    expect(rows).toEqual([{ owner: ids.ada, n: 2 }] as never);

    // the same filter over a value group key
    const byName = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const owner = yield* Query.follow(Issue.owner)(issue);
      const name = yield* Q.fact(owner, User.name);
      const n = Q.count(issue);
      yield* Q.gt(n, 1);
      return { owner: name.v, n };
    });
    expect(await db.query(byName)).toEqual([{ owner: "Ada", n: 2 }] as never);

    await peer.dispose();
  });

  test("e2e: inline values substitute into the post-group comparison", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    const atLeast = (min: number) =>
      Query.q(function* () {
        const issue = yield* Query.entities(Issue);
        const owner = yield* Query.follow(Issue.owner)(issue);
        const n = Q.count(issue);
        yield* Q.gte(n, min);
        return { owner, n };
      });
    expect(await db.query(atLeast(2))).toEqual([{ owner: ids.ada, n: 2 }] as never);
    expect((await db.query(atLeast(1))).length).toBe(2);

    await peer.dispose();
  });

  test("e2e: the synthesized empty-set row still passes through :having", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);


    const none = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.title, "no such issue")(issue);
      const n = Q.count(issue);
      yield* Q.lt(n, 5);
      return { n };
    });
    // count over the empty set is 0, and 0 < 5 keeps the one row
    expect(await db.query(none)).toEqual([{ n: 0 }] as never);

    const some = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.title, "no such issue")(issue);
      const n = Q.count(issue);
      yield* Q.gt(n, 0);
      return { n };
    });
    // …and 0 > 0 drops it, exactly as the peer would have
    expect(await db.query(some)).toEqual([]);

    await peer.dispose();
  });

  test("misplaced aggregate comparisons are lowering errors", () => {
    // inside Q.or there is no group to filter
    const inOr = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const n = Q.count(issue);
      yield* Q.or(Q.gt(n, 1), Q.lt(n, 0));
      return { n };
    });
    expect(() => lowerQueryObject(inOr)).toThrow(/cannot appear inside Q\.or/);

    // a compared cell that never reaches the projection has no name on the row
    const unprojected = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const t = yield* Q.fact(issue, Issue.title);
      yield* Q.gt(Q.count(issue), 1);
      return { title: t.v };
    });
    expect(() => lowerQueryObject(unprojected)).toThrow(/never projected/);

    // a var beside the aggregate must itself be a projected cell
    const looseVar = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const r = yield* Q.fact(issue, Issue.rank);
      const n = Q.count(issue);
      yield* Q.gt(n, r.v);
      return { n };
    });
    expect(() => lowerQueryObject(looseVar)).toThrow(/projected cell/);

    // :having names find cells, and a pull has none
    const withPull = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const owner = yield* Query.follow(Issue.owner)(issue);
      const n = Q.count(issue);
      yield* Q.gt(n, 1);
      return { owner: Q.pull(owner, { name: User.name }), n };
    });
    expect(() => lowerQueryObject(withPull)).toThrow(/cannot share a projection/);
  });
});

// ── per-element pull filters: the select options record ────────────────────

describe("per-element pull filters (select options)", () => {
  test("lowering: the options record compiles into the collection's :where / :order / :limit", () => {
    const q = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      return Q.pull(issue, {
        title: Issue.title,
        fresh: Comment.issue.reverse.select(
          { text: Comment.text },
          {
            where: [
              function* (c) {
                const author = yield* Query.follow(Comment.author)(c);
                yield* Q.fact(author, User.name, "Grace");
                yield* Q.not(Query.is(Comment.text, "old take")(c));
              },
            ],
            orderBy: { key: Comment.text, dir: "asc" },
            limit: 5,
          },
        ),
      });
    });
    const { query } = lowerQueryObject(q);
    const pattern = (query.find as unknown[][])[0]![2] as Record<string, unknown>[];
    const fresh = pattern.find((s) => s.as === "fresh")!;
    expect(fresh.reverse).toBe(true);
    // facts chain into paths; Q.not maps to not
    expect(fresh.where).toEqual([
      { path: [":comment/author", ":user/name"], op: "=", value: "Grace" },
      { not: { path: [":comment/text"], op: "=", value: "old take" } },
    ]);
    expect(fresh.order).toEqual([{ path: [":comment/text"], dir: "asc" }]);
    expect(fresh.limit).toBe(5);

    // a bare attr is the ascending shorthand
    const bare = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      return Q.pull(issue, {
        c: Comment.issue.reverse.select({ text: Comment.text }, { orderBy: Comment.text }),
      });
    });
    const spec = ((lowerQueryObject(bare).query.find as unknown[][])[0]![2] as Record<string, unknown>[])[0]!;
    expect(spec.order).toEqual([{ path: [":comment/text"], dir: "asc" }]);
  });

  test("lowering: Q.or, has, and eid literals", () => {
    const q = Query.q(function* () {
      const team = yield* Query.entities(Team);
      return Q.pull(team, {
        members: Team.members.select(
          { name: User.name },
          { where: [(u) => Q.or(Query.is(User.name, "Ada")(u), Query.has(User.age)(u))] },
        ),
      });
    });
    const { query } = lowerQueryObject(q);
    const pattern = (query.find as unknown[][])[0]![2] as Record<string, unknown>[];
    const members = pattern.find((s) => s.as === "members")!;
    expect(members.where).toEqual([
      {
        or: [
          { path: [":user/name"], op: "=", value: "Ada" },
          { path: [":user/age"], op: "exists" },
        ],
      },
    ]);
  });

  test("e2e: a backlink collection filters per element; rows are untouched", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);
    // a second comment, so the filter has something to drop
    await run(
      seedWrite(db, function* (tx) {
        const c = yield* tx.entity();
        yield* c.set(Comment.issue, ids.fix!.id as never);
        yield* c.set(Comment.author, ids.grace!.id as never);
        yield* c.set(Comment.text, "second take");
        yield* c.set(Comment.at, new Date("2026-01-02T00:00:00.000Z"));
      }),
    );

    const q = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      return Q.pull(issue, {
        title: Issue.title,
        adaSays: Comment.issue.reverse.select(
          { text: Comment.text },
          {
            where: [
              function* (c) {
                const author = yield* Query.follow(Comment.author)(c);
                yield* Q.fact(author, User.name, "Ada");
              },
            ],
          },
        ),
      });
    });
    const rows = await db.query(q);
    const byTitle = new Map(rows.map((r) => [r.title, r.adaSays.map((c) => c.text)]));
    // the Grace comment is dropped from the collection, never the row
    expect(byTitle.get("fix the flake")).toEqual(["on it"]);
    expect(byTitle.get("ship the release")).toEqual([]);
    expect(byTitle.get("archive the docs")).toEqual([]);

    await peer.dispose();
  });

  test("e2e: a forward many-ref collection, filtered by a comparison fragment", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const q = Query.q(function* () {
      const team = yield* Query.entities(Team);
      return Q.pull(team, {
        name: Team.name,
        seniors: Team.members.select(
          { name: User.name },
          { where: [Query.matching(User.age, (a) => Q.gt(a, 40))] },
        ),
      });
    });
    const rows = await db.query(q);
    const byName = new Map(rows.map((r) => [r.name, r.seniors.map((m) => m.name)]));
    expect(byName.get("root")).toEqual([]); // Ada is 36
    expect(byName.get("eng")).toEqual(["Grace"]); // Grace is 45

    await peer.dispose();
  });

  test("e2e: a card-many scalar hands the fragment the value itself", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const q = Query.q(function* () {
      const user = yield* Query.entities(User);
      return Q.pull(user, {
        name: User.name,
        aTags: values(User.tags, { where: [(v) => Q.startsWith(v, "a")] }),
      });
    });
    const rows = await db.query(q);
    const byName = new Map(rows.map((r) => [r.name, [...r.aTags].sort()]));
    expect(byName.get("Ada")).toEqual(["alpha", "azure"]);
    expect(byName.get("Grace")).toEqual([]);
    expect(byName.get("Lin")).toEqual([]);

    // comparisons on the element lower with an empty path
    const { query } = lowerQueryObject(q);
    const pattern = (query.find as unknown[][])[0]![2] as Record<string, unknown>[];
    const tags = pattern.find((s) => s.as === "aTags")!;
    expect(tags.where).toEqual([{ path: [], op: "starts-with?", value: "a" }]);

    await peer.dispose();
  });

  test("e2e: inline values substitute into nested filter values at query lowering", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    const q = (who: number) =>
      Query.q(function* () {
        const issue = yield* Query.entities(Issue);
        return Q.pull(issue, {
          title: Issue.title,
          theirs: Comment.issue.reverse.select(
            { text: Comment.text },
            { where: [Query.is(Comment.author, who)] },
          ),
        });
      });
    const rows = await db.query(q(ids.ada!.id));
    const fix = rows.find((r) => r.title === "fix the flake")!;
    expect(fix.theirs).toEqual([{ text: "on it" }] as never);
    const grace = await db.query(q(ids.grace!.id));
    expect(grace.find((r) => r.title === "fix the flake")!.theirs).toEqual([]);

    await peer.dispose();
  });

  test("what cannot translate is rejected, never approximated", async () => {
    const commentShape = { text: Comment.text };

    // closing over an enclosing var: a pull filter cannot correlate
    const correlated = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const owner = yield* Query.follow(Issue.owner)(issue);
      return Q.pull(issue, {
        c: Comment.issue.reverse.select(commentShape, {
          where: [Query.is(Comment.author, owner as never)],
        }),
      });
    });
    expect(() => lowerQueryObject(correlated)).toThrow(/closes over a var from the enclosing query/);

    // entities(...) joins, and a pull filter cannot
    expect(() =>
      Comment.issue.reverse.select(commentShape, {
        where: [
          function* () {
            yield* Query.entities(User);
          },
        ],
      }),
    ).toThrow(/entities\(\.\.\.\) does not lower/);

    // two values bound by different clauses cannot be compared per element
    expect(() =>
      Comment.issue.reverse.select(commentShape, {
        where: [
          function* (c) {
            const a = yield* Q.fact(c, Comment.text);
            const b = yield* Q.fact(c, Comment.text);
            yield* Q.eq(a.v, b.v);
          },
        ],
      }),
    ).toThrow(/compares two bound values/);

    // time positions have no pull-phase meaning
    expect(() =>
      Comment.issue.reverse.select(commentShape, {
        where: [
          function* (c) {
            const f = yield* Q.fact(c, Comment.text);
            yield* Q.gte(f.t, 1);
          },
        ],
      }),
    ).toThrow(/time position/);

    // options need a collection: a card-one ref has one element, the row's
    expect(() =>
      (Issue.owner.select as (...a: unknown[]) => unknown)({ name: User.name }, {}),
    ).toThrow(/cardinality-many/);
    // …and a scalar's spelling rejects refs, which have a shape to select
    expect(() => values(Team.members as never, {})).toThrow(/reference collection/);
    // a stray option key is named, not ignored
    expect(() =>
      (Team.members.select as (...a: unknown[]) => unknown)(
        { name: User.name },
        { order: User.name },
      ),
    ).toThrow(/unknown select option "order"/);

  });
});

describe("Query.from — fluent app spelling", () => {
  const commentShape = {
    id: Comment.id,
    text: Comment.text,
    at: Comment.at,
    issue: Comment.issue.select({ id: Issue.id }),
  } as const;

  test("inline-value fluent query runs without bindings", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    const commentsQuery = Query.from(Comment)
      .where({ issue: ids.fix })
      .orderBy(Comment.at, "asc");
    const commentTitles = Query.from(Comment)
      .where({ issue: ids.fix })
      .select(commentShape)
      .orderBy(Comment.at, "asc");

    const rows = await db.query(commentsQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("on it");
    expect(rows[0]!.issue.id as number).toBe(ids.fix.id);

    const titled = await db.query(commentTitles);
    expect(titled).toEqual([
      {
        id: expect.any(Number),
        text: "on it",
        at: new Date("2026-01-01T00:00:00.000Z"),
        issue: { id: ids.fix.id as never },
      },
    ]);
    await peer.dispose();
  });

  test("header example compiles and runs as written", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);
    const issueId = ids.fix;

    const commentsQuery = Query.from(Comment)
      .where({ issue: issueId })
      .orderBy(Comment.at, "asc");
    const commentTitles = Query.from(Comment)
      .where({ issue: issueId })
      .select(commentShape)
      .orderBy(Comment.at, "asc");

    const rows = await db.query(commentsQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("on it");
    expect(rows[0]!.issue.id as number).toBe(ids.fix.id);
    expect(typeof rows[0]!.id).toBe("number");

    const titled = await db.query(commentTitles);
    expect(titled).toEqual([
      {
        id: expect.any(Number),
        text: "on it",
        at: new Date("2026-01-01T00:00:00.000Z"),
        issue: { id: ids.fix.id as never },
      },
    ]);
    await peer.dispose();
  });

  test("entityShape nests the target entity's id, not the source's", () => {
    const shape = entityShape(Comment) as unknown as {
      readonly issue: {
        readonly _tag: string;
        readonly field: { readonly _tag: string; readonly shape: { readonly id: unknown } };
      };
    };
    // card-one refs are `.optional` at runtime so a missing fact keeps the row
    expect(shape.issue._tag).toBe("optional");
    expect(shape.issue.field._tag).toBe("select");
    expect(shape.issue.field.shape.id).toBe(Issue.id);
    expect(shape.issue.field.shape.id).not.toBe(Comment.id);
  });

  test("select-less fluent query serializes the expanded entity shape, not [*]", async () => {
    const q = Query.from(Comment).where({ issue: { id: 1 } }).orderBy(Comment.at, "asc");
    const { query } = lowerQueryObject(q);
    const wire = JSON.parse(JSON.stringify(query)) as { find: unknown[] };
    expect(JSON.stringify(wire)).not.toContain("[*]");
    expect(JSON.stringify(wire)).toContain(":comment/text");
    expect(JSON.stringify(wire)).toContain(":comment/issue");
    expect(JSON.stringify(wire)).toContain(":comment/at");
    expect(JSON.stringify(wire)).toContain(":comment/author");
    const pull = JSON.stringify(wire.find);
    expect(pull).toContain("\"id\"");
    expect(pull).toContain("\"text\"");
  });

  test("fluent serializes, JSON-round-trips, and evaluates identically to pipe", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);
    const issueId = ids.fix;

    const fluent = Query.from(Comment)
      .where({ issue: issueId })
      .select(commentShape)
      .orderBy(Comment.at, "asc");
    const piped = Query.q(() =>
      pipe(
        Query.entities(Comment),
        Query.is(Comment.issue, issueId),
        Query.select(commentShape),
        Query.orderBy(Comment.at, "asc"),
      ),
    );

    const fluentWire = lowerQueryObject(fluent).query;
    const pipedWire = lowerQueryObject(piped).query;
    const fluentRound = JSON.parse(JSON.stringify(fluentWire));
    const pipedRound = JSON.parse(JSON.stringify(pipedWire));
    expect(fluentRound).toEqual(fluentWire);
    expect(pipedRound).toEqual(pipedWire);
    expect(fluentRound).toEqual(pipedRound);

    expect(await db.query(fluent)).toEqual(await db.query(piped));
    await peer.dispose();
  });

  test("object-literal where is a conjunction; fragments still compose", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const open = Query.from(Issue)
      .where({ done: false })
      .select({ title: Issue.title })
      .orderBy(Issue.rank, "asc");
    expect(await db.query(open)).toEqual([
      { title: "fix the flake" },
      { title: "ship the release" },
    ]);

    const viaFrag = Query.from(Issue)
      .where(Query.is(Issue.done, false))
      .select({ title: Issue.title })
      .orderBy(Issue.rank, "asc");
    expect(await db.query(viaFrag)).toEqual(await db.query(open));
    await peer.dispose();
  });

  test("conditional where before select assembles (docs spelling)", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);
    let board = Query.from(Issue);
    const owner = ids.ada;
    if (owner) board = board.where({ owner });
    const q = board.select({ id: Issue.id, title: Issue.title });
    const rows = await db.query(q);
    expect(rows.map((r) => r.title).sort()).toEqual([
      "archive the docs",
      "ship the release",
    ]);
    await peer.dispose();
  });

  test(".ids() is today's id-only projection", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);
    const rows = await db.query(Query.from(User).ids());
    const got = new Set(rows.map((r) => r.id));
    expect(got.has(ids.ada.id as (typeof rows)[number]["id"])).toBe(true);
    expect(got.has(ids.grace.id as (typeof rows)[number]["id"])).toBe(true);
    await peer.dispose();
  });

  test("a missing required fact does not drop the entity", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);
    const rows = await db.query(Query.from(User).orderBy(User.name, "asc"));
    const lin = rows.find((r) => r.name === "Lin");
    expect(lin).toBeDefined();
    expect(lin!.age).toBeUndefined();
    await peer.dispose();
  });

  test("inline values inside Query.none bind (module docstring spelling)", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);
    const inbox = (me: number) =>
      Query.from(Issue)
        .where({ done: false })
        .where(Query.none(Comment.issue, Query.is(Comment.author, me)))
        .select({ title: Issue.title })
        .orderBy(Issue.title, "asc");
    expect((await db.query(inbox(ids.ada.id))).map((r) => r.title)).toEqual([
      "ship the release",
    ]);
    expect((await db.query(inbox(ids.grace.id))).map((r) => r.title)).toEqual([
      "fix the flake",
      "ship the release",
    ]);
    await peer.dispose();
  });

  test("inline values inside Query.some bind", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);
    const commented = (me: number) =>
      Query.from(Issue)
        .where(Query.some(Comment.issue, Query.is(Comment.author, me)))
        .select({ title: Issue.title });
    expect((await db.query(commented(ids.ada.id))).map((r) => r.title)).toEqual([
      "fix the flake",
    ]);
    expect(await db.query(commented(ids.grace.id))).toEqual([]);
    await peer.dispose();
  });

  test("inline values inside Query.matching bind", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);
    const q = Query.from(Issue)
      .where(Query.matching(Issue.title, (t) => Q.startsWith(t, "fix")))
      .select({ title: Issue.title })
      .orderBy(Issue.title, "asc");
    expect((await db.query(q)).map((r) => r.title)).toEqual(["fix the flake"]);
    await peer.dispose();
  });

  test("inline values inside a nested select where bind", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);
    const q = (who: number) =>
      Query.from(Issue)
        .select({
          title: Issue.title,
          theirs: Comment.issue.reverse.select(
            { text: Comment.text },
            { where: [Query.is(Comment.author, who)] },
          ),
        })
        .orderBy(Issue.title, "asc");
    const rows = await db.query(q(ids.ada.id));
    expect(rows.find((r) => r.title === "fix the flake")!.theirs).toEqual([{ text: "on it" }]);
    const grace = await db.query(q(ids.grace.id));
    expect(grace.find((r) => r.title === "fix the flake")!.theirs).toEqual([]);
    await peer.dispose();
  });

  test("orderBy string key resolves against the default entity shape", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);
    const rows = await db.query(Query.from(Issue).orderBy("title", "asc"));
    expect(rows.map((r) => r.title)).toEqual([
      "archive the docs",
      "fix the flake",
      "ship the release",
    ]);
    await peer.dispose();
  });

  test("the later of .ids() / .select() wins", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);
    const titled = await db.query(Query.from(Issue).ids().select({ title: Issue.title }));
    expect(titled.every((r) => typeof r.title === "string")).toBe(true);
    const onlyIds = await db.query(Query.from(Issue).select({ title: Issue.title }).ids());
    expect(onlyIds.every((r) => "id" in r && !("title" in r))).toBe(true);
    await peer.dispose();
  });

  test("where() with no arguments throws a ramose/query message", () => {
    expect(() => (Query.from(Issue).where as (arg?: unknown) => unknown)()).toThrow(
      /ramose\/query: where\(\)/,
    );
  });
});

// ── #189: orderBy/limit on Query.q, Q.value, fluent aggregate select ───────

describe("query: aggregates with order/limit and scalar value", () => {
  test("Query.q(...).orderBy(r => r.n).limit(n) is top-N by aggregate", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const top = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const owner = yield* Query.follow(Issue.owner)(issue);
      const name = yield* Q.fact(owner, User.name);
      return { owner: name.v, n: Q.count(issue) };
    })
      .orderBy((r) => r.n, "desc")
      .limit(1);

    const { query } = lowerQueryObject(top);
    expect(query.limit).toBe(1);
    expect(query.order).toEqual([{ var: expect.stringMatching(/^\?q/), dir: "desc", empty: "last" }]);

    const rows = await db.query(top);
    expect(rows).toEqual([{ owner: "Ada", n: 2 }] as never);

    await peer.dispose();
  });

  test("orderBy a bound var sorts by a joined field", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const byOwner = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const owner = yield* Query.follow(Issue.owner)(issue);
      const name = yield* Q.fact(owner, User.name);
      const title = yield* Q.fact(issue, Issue.title);
      return { title: title.v, owner: name.v };
    }).orderBy((r) => r.owner, "asc");

    const rows = await db.query(byOwner);
    expect(rows.map((r) => r.owner)).toEqual(["Ada", "Ada", "Grace"]);
    expect(rows.map((r) => r.title).sort()).toEqual([
      "archive the docs",
      "fix the flake",
      "ship the release",
    ]);

    await peer.dispose();
  });

  test("Q.value(Q.count(e)) is a number, 0 over no matches", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const open = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.done, false)(issue);
      return Q.value(Q.count(issue));
    });
    expect(lowerQueryObject(open).query.find).toEqual([["count", expect.stringMatching(/^\?q/)], "."]);
    expect(await db.query(open)).toBe(2);

    const none = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.title, "no such issue")(issue);
      return Q.value(Q.count(issue));
    });
    expect(await db.query(none)).toBe(0);

    await peer.dispose();
  });

  test("fluent select(shape, extras) groups by the shape and counts the focus", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const top = Query.from(Issue)
      .select({ owner: Issue.owner.select({ name: User.name }) }, { n: Q.count(Q.focus) })
      .orderBy((r) => r.n, "desc")
      .limit(1);

    const rows = await db.query(top);
    expect(rows).toEqual([{ owner: { name: "Ada" }, n: 2 }] as never);

    const piped = Query.q(() =>
      pipe(
        Query.entities(Issue),
        Query.select({ owner: Issue.owner.select({ name: User.name }) }, { n: Q.count(Q.focus) }),
        Query.orderBy("n", "desc"),
        Query.limit(1),
      ),
    );
    expect(await db.query(piped)).toEqual(rows);

    const viaCb = Query.from(Issue).select({ done: Issue.done }, (e) => ({ n: Q.count(e) }));
    const grouped = [...(await db.query(viaCb))].sort((a, b) => Number(a.done) - Number(b.done));
    expect(grouped).toEqual([
      { done: false, n: 2 },
      { done: true, n: 1 },
    ] as never);

    await peer.dispose();
  });

  test("orderBy on a multi-root projection no longer promises a missing API", () => {
    const q = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const title = yield* Q.fact(issue, Issue.title);
      return { title: title.v, n: Q.count(issue) };
    }).orderBy((r) => r.title, "asc");
    expect(() => lowerQueryObject(q)).not.toThrow(/bound vars/);
    const { query } = lowerQueryObject(q);
    expect(query.order).toEqual([{ var: expect.stringMatching(/^\?q/), dir: "asc", empty: "last" }]);
  });

  test("select id + count reads a number and orders by the id, not the count", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const grouped = Query.from(Issue).select({ id: Issue.id }, { n: Q.count(Q.focus) });
    const rows = await db.query(grouped);
    expect(rows.every((r) => typeof r.id === "number")).toBe(true);
    expect(rows.every((r) => r.n === 1)).toBe(true);
    expect(rows).toHaveLength(3);

    const desc = await db.query(grouped.orderBy((r) => r.id, "desc"));
    const asc = await db.query(grouped.orderBy((r) => r.id, "asc"));
    expect(desc.map((r) => r.id)).toEqual([...asc.map((r) => r.id)].reverse());

    const nested = Query.from(Comment).select(
      { issue: Comment.issue.select({ id: Issue.id, title: Issue.title }) },
      { n: Q.count(Q.focus) },
    );
    const nestedRows = await db.query(nested);
    expect(nestedRows.every((r) => typeof r.issue.id === "number")).toBe(true);
    expect(nestedRows.every((r) => typeof r.issue.title === "string")).toBe(true);

    await peer.dispose();
  });

  test("select extras keep optional and defaulted group keys", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const optional = Query.from(User).select({ age: User.age.optional }, { n: Q.count(Q.focus) });
    const optionalRows = [...(await db.query(optional))].sort(
      (a, b) => Number(a.age ?? -1) - Number(b.age ?? -1),
    );
    expect(optionalRows).toHaveLength(3);
    expect(optionalRows.reduce((s, r) => s + r.n, 0)).toBe(3);
    expect(optionalRows.some((r) => r.age == null)).toBe(true);

    const defaulted = Query.from(User).select({ age: User.age.orDefault(0) }, { n: Q.count(Q.focus) });
    const defaultRows = [...(await db.query(defaulted))].sort((a, b) => a.age - b.age);
    expect(defaultRows).toEqual([
      { age: 0, n: 1 },
      { age: 36, n: 1 },
      { age: 45, n: 1 },
    ] as never);

    await peer.dispose();
  });

  test("orderBy a nested select key walks from the focus", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const byOwner = Query.from(Issue)
      .select({ title: Issue.title, owner: Issue.owner.select({ name: User.name }) })
      .orderBy((r) => r.owner.name, "asc");
    const where = lowerQueryObject(byOwner).query.where as readonly unknown[];
    // The pull's required clauses also mention these idents. The sort path
    // is the or-join that walks both hops from the Issue — the pre-fix
    // no-op hung only `:user/name` off the issue var.
    const orderJoin = where.find((clause) => {
      const s = JSON.stringify(clause);
      return s.includes('"or-join"') && s.includes('":issue/owner"') && s.includes('":user/name"');
    });
    expect(orderJoin).toBeDefined();
    const asc = await db.query(byOwner);
    expect(asc.map((r) => r.owner.name)).toEqual(["Ada", "Ada", "Grace"]);

    const desc = await db.query(
      Query.from(Issue)
        .select({ title: Issue.title, owner: Issue.owner.select({ name: User.name }) })
        .orderBy((r) => r.owner.name, "desc"),
    );
    expect(desc.map((r) => r.owner.name)).toEqual(["Grace", "Ada", "Ada"]);

    await peer.dispose();
  });

  test("logic() after one() / after() returns the rows array", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const taken = Query.from(Issue).select({ title: Issue.title }).orderBy("title").one();
    const rows = await db.query(taken.logic());
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(3);

    const paged = Query.from(Issue).select({ title: Issue.title }).orderBy("title").after(null);
    const unpaged = await db.query(paged.logic());
    expect(Array.isArray(unpaged)).toBe(true);
    expect((unpaged as { rows?: unknown }).rows).toBeUndefined();

    await peer.dispose();
  });

  test("mixed orderBy spellings keep call order as sort-key precedence", () => {
    const rankThenTitle = Query.from(Issue)
      .select({ title: Issue.title, rank: Issue.rank })
      .orderBy((r) => r.rank, "desc")
      .orderBy("title", "asc");
    const titleThenRank = Query.from(Issue)
      .select({ title: Issue.title, rank: Issue.rank })
      .orderBy("title", "asc")
      .orderBy((r) => r.rank, "desc");
    const a = lowerQueryObject(rankThenTitle).query.order as readonly { var: string; dir: string }[];
    const b = lowerQueryObject(titleThenRank).query.order as readonly { var: string; dir: string }[];
    expect(a.map((o) => o.dir)).toEqual(["desc", "asc"]);
    expect(b.map((o) => o.dir)).toEqual(["asc", "desc"]);
  });

  test("bare card-one backlink group key binds the referrer, not the focus", async () => {
    const Child = Entity("aggchild", { title: Field(Schema.String) });
    const Parent = Entity("aggparent", {
      name: Field(Schema.String),
      kid: Field.owned(Ref(() => Child)),
    });
    const Family = DbSchema({ aggchild: Child, aggparent: Parent });
    const peer = await inProcessPeer();
    const db = peer.ramose.db("family", Family);
    await db.install();
    await run(
      seedWrite(db, function* (tx) {
        const child = yield* tx.entity();
        yield* child.set(Child.title, "only");
        const parent = yield* tx.entity();
        yield* parent.set(Parent.name, "Ada");
        yield* parent.set(Parent.kid, child.eid as never);
      }),
    );

    const q = Query.from(Child).select({ p: Parent.kid.reverse }, { n: Q.count(Q.focus) });
    const { query } = lowerQueryObject(q);
    const find = query.find as unknown[];
    const parentVar = find[0];
    const countOf = (find[1] as [string, string])[1];
    expect(parentVar).not.toEqual(countOf);

    const parents = await db.query(Query.from(Parent).select({ id: Parent.id, name: Parent.name }));
    const children = await db.query(Query.from(Child).select({ id: Child.id, title: Child.title }));
    const rows = await db.query(q);
    expect(rows).toHaveLength(1);
    const pId =
      typeof rows[0].p === "object" && rows[0].p !== null && "id" in rows[0].p
        ? (rows[0].p as { id: number }).id
        : Number(rows[0].p);
    expect(pId).toBe(parents[0].id);
    expect(pId).not.toBe(children[0].id);
    expect(rows[0].n).toBe(1);

    await peer.dispose();
  });

  test("orderBy a group-key string or attribute reuses the :find var", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const piped = Query.q(() =>
      pipe(
        Query.entities(Issue),
        Query.select({ title: Issue.title }, { n: Q.count(Q.focus) }),
        Query.orderBy("title", "desc"),
      ),
    );
    const fluent = Query.from(Issue)
      .select({ title: Issue.title }, { n: Q.count(Q.focus) })
      .orderBy(Issue.title, "desc");
    const byString = Query.from(Issue)
      .select({ title: Issue.title }, { n: Q.count(Q.focus) })
      .orderBy("title", "desc");
    const byPicker = Query.from(Issue)
      .select({ title: Issue.title }, { n: Q.count(Q.focus) })
      .orderBy((r) => r.title, "desc");

    const pipeLowered = lowerQueryObject(piped).query;
    const fluentLowered = lowerQueryObject(fluent).query;
    expect(fluentLowered).toEqual(pipeLowered);
    expect(lowerQueryObject(byString).query).toEqual(pipeLowered);
    expect(lowerQueryObject(byPicker).query).toEqual(pipeLowered);

    const orderVar = (pipeLowered.order as readonly { var: string }[])[0]!.var;
    expect(pipeLowered.find).toContain(orderVar);
    expect(JSON.stringify(pipeLowered.where)).not.toContain("or-join");

    const titles = ["ship the release", "fix the flake", "archive the docs"] as const;
    expect((await db.query(piped)).map((r) => r.title)).toEqual([...titles]);
    expect((await db.query(fluent)).map((r) => r.title)).toEqual([...titles]);

    expect(() =>
      lowerQueryObject(
        Query.from(Issue)
          .select({ title: Issue.title }, { n: Q.count(Q.focus) })
          .orderBy(Issue.rank, "asc"),
      ),
    ).toThrow(/not a group key/);

    await peer.dispose();
  });

  test("pipe orderBy after extras then ids() / select raises a ramose/query error, not TypeError", () => {
    const afterIds = Query.q(() =>
      pipe(
        Query.entities(Issue),
        Query.select({ title: Issue.title }, { n: Q.count(Q.focus) }),
        Query.orderBy("title", "desc"),
        Query.ids(),
      ),
    );
    expect(() => lowerQueryObject(afterIds)).toThrow(/no column "title"/);
    expect(() => lowerQueryObject(afterIds)).not.toThrow(/path\.map/);

    const afterSelect = Query.q(() =>
      pipe(
        Query.entities(Issue),
        Query.select({ title: Issue.title }, { n: Q.count(Q.focus) }),
        Query.orderBy("title", "desc"),
        Query.select({ title: Issue.title }),
      ),
    );
    expect(() => lowerQueryObject(afterSelect)).not.toThrow(/path\.map/);
    const { query } = lowerQueryObject(afterSelect);
    expect(query.order).toEqual([
      { var: expect.stringMatching(/^\?o/), dir: "desc", empty: "last" },
    ]);

    expect(() =>
      lowerQueryObject(Query.from(Issue).select({ title: Issue.title }, { n: Q.count(Q.focus) }).orderBy("title", "desc").ids()),
    ).toThrow(/no column "title"/);
  });

  test("after() on a multi-root projection raises a ramose/query error", () => {
    const q = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      const title = yield* Q.fact(issue, Issue.title);
      return { title: title.v, n: Q.count(issue) };
    })
      .orderBy((r) => r.title, "asc")
      .after(null);
    expect(() => lowerQueryObject(q)).toThrow(/no paging root/);
  });
});
