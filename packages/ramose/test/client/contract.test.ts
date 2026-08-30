
import { describe, expect, test } from "bun:test";
import * as EffectSchema from "effect/Schema";
import * as Client from "../../src/client/index.ts";
import {
  Entity,
  Field,
  Schema,
  string,
} from "../../src/db/internal.ts";
import { compileReadAuthorization } from "../../src/internal/authorization/index.ts";

const Issue = Entity("issue", { title: Field.unique(string(), "strict") }, {
  operations: (Operation) => ({
    close: Operation({
      input: EffectSchema.Struct({}),
      output: EffectSchema.Struct({}),
      run: () => ({}),
    }),
  }),
});
const AppSchema = Schema({ issue: Issue });

describe("the ramose/client surface", () => {
  test("exports exactly the client, its authoring surface, and its errors", () => {
    expect(Object.keys(Client).sort()).toEqual([
      "Catalog",
      "ClientClosedError",
      "ClientConfigurationError",
      "ClientLocalDataError",
      "EntityWithdrawnError",
      "GraphPathError",
      "GraphReceiverError",
      "MutationRejectedError",
      "Policy",
      "createClient",
    ]);
  });

  test("authors a catalog without reaching the deploy package", () => {
    const catalog = Client.Catalog("app", {
      schema: AppSchema,
      policy: Client.Policy.compileReadAuthorization({
        schema: AppSchema,
        rules: [],
      }),
    });
    expect(catalog.key).toBe("app");
  });

  test("constructing a client and a handle is inert", () => {
    const client = Client.createClient({
      url: "https://data.example.com",
      root: "app",
      catalog: Client.Catalog("app", {
        schema: AppSchema,
        policy: compileReadAuthorization({ schema: AppSchema, rules: [] }),
      }),
      auth: () => {
        throw new Error("auth must not be called before an observation");
      },
      storageName: "ramose-client-contract",
    });
    const db = client.open();
    expect(client.open()).toBe(db);
    const query = db.query.from(Issue).where({ title: "Offline" });
    expect(typeof query.one).toBe("function");
    expect(typeof db.mutate).toBe("object");
  });

  test("refuses a configuration that cannot name exactly one root", () => {
    const catalog = Client.Catalog("app", {
      schema: AppSchema,
      policy: compileReadAuthorization({ schema: AppSchema, rules: [] }),
    });
    for (
      const options of [
        { url: "", root: "app" },
        { url: "https://data.example.com", root: "" },
        { url: "not-a-url", root: "app" },
      ]
    ) {
      expect(() =>
        Client.createClient({
          ...options,
          catalog,
          auth: () => ({ token: "t", cacheKey: "c" }),
        })
      ).toThrow();
    }
  });

  test("exposes no transport, checkpoint, or physical database vocabulary", () => {
    const surface = Object.keys(Client).join(" ").toLowerCase();
    for (
      const forbidden of [
        "frame",
        "checkpoint",
        "revision",
        "snapshot",
        "replica",
        "partition",
        "outbox",
        "session",
      ]
    ) {
      expect(surface).not.toContain(forbidden);
    }
  });
});
