import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Entity } from "../../src/db/Entity.ts";
import { string } from "../../src/db/Field.ts";
import { Graph } from "../../src/db/Graph.ts";
import { Schema } from "../../src/db/Schema.ts";
import { CatalogId, DatabaseId } from "../../src/internal/authorization/identities.ts";
import {
  deployedDatabaseCatalogBindings,
  deployedOperationCatalogs,
  deployOperationCatalogsForVersion,
  OperationCatalogDeploymentError,
} from "../../src/worker/operation-catalogs.ts";

const Empty = Schema("public-operations", {});
Empty.applyPolicy(() => {});
const root = Empty;

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
      deployments: [{ database: "alpha" }, { database: "alpha" }],
    }, { id: "deployment-alpha" }))).rejects.toBeInstanceOf(
      OperationCatalogDeploymentError,
    );
  });

  test("a code-sized catalog past the wire document budget still deploys", async () => {
    const entities: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      const name = `bulk${i}` as "bulk0";
      entities[name] = Entity(name, {
        alpha: string(),
        beta: string(),
        gamma: string(),
        delta: string(),
        epsilon: string(),
      });
    }
    const Bulk = Schema("bulk-catalog", entities as never);
    Bulk.applyPolicy(({ policy }) => {
      for (let i = 0; i < 40; i++) {
        (policy as Record<string, { read: { always: () => void } }>)[`bulk${i}`]!
          .read.always();
      }
    });
    const deployed = await Effect.runPromise(deployOperationCatalogsForVersion({
      root: Bulk,
      deployments: [{ database: "bulk" }],
    }, { id: "deployment-bulk" }));
    expect(deployed.proof("bulk")?.catalog).toBe("bulk-catalog");
  });

  test("an instance without a deployment version starts but refuses every use", async () => {
    const validation = await Effect.runPromise(deployOperationCatalogsForVersion({
      root,
      deployments: [{ database: "alpha" }],
    }, { id: "" }));

    expect(() => validation.proof("alpha")).toThrow(
      OperationCatalogDeploymentError,
    );
    const bindings = deployedDatabaseCatalogBindings(validation);
    expect(() => bindings.root(DatabaseId.make("alpha"))).toThrow(
      OperationCatalogDeploymentError,
    );
    const deployed = deployedOperationCatalogs(validation);
    expect(() => deployed.databases()).toThrow(OperationCatalogDeploymentError);
    expect(() =>
      deployed.requireDatabase(DatabaseId.make("alpha"))
    ).toThrow(OperationCatalogDeploymentError);
  });

  test("retains reachable dynamic definitions without exposing child proofs", async () => {
    const ChildSchema = Schema("public-child", {});
    ChildSchema.applyPolicy(() => {});
    const RootSchema = Schema("public-root", {
      publicGraph: Entity("publicGraph", {}, { traits: [Graph(ChildSchema)] }),
    });
    RootSchema.applyPolicy(() => {});
    const deployed = await Effect.runPromise(deployOperationCatalogsForVersion({
      root: RootSchema,
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
