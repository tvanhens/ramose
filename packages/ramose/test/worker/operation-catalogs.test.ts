import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Catalog } from "../../src/Catalog.ts";
import { Schema } from "../../src/db/Schema.ts";
import { compileReadAuthorization } from "../../src/internal/authorization/authoring/compile.ts";
import {
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
});
