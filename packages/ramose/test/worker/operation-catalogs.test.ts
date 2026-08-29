import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Catalog } from "../../src/Catalog.ts";
import { Entity } from "../../src/db/Entity.ts";
import { Graph } from "../../src/db/Graph.ts";
import { Schema } from "../../src/db/Schema.ts";
import { compileReadAuthorization } from "../../src/internal/authorization/authoring/compile.ts";
import { CatalogId, DatabaseId } from "../../src/internal/authorization/identities.ts";
import {
  deployedDatabaseCatalogBindings,
  deployOperationCatalogs,
  OperationCatalogDeploymentError,
} from "../../src/worker/operation-catalogs.ts";

const Empty = Schema({});
const root = Catalog("public-operations", {
  schema: Empty,
  policy: compileReadAuthorization({ schema: Empty, rules: [] }),
});

describe("public operation catalog startup", () => {
  test("assembles an opaque registry and exposes only the request proof", async () => {
    const deployed = await Effect.runPromise(deployOperationCatalogs({
      root,
      artifactHash: "8".repeat(64),
      deployments: [{ database: "alpha" }],
    }));

    expect(deployed.proof("alpha")).toEqual({
      catalog: "public-operations",
      unitHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(deployed.proof("missing")).toBeUndefined();
    expect(Object.keys(deployed)).toEqual(["proof"]);
  });

  test("maps assembly and binding failures to one public startup error", async () => {
    await expect(Effect.runPromise(deployOperationCatalogs({
      root,
      artifactHash: "invalid",
      deployments: [{ database: "alpha" }],
    }))).rejects.toBeInstanceOf(OperationCatalogDeploymentError);

    await expect(Effect.runPromise(deployOperationCatalogs({
      root,
      artifactHash: "8".repeat(64),
      deployments: [{ database: "alpha" }, { database: "alpha" }],
    }))).rejects.toBeInstanceOf(OperationCatalogDeploymentError);
  });

  test("retains reachable dynamic definitions without exposing child proofs", async () => {
    const ChildSchema = Schema({});
    const child = Catalog("public-child", {
      schema: ChildSchema,
      policy: compileReadAuthorization({ schema: ChildSchema, rules: [] }),
    });
    const RootSchema = Schema({
      publicGraph: Entity("publicGraph", {}, { traits: [Graph(child)] }),
    });
    const graphRoot = Catalog("public-root", {
      schema: RootSchema,
      policy: compileReadAuthorization({ schema: RootSchema, rules: [] }),
    });
    const deployed = await Effect.runPromise(deployOperationCatalogs({
      root: graphRoot,
      artifactHash: "7".repeat(64),
      deployments: [{ database: "root" }],
    }));
    const bindings = deployedDatabaseCatalogBindings(deployed);
    const rootRoute = bindings.root(DatabaseId.make("root"));
    if (rootRoute._tag === "Failure") throw rootRoute.failure;
    const childRoute = await Effect.runPromise(bindings.child(rootRoute.success, {
      graphEntity: 1_000,
      catalogKey: CatalogId.make("public-child"),
    }));

    expect(childRoute.deployed.catalogKey).toBe(CatalogId.make("public-child"));
    expect(deployed.proof(childRoute.database)).toBeUndefined();
    expect(Object.keys(deployed)).toEqual(["proof"]);
  });
});
