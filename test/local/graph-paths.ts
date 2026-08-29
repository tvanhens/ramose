import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { schemaTx } from "../../packages/ramose/src/db/internal.ts";
import {
  DatabaseId,
  deriveDynamicChildDatabaseId,
} from "../../packages/ramose/src/internal/authorization/index.ts";
import { json, testAdmin, type LocalUrls } from "./fixtures.ts";
import {
  GRAPH_PATH_ROOT_DATABASE,
  GraphPathRootSchema,
} from "./graph-path-catalog.ts";
import { graphPathRootProof } from "./graph-path-proof.ts";

const invoke = (
  base: string,
  token: string,
  operation: {
    readonly owner: { readonly kind: "entity" | "trait"; readonly name: string };
    readonly localName: string;
  },
  input: unknown,
  options: { readonly at?: readonly string[]; readonly target?: number } = {},
) => json(base, `/db/${GRAPH_PATH_ROOT_DATABASE}/op`, {
  method: "POST",
  token,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...(options.at === undefined ? graphPathRootProof : { at: options.at }),
    operation,
    input,
    ...(options.target === undefined ? {} : { target: options.target }),
  }),
});

const nestedEntity = (
  base: string,
  token: string,
  at: readonly string[],
  entity: number,
) => {
  const search = new URLSearchParams();
  for (const segment of at) search.append("at", segment);
  return json(
    base,
    `/db/${GRAPH_PATH_ROOT_DATABASE}/entity/${entity}?${search}`,
    { token },
  );
};

export const registerGraphPaths = (ctx: { urls: () => LocalUrls }) => {
  describe("authenticated hierarchical Graph paths", () => {
    test("provisions and traverses two real nested databases with stable rename identity", async () => {
      const base = ctx.urls().graphPathsUrl;
      const root = GRAPH_PATH_ROOT_DATABASE;
      const installed = await testAdmin(base, root, "/transact", {
        tx: schemaTx(GraphPathRootSchema),
      });
      expect(installed.status).toBe(200);

      const member = await signToken(root, "member");
      const workspace = await invoke(base, member, {
        owner: { kind: "entity", name: "localWorkspace" },
        localName: "create",
      }, { name: "acme" });
      expect(workspace.status).toBe(200);
      const workspaceId = workspace.body.result.id as number;

      // Resolving `acme` authorizes its ordinary filtered Graph row, then the
      // internal provisioner creates the child storage/schema before this
      // dynamic operation reaches the child's real Transactor.
      const project = await invoke(base, member, {
        owner: { kind: "entity", name: "localProject" },
        localName: "create",
      }, { name: "design" }, { at: ["acme"] });
      expect(project.status).toBe(200);
      const projectId = project.body.result.id as number;

      const note = await invoke(base, member, {
        owner: { kind: "entity", name: "localNestedNote" },
        localName: "create",
      }, { text: "two levels deep" }, { at: ["acme", "design"] });
      expect(note.status).toBe(200);
      const noteId = note.body.result.id as number;

      const read = await nestedEntity(base, member, ["acme", "design"], noteId);
      expect(read.status).toBe(200);
      expect(read.body.result).toMatchObject({
        ":ramose/type": ":localNestedNote",
        ":localNestedNote/text": "two levels deep",
      });

      const childDatabase = await Effect.runPromise(
        deriveDynamicChildDatabaseId(DatabaseId.make(root), workspaceId),
      );
      const leafDatabase = await Effect.runPromise(
        deriveDynamicChildDatabaseId(childDatabase, projectId),
      );
      const childStored = await testAdmin(base, childDatabase, "/query", {
        entity: projectId,
      });
      const leafStored = await testAdmin(base, leafDatabase, "/query", {
        entity: noteId,
      });
      expect(childStored.body.entity).toMatchObject({
        ":ramose/type": ":localProject",
        ":graph/name": "design",
      });
      expect(leafStored.body.entity).toMatchObject({
        ":ramose/type": ":localNestedNote",
        ":localNestedNote/text": "two levels deep",
      });

      const renamed = await invoke(base, member, {
        owner: { kind: "entity", name: "localWorkspace" },
        localName: "rename",
      }, { name: "renamed" }, { target: workspaceId });
      expect(renamed.status).toBe(200);

      const oldAddress = await nestedEntity(base, member, ["acme", "design"], noteId);
      const newAddress = await nestedEntity(base, member, ["renamed", "design"], noteId);
      expect(oldAddress.status).toBe(403);
      expect(newAddress.status).toBe(200);
      expect(newAddress.body.result[":localNestedNote/text"]).toBe("two levels deep");

      const sameLeaf = await testAdmin(base, leafDatabase, "/query", {
        entity: noteId,
      });
      expect(sameLeaf.body.entity[":localNestedNote/text"]).toBe("two levels deep");
    });

    test("keeps an independently denied child indistinguishable from a missing path", async () => {
      const base = ctx.urls().graphPathsUrl;
      const rootReader = await signToken(GRAPH_PATH_ROOT_DATABASE, "root-reader");
      const denied = await nestedEntity(base, rootReader, ["renamed", "design"], 1000);
      const missing = await nestedEntity(base, rootReader, ["renamed", "absent"], 1000);
      expect(denied.status).toBe(403);
      expect(missing.status).toBe(403);
      expect(denied.body).toEqual(missing.body);
      expect(JSON.stringify(denied.body)).not.toMatch(/renamed|design|absent|catalog|database/i);
    });

    test("rejects a caller-selected child catalog proof", async () => {
      const base = ctx.urls().graphPathsUrl;
      const member = await signToken(GRAPH_PATH_ROOT_DATABASE, "member");
      const response = await json(
        base,
        `/db/${GRAPH_PATH_ROOT_DATABASE}/entity/1000?at=renamed`,
        {
          token: member,
          headers: {
            "x-ramose-catalog": graphPathRootProof.catalog,
            "x-ramose-unit-hash": graphPathRootProof.unitHash,
          },
        },
      );
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "unauthorized" });
    });
  });
};
