/**
 * The redesigned query surface: `Query.q(params, body)` over the kernel
 * (`Q.fact`, comparisons, `Q.or`/`Q.not`, rules), the pipeable stdlib, and
 * whole-query delegation — lowering shape and end-to-end against the real
 * engine through an in-process peer.
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
  Attr,
  Catalog,
  Databases,
  EidOf,
  Long,
  Namespace,
  NotOne,
  ParamError,
  Q,
  Query,
  Ref,
  layer,
  lowerQueryObject,
  optional,
  type Db,
} from "../../src/db/internal.ts";

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);

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

const User = Namespace("user", {
  name: Attr(Schema.String, { unique: "identity" }),
  age: Attr(Long),
});

const Issue = Namespace("issue", {
  title: Attr(Schema.String),
  done: Attr(Schema.Boolean),
  rank: Attr(Long),
  owner: Attr(Ref(() => User)),
});

const Comment = Namespace("comment", {
  issue: Attr(Ref(() => Issue)),
  author: Attr(Ref(() => User)),
  text: Attr(Schema.String),
});

const Team = Namespace("team", {
  name: Attr(Schema.String),
  members: Attr(Ref(() => User), { cardinality: "many" }),
  parent: Attr(Ref.self),
});

const Tracker = Catalog({ user: User, issue: Issue, comment: Comment, team: Team });

/** Seed the running example; answers the eids the tests bind. */
const seed = async (db: Db<typeof Tracker>) => {
  const out: Record<string, { readonly id: number }> = {};
  await run(db.install());
  await run(
    db.transact(function* (tx) {
      const ada = yield* tx.entity();
      yield* ada.add(User.name, "Ada");
      yield* ada.add(User.age, 36);
      const grace = yield* tx.entity();
      yield* grace.add(User.name, "Grace");
      yield* grace.add(User.age, 45);

      const ship = yield* tx.entity();
      yield* ship.add(Issue.title, "ship the release");
      yield* ship.add(Issue.done, false);
      yield* ship.add(Issue.rank, 3);
      yield* ship.add(Issue.owner, ada.eid as never);
      const fix = yield* tx.entity();
      yield* fix.add(Issue.title, "fix the flake");
      yield* fix.add(Issue.done, false);
      yield* fix.add(Issue.rank, 1);
      yield* fix.add(Issue.owner, grace.eid as never);
      const docs = yield* tx.entity();
      yield* docs.add(Issue.title, "archive the docs");
      yield* docs.add(Issue.done, true);
      yield* docs.add(Issue.rank, 2);
      yield* docs.add(Issue.owner, ada.eid as never);

      // Ada commented on "fix the flake"; nobody commented on "ship"
      const c1 = yield* tx.entity();
      yield* c1.add(Comment.issue, fix.eid as never);
      yield* c1.add(Comment.author, ada.eid as never);
      yield* c1.add(Comment.text, "on it");

      // Lin has no age — the `missing` combinator's witness
      const lin = yield* tx.entity();
      yield* lin.add(User.name, "Lin");

      const root = yield* tx.entity();
      yield* root.add(Team.name, "root");
      yield* root.add(Team.members, ada.eid as never);
      const eng = yield* tx.entity();
      yield* eng.add(Team.name, "eng");
      yield* eng.add(Team.parent, root.eid as never);
      yield* eng.add(Team.members, grace.eid as never);

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
    const rows = (await run(db.q(byName(attr)))) as unknown as readonly {
      id: { id: number };
      name: string;
    }[];
    for (const r of rows) {
      const key = (keys as Record<string, string>)[r.name as string];
      if (key !== undefined) out[key] = r.id;
    }
  }
  return out;
};

// ── the design record's inbox, both spellings ──────────────────────────────

const inboxPipe = Query.q({ me: EidOf(User) }, (p) =>
  pipe(
    Query.entities(Issue),
    Query.is(Issue.done, false),
    Query.none(Comment.issue, Query.is(Comment.author, p.me)),
    Query.select({ id: Issue.id, title: Issue.title }),
    Query.orderBy("title"),
    Query.limit(50),
  ),
);

const inboxGen = Query.q({ me: EidOf(User) }, function* (p) {
  const issue = yield* Query.entities(Issue);
  yield* Query.is(Issue.done, false)(issue);
  yield* Query.none(Comment.issue, Query.is(Comment.author, p.me))(issue);
  return Q.pull(issue, { id: Issue.id, title: Issue.title });
});

describe("lowering", () => {
  test("the inbox pipe: entailment skips membership, cursor lowers, params substitute", () => {
    const { query } = lowerQueryObject(inboxPipe, { me: { id: 42 } });
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
    const p = lowerQueryObject(inboxPipe.logic(), { me: { id: 7 } });
    const g = lowerQueryObject(inboxGen, { me: { id: 7 } });
    expect(g.query.where).toEqual(p.query.where);
    expect(g.query.find).toEqual(p.query.find);
  });

  test("lowering is deterministic — the same value lowers to the same wire", () => {
    const a = JSON.stringify(lowerQueryObject(inboxPipe, { me: { id: 7 } }).query);
    const b = JSON.stringify(lowerQueryObject(inboxPipe, { me: { id: 7 } }).query);
    expect(a).toBe(b);
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

  test("a required param is checked at lowering", () => {
    expect(() => lowerQueryObject(inboxPipe, {})).toThrow(ParamError);
    expect(() => lowerQueryObject(inboxPipe, { me: { id: 1 }, extra: 2 } as never)).toThrow(ParamError);
  });

  test("open refuses a cursor; logic() strips it", () => {
    const outer = Query.q({ me: EidOf(User) }, function* (p) {
      const { focus } = yield* inboxPipe.open({ me: p.me });
      return Q.pull(focus, { title: Issue.title });
    });
    expect(() => lowerQueryObject(outer, { me: { id: 1 } })).toThrow(/does not delegate/);

    const stripped = Query.q({ me: EidOf(User) }, function* (p) {
      const { focus } = yield* inboxPipe.logic().open({ me: p.me });
      return Q.pull(focus, { title: Issue.title });
    });
    const { query } = lowerQueryObject(stripped, { me: { id: 1 } });
    expect(query.limit).toBeUndefined();
    expect(query.order).toBeUndefined();
  });
});

describe("db.q end to end", () => {
  test("the inbox: quantifier, params, order, limit", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    // Ada commented on "fix the flake", so her inbox is only "ship ..."
    const ada = await run(db.q(inboxPipe, { me: ids.ada as never }));
    expect(ada.map((r) => r.title)).toEqual(["ship the release"]);
    // Grace commented on nothing: both open issues, ordered by title
    const grace = await run(db.q(inboxPipe, { me: ids.grace as never }));
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
    const rows = await run(db.q(owners));
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
    const rows = await run(db.q(q));
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
    const rows = await run(db.q(ownersOfOpen));
    expect(rows.map((r) => r.name).sort()).toEqual(["Ada", "Grace"]);

    const commenters = Query.q({ issue: EidOf(Issue) }, function* (p) {
      const comment = yield* Query.backlink(Comment.issue)(p.issue as never);
      const author = yield* Query.follow(Comment.author)(comment);
      const name = yield* Q.fact(author, User.name);
      return { name: name.v };
    });
    const who = await run(db.q(commenters, { issue: ids.fix as never }));
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
    const rows = await run(db.q(q));
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

    const membersOf = Query.q({ team: EidOf(Team) }, function* (p) {
      const user = yield* Query.entities(User);
      yield* inTeam(user, p.team);
      const name = yield* Q.fact(user, User.name);
      return { name: name.v };
    });

    const root = await run(db.q(membersOf, { team: ids.root as never }));
    expect(root.map((r) => r.name).sort()).toEqual(["Ada", "Grace"]);
    const eng = await run(db.q(membersOf, { team: ids.eng as never }));
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

    const rows = await run(db.q(q));
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
    const rows = await run(db.q(withOwner));
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
    const enriched = await run(db.q(withLastUpdated(openIssues)));
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

    // open issues owned by a member of the given team
    const escalations = Query.q({ team: EidOf(Team) }, function* (p) {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.done, false)(issue);
      const owner = yield* Query.follow(Issue.owner)(issue);
      yield* Q.fact(p.team, Team.members, owner);
      return Q.pull(issue, { title: Issue.title });
    });

    const teamDigest = Query.q({ me: EidOf(User) }, function* (p) {
      const team = yield* Query.entities(Team);
      yield* Q.fact(team, Team.members, p.me);
      const { cols } = yield* escalations.open({ team });
      return Q.rows({ team: Q.pull(team, { name: Team.name }), esc: cols });
    });

    const ada = await run(db.q(teamDigest, { me: ids.ada as never }));
    expect(ada).toEqual([{ team: { name: "root" }, esc: { title: "ship the release" } }] as never);
    const grace = await run(db.q(teamDigest, { me: ids.grace as never }));
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
    const rows = await run(db.q(adaOnly));
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
    const rows = await run(db.q(perOwner));
    const sorted = [...rows].sort((a, b) => String(a.owner).localeCompare(String(b.owner)));
    expect(sorted).toEqual([
      { owner: "Ada", n: 2 },
      { owner: "Grace", n: 1 },
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
    expect(await run(db.q(stats))).toEqual([
      { n: 0, total: 0, top: null, mean: null },
    ] as never);

    // …so one() always has its row, and rows[0].n needs no ?? 0
    const count = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.title, "no such issue")(issue);
      return { n: Q.count(issue) };
    });
    expect(await run(db.q(count.one()))).toEqual({ n: 0 } as never);

    // a projection with a group key correctly stays []: no rows, no groups
    const grouped = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.title, "no such issue")(issue);
      const t = yield* Q.fact(issue, Issue.title);
      return { title: t.v, n: Q.count(issue) };
    });
    expect(await run(db.q(grouped))).toEqual([]);

    // a non-empty match set is untouched by the synthesis
    const open = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.is(Issue.done, false)(issue);
      return { n: Q.count(issue) };
    });
    expect(await run(db.q(open))).toEqual([{ n: 2 }] as never);

    await peer.dispose();
  });

  test("where, missing, every, and Q.in", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    await seed(db);

    const inList = Query.q(() =>
      pipe(
        Query.entities(Issue),
        Query.where(Issue.title, (t) => Q.in(t, ["fix the flake", "not a title"])),
        Query.select({ title: Issue.title }),
      ),
    );
    expect(await run(db.q(inList))).toEqual([{ title: "fix the flake" }] as never);

    const ageless = Query.q(() =>
      pipe(Query.entities(User), Query.missing(User.age), Query.select({ name: User.name })),
    );
    expect(await run(db.q(ageless))).toEqual([{ name: "Lin" }] as never);

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
    const rows = await run(db.q(allAda));
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

    const byTitle = Query.q({ title: Issue.title }, (p) =>
      pipe(
        Query.entities(Issue),
        Query.is(Issue.title, p.title),
        Query.select({ title: Issue.title, rank: Issue.rank }),
      ),
    );

    // lowering forces the limit: one row for one(), two so a second match is witnessed
    expect(lowerQueryObject(byTitle.one(), { title: "x" }).query.limit).toBe(1);
    expect(lowerQueryObject(byTitle.oneOrFail(), { title: "x" }).query.limit).toBe(2);

    const hit = await run(db.q(byTitle.one(), { title: "ship the release" }));
    expect(hit).toEqual({ title: "ship the release", rank: 3 } as never);
    expect(await run(db.q(byTitle.one(), { title: "nope" }))).toBeNull();

    const exact = await run(db.q(byTitle.oneOrFail(), { title: "fix the flake" }));
    expect(exact.rank).toBe(1);

    const missing = await run(Effect.flip(db.q(byTitle.oneOrFail(), { title: "nope" })));
    expect(missing).toBeInstanceOf(NotOne);
    expect((missing as NotOne).found).toBe(0);

    const openIssues = Query.q(() =>
      pipe(Query.entities(Issue), Query.is(Issue.done, false), Query.select({ title: Issue.title })),
    );
    const two = await run(Effect.flip(db.q(openIssues.oneOrFail())));
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

    const p1 = await run(db.q(byRank.after(null)));
    expect(p1.rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(p1.cursor).not.toBeNull();

    const p2 = await run(db.q(byRank.after(p1.cursor)));
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

  test("when: a param-gated clause group splices or drops at lowering", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    // an optional param gates on being bound; inside the body it is bound
    const board = Query.q({ owner: optional(EidOf(User)) }, (p) =>
      pipe(
        Query.entities(Issue),
        Query.when(p.owner, Query.is(Issue.owner, p.owner)),
        Query.select({ title: Issue.title }),
      ),
    );

    const all = await run(db.q(board, {}));
    expect(all).toHaveLength(3);
    const adas = await run(db.q(board, { owner: ids.ada as never }));
    expect(adas.map((r) => r.title).sort()).toEqual(["archive the docs", "ship the release"]);

    // gate off, the clause lowers to nothing
    const off = lowerQueryObject(board, {});
    expect(JSON.stringify(off.query.where)).not.toContain(":issue/owner");

    // a required boolean param gates on its value — the generator spelling
    const listing = Query.q({ onlyOpen: Schema.Boolean }, function* (p) {
      const issue = yield* Query.entities(Issue);
      yield* Q.when(p.onlyOpen, Query.is(Issue.done, false)(issue));
      const t = yield* Q.fact(issue, Issue.title);
      return { title: t.v };
    });
    expect(await run(db.q(listing, { onlyOpen: true }))).toHaveLength(2);
    expect(await run(db.q(listing, { onlyOpen: false }))).toHaveLength(3);

    // an unbound optional referenced outside its when is still a ParamError
    const loose = Query.q({ owner: optional(EidOf(User)) }, (p) =>
      pipe(Query.entities(Issue), Query.is(Issue.owner, p.owner), Query.select({ title: Issue.title })),
    );
    expect(() => lowerQueryObject(loose, {})).toThrow(ParamError);

    // when does not nest into or/not: an off gate would blank the branch
    const inOr = Query.q({ onlyOpen: Schema.Boolean }, function* (p) {
      const issue = yield* Query.entities(Issue);
      // the type system rejects this too — the cast exercises the runtime guard
      yield* Q.or(Q.when(p.onlyOpen, Query.is(Issue.done, false)(issue)) as never);
      const t = yield* Q.fact(issue, Issue.title);
      return { title: t.v };
    });
    expect(() => lowerQueryObject(inOr, { onlyOpen: true })).toThrow(/cannot appear inside/);

    await peer.dispose();
  });

  test("time is ordinary clauses: updatedSince windows on the basis t", async () => {
    const peer = await inProcessPeer();
    const db = peer.ramose.db("tracker", Tracker);
    const ids = await seed(db);

    const report = await run(
      db.transact(function* (tx) {
        const late = yield* tx.entity();
        yield* late.add(Issue.title, "the late arrival");
        yield* late.add(Issue.done, false);
        yield* late.add(Issue.rank, 9);
        yield* late.add(Issue.owner, ids.ada!.id as never);
      }),
    );

    const recent = Query.q(function* () {
      const issue = yield* Query.entities(Issue);
      yield* Query.updatedSince(report.t)(issue);
      const t = yield* Q.fact(issue, Issue.title);
      return { title: t.v };
    });
    const rows = await run(db.q(recent));
    expect(rows.map((r) => r.title)).toEqual(["the late arrival"]);

    await peer.dispose();
  });
});
