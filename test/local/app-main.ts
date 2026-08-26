/**
 * Host-Worker fetch handler. Bundled as-is (async Worker, no Effect
 * entry) so workerd never evaluates `Ramose.Server` or Alchemy.Stack.
 *
 * Uses the same client factory as `Ramose.Databases(Server)`: a service
 * binding `fetch` and no WebSocket (live is unavailable on this hop).
 */

import * as Effect from "effect/Effect";
import { makeDatabases } from "../../packages/ramose/src/db/factory.ts";
import { createNamed, Movies, User } from "./ops.ts";
import * as Ramose from "ramose/db";

const namesQuery = Ramose.Query.from(User).select({ name: User.name });

type Peer = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const databasesThrough = (peer: Peer) =>
  makeDatabases({
    url: Effect.succeed("https://ramose.internal"),
    fetch: (url, init) =>
      peer.fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      }),
  }).databases;

export default {
  async fetch(request: Request, env: { Open: Peer }): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return Response.json({ ok: true, via: "service-binding" });
    }
    if (!path.startsWith("/t/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const name = path.slice("/t/".length);
    const ramose = databasesThrough(env.Open);
    try {
      const db = ramose.db(name, Movies);
      if (request.method === "PUT") {
        const report = await db.install();
        return Response.json({ name, t: report.t });
      }
      const report = await db.run(createNamed, { name: "Ada" });
      const names = await report.dbAfter.query(namesQuery);
      return Response.json({
        name,
        t: report.t,
        names: names.map((row) => row.name),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  },
};
