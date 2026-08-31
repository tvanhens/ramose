import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { Catalog } from "../../src/Catalog.ts";
import {
  Entity,
  Field,
  Query as PortableQuery,
  Schema,
  string,
} from "../../src/db/internal.ts";
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

    expect(client.sync.getSnapshot().status).toBe("idle");
    expect(typeof client.open().query.from).toBe("function");
    expect(client.sync.getSnapshot().status).toBe("idle");
  });

  test("returns one interned root handle from an argument-free open()", () => {
    const client = createClient(options());
    const root = client.open();
    expect(client.open()).toBe(root);

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

    expect(() => createClient(options({ url: "http://localhost:1337" }))).not.toThrow();
  });

  test("binds a query value without executing or activating anything", () => {
    const client = createClient(options());
    const db = client.open();
    const query = db.query.from(Note).where({ title: "offline" });

    expect(typeof query.orderBy).toBe("function");
    expect(client.sync.getSnapshot().status).toBe("idle");
  });
});

describe("the ramose/client bundle", () => {
  test("bundles for browsers without the deploy engine", async () => {
    const built = await Bun.build({
      entrypoints: [resolve(dirname(fileURLToPath(import.meta.url)), "../../src/client/client.ts")],
      target: "browser",
      external: ["effect", "effect/*"],
    });
    expect(built.success).toBe(true);
    const bundle = await built.outputs[0]!.text();

    expect(bundle).not.toContain("alchemy");
  });
});

describe("queryObservationKey", () => {
  test("is the same for two independently built equal queries", () => {
    const left = createClient(options()).open().query.from(Note).where({ title: "a" });
    const right = createClient(options()).open().query.from(Note).where({ title: "a" });
    expect(queryObservationKey(right)).toBe(queryObservationKey(left));
  });

  test("separates two questions that name different entities, and holds one identity steady", () => {
    const db = createClient(options()).open();
    const ada = `${"a".repeat(54)}A`;
    const ben = `${"b".repeat(54)}A`;
    const forAda = db.query.from(Note).where({ id: ada as never });
    const forBen = db.query.from(Note).where({ id: ben as never });

    expect(queryObservationKey(forAda)).not.toBe(queryObservationKey(forBen));
    expect(queryObservationKey(forAda)).not.toBe(
      queryObservationKey(db.query.from(Note)),
    );
    expect(queryObservationKey(db.query.from(Note).where({ id: ada as never })))
      .toBe(queryObservationKey(forAda));
  });

  test("keys a paged query that carries a cursor", () => {
    const db = createClient(options()).open();
    const first = db.query.from(Note).orderBy(Note.title).limit(1).after(null);
    const cursor = { _tag: "Cursor", keys: ["a", "handle:1"] };
    const next = db.query.from(Note).orderBy(Note.title).limit(1)
      .after(cursor as never);
    expect(queryObservationKey(first as never))
      .not.toBe(queryObservationKey(next as never));
  });

  test("separates questions whose answers are shaped differently", () => {
    const db = createClient(options()).open();
    const base = db.query.from(Note).orderBy(Note.title);
    const keys = [
      queryObservationKey(base),

      queryObservationKey(base.limit(1)),
      queryObservationKey(base.one()),
      queryObservationKey(base.oneOrFail()),

      queryObservationKey(base.after(null)),
      queryObservationKey(db.query.from(Note).orderBy(Note.title).where({ title: "a" })),
      queryObservationKey(base.select({ title: Note.title })),

      queryObservationKey(base.select({ heading: Note.title })),

      queryObservationKey(base.select({ title: Note.title.optional })),

      queryObservationKey(db.query.from(Note)),
      queryObservationKey(db.query.from(Note).ids()),
      queryObservationKey(PortableQuery.from(Note)),
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

    await expect(client.clearLocalData()).rejects.toThrow(ClientLocalDataError);
    await expect(client.clearLocalData()).rejects.toMatchObject({
      reason: "no-confirmed-scope",
    });

    expect(() => client.open()).not.toThrow();
  });
});
