/**
 * The `DB_SEAM` contract `ramose/react` rides (`DbSeam` in `Db.ts`,
 * `packages/ramose/src/react/seam.ts` the reader): a structural view key, the
 * pinned `asOf` coordinate, and the session's wake. Not public API, but a
 * contract all the same.
 */

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  DB_SEAM,
  type DbSeam,
  Query,
  type ReadDb,
  seedWrite,
} from "../src/db/internal.ts";
import { client, fakePeer, httpsClient, settle, until } from "./peer.ts";
import { Movies, User } from "./db/fixture.ts";

const seamOf = (db: ReadDb): DbSeam =>
  (db as unknown as Record<symbol, DbSeam>)[DB_SEAM]!;

describe("the view key is structural", () => {
  test("same coordinates, same key — across calls and across view spellings", async () => {
    const c = client(fakePeer());
    const db = c.ramose.db("movies", Movies);

    expect(seamOf(db.asOf(3)).key).toBe(seamOf(db.asOf(3)).key);
    expect(seamOf(db).key).toBe(seamOf(c.ramose.db("movies", Movies)).key);
    expect(seamOf(db.history).key).toBe(seamOf(db.history).key);
    await c.dispose();
  });

  test("a different coordinate, name, or client is a different key", async () => {
    const a = client(fakePeer());
    const b = client(fakePeer());
    const db = a.ramose.db("movies", Movies);
    const report = await Effect.runPromise(
      seedWrite(db, function* () {}),
    );

    const keys = [
      seamOf(db).key,
      seamOf(db.asOf(3)).key,
      seamOf(db.asOf(4)).key,
      seamOf(db.history).key,
      // overlay dbAfter is the same live view (no minT fence)
      seamOf(a.ramose.db("other", Movies)).key,
      seamOf(b.ramose.db("movies", Movies)).key,
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(seamOf(report.dbAfter).key).toBe(seamOf(db).key);

    const https = httpsClient(fakePeer());
    const httpsDb = https.databases.db("movies", Movies);
    const httpsReport = await Effect.runPromise(
      seedWrite(httpsDb, function* () {}),
    );
    expect(seamOf(httpsReport.dbAfter).key).not.toBe(seamOf(httpsDb).key);
    https.close();
    await a.dispose();
    await b.dispose();
  });
});

describe("the pinned coordinate", () => {
  test("asOf carries its t; live and history carry undefined", async () => {
    const c = client(fakePeer());
    const db = c.ramose.db("movies", Movies);
    expect(seamOf(db.asOf(3)).asOf).toBe(3);
    expect(seamOf(db).asOf).toBeUndefined();
    expect(seamOf(db.history).asOf).toBeUndefined();
    await c.dispose();
  });
});

describe("the wake", () => {
  test("a { op: tx } frame calls the subscriber; unsubscribe stops it", async () => {
    const peer = fakePeer();
    const c = client(peer);
    const db = c.ramose.db("movies", Movies);

    let wakes = 0;
    const off = seamOf(db).onWake(() => {
      wakes += 1;
    });
    expect(off).toBeDefined();

    // unsolicited frames ride the session socket, which a first read opens
    await db.query(Query.q(() => Query.entities(User)));
    peer.push({ op: "tx", t: 9, datoms: [] });
    await until(() => wakes > 0);
    expect(wakes).toBeGreaterThan(0);

    // the seam reads the session's basis, so a waker can tell a wake that
    // carries news from one its own `/info` observation caused
    expect(seamOf(db).t()).toBe(9);

    const seen = wakes;
    off!();
    peer.push({ op: "tx", t: 12, datoms: [] });
    await settle();
    expect(wakes).toBe(seen);
    await c.dispose();
  });

  test("an HTTPS-only client has nothing to wake on", () => {
    const peer = fakePeer();
    const { databases, close } = httpsClient(peer);
    const db = databases.db("movies", Movies);
    expect(seamOf(db).onWake(() => {})).toBeUndefined();
    expect(seamOf(db).t()).toBeUndefined();
    close();
  });
});
