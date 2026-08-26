/**
 * Host-Worker fetch handler. Bundled as-is (async Worker, no Effect
 * entry) so workerd never evaluates `Ramose.Server` or Alchemy.Stack.
 *
 * `env.Open` is the service binding to the owned open peer — the same
 * hop `Ramose.Databases(Server)` lowers onto (`env[LogicalId].fetch`).
 */

import * as Ramose from "ramose/db";
import { createNamed, Movies, User } from "./ops.ts";

const namesQuery = Ramose.Query.from(User).select({ name: User.name });

type Peer = { fetch: typeof fetch };

const connectThrough = (peer: Peer) =>
  Ramose.connect({
    url: "https://ramose.internal",
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      peer.fetch(input as RequestInfo, init)) as typeof fetch,
  });

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
    const ramose = connectThrough(env.Open);
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
    } finally {
      await ramose.close();
    }
  },
};
