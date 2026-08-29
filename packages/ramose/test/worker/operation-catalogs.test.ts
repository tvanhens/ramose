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
  deployOperationCatalogsForVersion,
  OperationCatalogDeploymentError,
} from "../../src/worker/operation-catalogs.ts";

const Empty = Schema({});
const root = Catalog("public-operations", {
  schema: Empty,
  policy: compileReadAuthorization({ schema: Empty, rules: [] }),
});

describe("public operation catalog startup", () => {
  test("assembles an opaque registry and exposes only the request proof", async () => {
    const deployed = await Effect.runPromise(deployOperationCatalogsForVersion({
      root,
      deployments: [{ database: "alpha" }],
    }, { id: "deployment-alpha" }));

    expect(deployed.proof("alpha")).toEqual({
      catalog: "public-operations",
      unitHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(deployed.proof("missing")).toBeUndefined();
    expect(Object.keys(deployed)).toEqual(["proof"]);
  });

  test("binds proofs to deployment metadata and fails closed without it", async () => {
    const alpha = await Effect.runPromise(deployOperationCatalogsForVersion({
      root,
      deployments: [{ database: "alpha" }],
    }, { id: "deployment-alpha" }));
    const beta = await Effect.runPromise(deployOperationCatalogsForVersion({
      root,
      deployments: [{ database: "alpha" }],
    }, { id: "deployment-beta" }));

    expect(alpha.proof("alpha")?.unitHash).not.toBe(
      beta.proof("alpha")?.unitHash,
    );
    await expect(Effect.runPromise(deployOperationCatalogsForVersion({
      root,
      deployments: [{ database: "alpha" }],
    }, undefined))).rejects.toBeInstanceOf(OperationCatalogDeploymentError);
    await expect(Effect.runPromise(deployOperationCatalogsForVersion({
      root,
      deployments: [{ database: "alpha" }],
    }, { id: "" }))).rejects.toBeInstanceOf(OperationCatalogDeploymentError);

    await expect(Effect.runPromise(deployOperationCatalogsForVersion({
      root,
      deployments: [{ database: "alpha" }, { database: "alpha" }],
    }, { id: "deployment-alpha" }))).rejects.toBeInstanceOf(
      OperationCatalogDeploymentError,
    );
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
    const deployed = await Effect.runPromise(deployOperationCatalogsForVersion({
      root: graphRoot,
      deployments: [{ database: "root" }],
    }, { id: "deployment-graph" }));
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
