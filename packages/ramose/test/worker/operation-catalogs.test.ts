import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Schema } from "../../src/db/Schema.ts";
import { DatabaseId } from "../../src/internal/authorization/identities.ts";
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

});
