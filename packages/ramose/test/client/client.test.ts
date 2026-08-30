/**
 * Client construction, interning and terminality (#477 slice 1).
 *
 * Everything asserted here is deliberately reachable with no browser at all:
 * that is the point. `createClient` and `open()` must perform no storage,
 * network, authorization, or query work, so they run in an ordinary process
 * where `indexedDB` and the server both simply do not exist.
 */

import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { Catalog } from "../../src/Catalog.ts";
import { Entity, Field, Schema, string } from "../../src/db/internal.ts";
import { compileReadAuthorization } from "../../src/internal/authorization/index.ts";
import { queryObservationKey } from "../../src/client/database.ts";
import {
  ClientClosedError,
  ClientConfigurationError,
  ClientLocalDataError,
  createClient,
  type ClientOptions,
} from "../../src/client/index.ts";

const Note = Entity("note", { title: Field.unique(string(), "strict") });
const Notes = Schema({ note: Note });
const NotesCatalog = Catalog("client-notes", {
  schema: Notes,
  policy: await Effect.runPromise(compileReadAuthorization({ schema: Notes, rules: [] })),
});

const auth = () => ({ token: "bearer-a", cacheKey: "account-a" });

const options = (overrides: Partial<ClientOptions> = {}): ClientOptions => ({
  url: "https://data.example.com",
  root: "app",
  catalog: NotesCatalog,
  auth,
  ...overrides,
});

describe("createClient", () => {
  test("binds one origin, root, catalog and auth provider, inertly", () => {
    const client = createClient(options());
    // Nothing was opened, fetched or hashed: the process has no `indexedDB`
    // and no server, and constructing a client and its root handle is still
    // total.
    expect(client.sync.getSnapshot().status).toBe("idle");
    expect(typeof client.open().query.from).toBe("function");
    expect(client.sync.getSnapshot().status).toBe("idle");
  });

  test("returns one interned root handle from an argument-free open()", () => {
    const client = createClient(options());
    const root = client.open();
    expect(client.open()).toBe(root);
    // The root route is configuration, so `open` takes nothing that could
    // select another database.
    expect(client.open.length).toBe(0);
  });

  test("refuses configuration that can never become valid", () => {
    expect(() => createClient(options({ url: "https://data.example.com/app" })))
      .toThrow(ClientConfigurationError);
    expect(() => createClient(options({ url: "http://data.example.com" })))
      .toThrow(ClientConfigurationError);
    expect(() => createClient(options({ url: "https://a:b@data.example.com" })))
      .toThrow(ClientConfigurationError);
    expect(() => createClient(options({ root: "" })))
      .toThrow(ClientConfigurationError);
    expect(() => createClient(options({ root: "app/child" })))
      .toThrow(ClientConfigurationError);
    expect(() => createClient(options({ catalog: { key: "app" } as never })))
      .toThrow(ClientConfigurationError);
    expect(() => createClient(options({ auth: undefined as never })))
      .toThrow(ClientConfigurationError);
    // localhost is the one non-HTTPS origin a client may bind.
    expect(() => createClient(options({ url: "http://localhost:1337" }))).not.toThrow();
  });

  test("binds a query value without executing or activating anything", () => {
    const client = createClient(options());
    const db = client.open();
    const query = db.query.from(Note).where({ title: "offline" });
    // The portable language, unchanged: an inert value, not a client DSL.
    expect(typeof query.orderBy).toBe("function");
    expect(client.sync.getSnapshot().status).toBe("idle");
  });
});

describe("the ramose/client barrel", () => {
  test("bundles for browsers without the deploy engine", async () => {
    const built = await Bun.build({
      entrypoints: [resolve(dirname(fileURLToPath(import.meta.url)), "../../src/client/index.ts")],
      target: "browser",
      external: ["effect", "effect/*"],
    });
    expect(built.success).toBe(true);
    // The client is a browser package: Alchemy, the peer Worker, and the
    // Cloudflare bindings must not be reachable from it.
    expect(await built.outputs[0]!.text()).not.toContain("alchemy");
  });
});

describe("queryObservationKey", () => {
  test("is the same for two independently built equal queries", () => {
    const left = createClient(options()).open().query.from(Note).where({ title: "a" });
    const right = createClient(options()).open().query.from(Note).where({ title: "a" });
    expect(queryObservationKey(right)).toBe(queryObservationKey(left));
  });

  test("separates questions whose answers are shaped differently", () => {
    const db = createClient(options()).open();
    const base = db.query.from(Note).orderBy(Note.title);
    const keys = [
      queryObservationKey(base),
      // Same `limit: 1` on the wire, a row rather than an array in the answer.
      queryObservationKey(base.limit(1)),
      queryObservationKey(base.one()),
      queryObservationKey(base.oneOrFail()),
      queryObservationKey(db.query.from(Note).orderBy(Note.title).where({ title: "a" })),
      queryObservationKey(base.select({ title: Note.title })),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("terminality", () => {
  test("close() makes every entry point typed-fail and is idempotent", async () => {
    const client = createClient(options());
    client.open();
    await client.close();
    await client.close();

    expect(client.sync.getSnapshot().status).toBe("closed");
    expect(() => client.open()).toThrow(ClientClosedError);
    await expect(client.clearLocalData()).rejects.toThrow(ClientClosedError);
  });

  test("clearLocalData() refuses a scope no response ever confirmed", async () => {
    const client = createClient(options());

    // No storage and no server: nothing has confirmed a server/principal scope
    // this client could name, so it deletes nothing and says why.
    await expect(client.clearLocalData()).rejects.toThrow(ClientLocalDataError);
    await expect(client.clearLocalData()).rejects.toMatchObject({
      reason: "no-confirmed-scope",
    });
    // A refused clear is not terminal: the client is exactly as it was.
    expect(() => client.open()).not.toThrow();
  });
});
