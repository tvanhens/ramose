import { beforeAll, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Graph, Q, Query } from "ramose/db";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import {
  lowerQueryObject,
  schemaTx,
  type AnyQueryObject,
} from "../../packages/ramose/src/db/internal.ts";
import {
  DatabaseId,
  deriveDynamicChildDatabaseId,
} from "../../packages/ramose/src/internal/authorization/index.ts";
import {
  applyLiveDiffs,
  readLiveNdjson,
  type LiveQueryDiff,
} from "../support/live-query.ts";
import { json, testAdmin, type LocalUrls } from "./fixtures.ts";
import {
  GateHidden,
  GateLink,
  GatePlain,
  GateTagged,
  GateVisible,
  GRAPH_PATH_ROOT_DATABASE,
  GraphPathRootSchema,
  PrivateWorkspace,
  Project,
  Workspace,
} from "./graph-path-catalog.ts";
import {
  graphPathRootProof,
  loadGraphPathRootProof,
} from "./graph-path-proof.ts";

let rootInstall: Promise<void> | undefined;

const nestedNotesQuery =
  "[:find [?text ...] :where [?e :localNestedNote/text ?text]]";

const withTimeout = async <A>(
  promise: Promise<A>,
  ms: number,
  label: string,
): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const gateTraitCount = Query.q(function* () {
  const entity = yield* Query.entities(GateTagged);
  return Q.value(Q.count(entity));
});

const graphCount = Query.q(function* () {
  const entity = yield* Query.entities(Graph);
  return Q.value(Q.count(entity));
});

const installRoot = (base: string): Promise<void> => {
  rootInstall ??= (async () => {
    const installed = await testAdmin(base, GRAPH_PATH_ROOT_DATABASE, "/transact", {
      tx: schemaTx(GraphPathRootSchema),
    });
    expect(installed.status).toBe(200);
  })();
  return rootInstall;
};

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
    invocationId: crypto.randomUUID(),
    operation,
    input,
    ...(options.target === undefined ? {} : { target: options.target }),
  }),
});

const withoutReceipt = (body: Record<string, unknown>) => {
  const { receipt: _receipt, ...rest } = body;
  return rest;
};

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

const nestedLive = (
  base: string,
  token: string,
  at: readonly string[],
): Promise<Response> => fetch(
  `${base.replace(/\/+$/, "")}/db/${GRAPH_PATH_ROOT_DATABASE}/live`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ at, query: nestedNotesQuery }),
  },
);

const rootEntity = (
  base: string,
  token: string,
  entity: number,
) => json(base, `/db/${GRAPH_PATH_ROOT_DATABASE}/entity/${entity}`, {
  token,
  headers: {
    "x-ramose-catalog": graphPathRootProof.catalog,
    "x-ramose-unit-hash": graphPathRootProof.unitHash,
  },
});

const rootLookup = (
  base: string,
  token: string,
  lookup: readonly [string, unknown],
) => json(base, `/db/${GRAPH_PATH_ROOT_DATABASE}/query`, {
  method: "POST",
  token,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...graphPathRootProof, lookup }),
});

const rootQuery = async <Out>(
  base: string,
  token: string,
  query: AnyQueryObject,
): Promise<{ readonly response: Awaited<ReturnType<typeof json>>; readonly result: Out }> => {
  const lowered = lowerQueryObject(query);
  const response = await json(base, `/db/${GRAPH_PATH_ROOT_DATABASE}/query`, {
    method: "POST",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...graphPathRootProof, query: lowered.query }),
  });
  return {
    response,
    result: lowered.finalize(response.body.result) as Out,
  };
};

export const registerGraphPaths = (ctx: { urls: () => LocalUrls }) => {
  describe("authenticated hierarchical Graph paths", () => {
    beforeAll(() => loadGraphPathRootProof(ctx.urls().graphPathsUrl));

    test("gates transitive traits, policy narrowing, operations, and refs on the real stack", async () => {
      const base = ctx.urls().graphPathsUrl;
      const root = GRAPH_PATH_ROOT_DATABASE;
      await installRoot(base);
      const member = await signToken(root, "member");
      const admin = await signToken(root, "admin");
      const rowOnly = await signToken(root, "row-only");
      const fieldOnly = await signToken(root, "field-only");

      const visible = await invoke(base, member, {
        owner: { kind: "entity", name: GateVisible.ns },
        localName: "create",
      }, {
        title: "visible diamond",
        label: "visible label",
        tags: ["one", "two"],
      });
      const empty = await invoke(base, member, {
        owner: { kind: "entity", name: GateVisible.ns },
        localName: "create",
      }, { title: "no optional trait fields" });
      const plain = await invoke(base, member, {
        owner: { kind: "entity", name: GatePlain.ns },
        localName: "create",
      }, { title: "readable non-composer" });
      expect(visible.status).toBe(200);
      expect(empty.status).toBe(200);
      expect(plain.status).toBe(200);
      const visibleId = visible.body.result.id as number;
      const emptyId = empty.body.result.id as number;
      const plainId = plain.body.result.id as number;

      const beforeHidden = await rootQuery<readonly { readonly id: number }[]>(
        base,
        member,
        Query.from(GateTagged).ids(),
      );
      const beforeHiddenCount = await rootQuery<number>(
        base,
        member,
        gateTraitCount,
      );
      expect(beforeHidden.response.status).toBe(200);
      expect(beforeHiddenCount.response.status).toBe(200);
      expect(new Set(beforeHidden.result.map(({ id }) => id))).toEqual(
        new Set([visibleId, emptyId]),
      );
      expect(beforeHiddenCount.result).toBe(2);

      const hidden = await invoke(base, admin, {
        owner: { kind: "entity", name: GateHidden.ns },
        localName: "create",
      }, { title: "hidden diamond", label: "hidden label" });
      expect(hidden.status).toBe(200);
      const hiddenId = hidden.body.result.id as number;

      // Adding a hidden composer cannot change the visible trait-root rows,
      // count, or wire metadata in the paired absent/hidden worlds.
      const afterHidden = await rootQuery<readonly { readonly id: number }[]>(
        base,
        member,
        Query.from(GateTagged).ids(),
      );
      const afterHiddenCount = await rootQuery<number>(
        base,
        member,
        gateTraitCount,
      );
      expect(afterHidden.response.status).toBe(200);
      expect(afterHiddenCount.response.status).toBe(200);
      expect(afterHidden.result).toEqual(beforeHidden.result);
      expect(afterHidden.response.body).toEqual(beforeHidden.response.body);
      expect(afterHiddenCount.result).toBe(beforeHiddenCount.result);
      expect(afterHiddenCount.response.body).toEqual(beforeHiddenCount.response.body);

      const stored = await testAdmin(base, root, "/query", { entity: visibleId });
      expect(stored.status).toBe(200);
      expect(stored.body.entity).toMatchObject({
        ":ramose/type": `:${GateVisible.ns}`,
        ":localGateVisible/title": "visible diamond",
        ":localGateTagged/label": "visible label",
        ":localGateTagged/tags": ["one", "two"],
      });
      expect(stored.body.entity[":ramose/trait"]).toBeUndefined();
      expect(stored.body.entity[":ramose/composes"]).toBeUndefined();
      expect(stored.body.entity[":ramose/kind"]).toBeUndefined();
      expect(stored.body.entity[":localGateLeft/label"]).toBeUndefined();
      expect(stored.body.entity[":localGateRight/label"]).toBeUndefined();
      expect(stored.body.entity[":localGateDiamond/label"]).toBeUndefined();

      const fullRead = await rootEntity(base, member, visibleId);
      const rowRead = await rootEntity(base, rowOnly, visibleId);
      const fieldRead = await rootEntity(base, fieldOnly, visibleId);
      expect(fullRead.status).toBe(200);
      expect(fullRead.body.result).toMatchObject({
        ":localGateVisible/title": "visible diamond",
        ":localGateTagged/label": "visible label",
        ":localGateTagged/tags": ["one", "two"],
      });
      expect(rowRead.status).toBe(200);
      expect(rowRead.body.result[":localGateVisible/title"]).toBe("visible diamond");
      expect(rowRead.body.result[":localGateTagged/label"]).toBeUndefined();
      expect(rowRead.body.result[":localGateTagged/tags"]).toBeUndefined();
      expect(fieldRead.status).toBe(200);
      expect(fieldRead.body.result[":localGateTagged/label"]).toBeUndefined();
      expect(fieldRead.body.result[":localGateTagged/tags"]).toEqual(["one", "two"]);

      const retagged = await invoke(base, member, {
        owner: { kind: "trait", name: GateTagged.ns },
        localName: "retag",
      }, { label: "retagged" }, { target: visibleId });
      expect(retagged.status).toBe(200);
      expect(retagged.body.result).toEqual({ id: visibleId, label: "retagged" });

      const hiddenTarget = await invoke(base, member, {
        owner: { kind: "trait", name: GateTagged.ns },
        localName: "retag",
      }, { label: "must not run" }, { target: hiddenId });
      const nonexistentTarget = await invoke(base, member, {
        owner: { kind: "trait", name: GateTagged.ns },
        localName: "retag",
      }, { label: "must not run" }, { target: 999_999 });
      const nonComposerTarget = await invoke(base, member, {
        owner: { kind: "trait", name: GateTagged.ns },
        localName: "retag",
      }, { label: "must not run" }, { target: plainId });
      expect(hiddenTarget.status).toBe(403);
      expect(nonexistentTarget.status).toBe(403);
      expect(nonComposerTarget.status).toBe(403);
      expect(withoutReceipt(hiddenTarget.body)).toEqual(
        withoutReceipt(nonexistentTarget.body),
      );
      expect(withoutReceipt(nonComposerTarget.body)).toEqual(
        withoutReceipt(nonexistentTarget.body),
      );

      const visibleLink = await invoke(base, member, {
        owner: { kind: "entity", name: GateLink.ns },
        localName: "create",
      }, { name: "visible-link", target: visibleId });
      const hiddenLink = await invoke(base, member, {
        owner: { kind: "entity", name: GateLink.ns },
        localName: "create",
      }, { name: "hidden-link", target: hiddenId });
      const emptyLink = await invoke(base, member, {
        owner: { kind: "entity", name: GateLink.ns },
        localName: "create",
      }, { name: "empty-link" });
      expect(visibleLink.status).toBe(200);
      expect(hiddenLink.status).toBe(200);
      expect(emptyLink.status).toBe(200);

      const visibleLinkRead = await rootEntity(base, member, visibleLink.body.result.id);
      const hiddenLinkRead = await rootEntity(base, member, hiddenLink.body.result.id);
      const emptyLinkRead = await rootEntity(base, member, emptyLink.body.result.id);
      expect(visibleLinkRead.body.result[":localGateLink/target"]).toBe(visibleId);
      expect(hiddenLinkRead.body.result[":localGateLink/target"]).toBeUndefined();
      expect(emptyLinkRead.body.result[":localGateLink/target"]).toBeUndefined();
      expect(Object.keys(hiddenLinkRead.body.result).sort()).toEqual(
        Object.keys(emptyLinkRead.body.result).sort(),
      );

      const wrongRef = await invoke(base, member, {
        owner: { kind: "entity", name: GateLink.ns },
        localName: "create",
      }, { name: "wrong-ref", target: plainId });
      const missingRef = await invoke(base, member, {
        owner: { kind: "entity", name: GateLink.ns },
        localName: "create",
      }, { name: "missing-ref", target: 999_999 });
      expect(wrongRef.status).toBe(400);
      expect(missingRef.status).toBe(400);
      expect((await rootLookup(base, member, [":localGateLink/name", "wrong-ref"])).body.result)
        .toBeNull();
      expect((await rootLookup(base, member, [":localGateLink/name", "missing-ref"])).body.result)
        .toBeNull();

      const invalidBasis = await invoke(base, member, {
        owner: { kind: "entity", name: GateLink.ns },
        localName: "deleteThenLink",
      }, { name: "invalid-basis-link", target: emptyId });
      expect(invalidBasis.status).toBe(409);
      expect((await rootEntity(base, member, emptyId)).body.result).toMatchObject({
        ":localGateVisible/title": "no optional trait fields",
      });
      expect((await rootLookup(base, member, [
        ":localGateLink/name",
        "invalid-basis-link",
      ])).body.result).toBeNull();
    });

    test("provisions and traverses two real nested databases with stable rename identity", async () => {
      const base = ctx.urls().graphPathsUrl;
      const root = GRAPH_PATH_ROOT_DATABASE;
      await installRoot(base);

      const member = await signToken(root, "member");
      const workspace = await invoke(base, member, {
        owner: { kind: "entity", name: "localWorkspace" },
        localName: "create",
      }, { name: "acme" });
      expect(workspace.status).toBe(200);
      const workspaceId = workspace.body.result.id as number;

      const secondWorkspace = await invoke(base, member, {
        owner: { kind: "entity", name: Workspace.ns },
        localName: "create",
      }, { name: "beta" });
      expect(secondWorkspace.status).toBe(200);
      const secondWorkspaceId = secondWorkspace.body.result.id as number;

      // Resolving `acme` authorizes its ordinary filtered Graph row, then the
      // internal provisioner creates the child storage/schema before this
      // dynamic operation reaches the child's real Transactor.
      const project = await invoke(base, member, {
        owner: { kind: "entity", name: "localProject" },
        localName: "create",
      }, { name: "design" }, { at: ["acme"] });
      expect(project.status).toBe(200);
      const projectId = project.body.result.id as number;

      const secondProject = await invoke(base, member, {
        owner: { kind: "entity", name: "localProject" },
        localName: "create",
      }, { name: "design" }, { at: ["beta"] });
      expect(secondProject.status).toBe(200);
      const secondProjectId = secondProject.body.result.id as number;

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
      const secondChildDatabase = await Effect.runPromise(
        deriveDynamicChildDatabaseId(DatabaseId.make(root), secondWorkspaceId),
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
      const secondChildStored = await testAdmin(base, secondChildDatabase, "/query", {
        entity: secondProjectId,
      });
      const firstGraphStored = await testAdmin(base, root, "/query", {
        entity: workspaceId,
      });
      const secondGraphStored = await testAdmin(base, root, "/query", {
        entity: secondWorkspaceId,
      });
      expect(secondChildDatabase).not.toBe(childDatabase);
      expect(firstGraphStored.body.entity[":graph/catalog"]).toBe(
        secondGraphStored.body.entity[":graph/catalog"],
      );
      expect(childStored.body.entity).toMatchObject({
        ":ramose/type": ":localProject",
        ":graph/name": "design",
      });
      expect(secondChildStored.body.entity).toMatchObject({
        ":ramose/type": ":localProject",
        ":graph/name": "design",
      });
      expect(leafStored.body.entity).toMatchObject({
        ":ramose/type": ":localNestedNote",
        ":localNestedNote/text": "two levels deep",
      });

      for (const action of ["set", "remove"] as const) {
        const recatalog = await invoke(base, member, {
          owner: { kind: "entity", name: Workspace.ns },
          localName: "recatalog",
        }, { action }, { target: workspaceId });
        expect(recatalog.status).toBe(409);
      }
      const fixedGraph = await testAdmin(base, root, "/query", {
        entity: workspaceId,
      });
      expect(fixedGraph.body.entity[":graph/catalog"]).toBe(
        firstGraphStored.body.entity[":graph/catalog"],
      );

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

    test("reauthorizes every nested live dependency and closes on ancestor rename", async () => {
      const base = ctx.urls().graphPathsUrl;
      await installRoot(base);
      const member = await signToken(GRAPH_PATH_ROOT_DATABASE, "member");
      const suffix = crypto.randomUUID().slice(0, 8);
      const workspaceName = `live-${suffix}`;
      const projectName = `project-${suffix}`;

      const workspace = await invoke(base, member, {
        owner: { kind: "entity", name: Workspace.ns },
        localName: "create",
      }, { name: workspaceName });
      expect(workspace.status).toBe(200);
      const workspaceId = workspace.body.result.id as number;

      const project = await invoke(base, member, {
        owner: { kind: "entity", name: Project.ns },
        localName: "create",
      }, { name: projectName }, { at: [workspaceName] });
      expect(project.status).toBe(200);

      const firstNote = await invoke(base, member, {
        owner: { kind: "entity", name: "localNestedNote" },
        localName: "create",
      }, { text: `first-${suffix}` }, { at: [workspaceName, projectName] });
      expect(firstNote.status).toBe(200);

      const response = await nestedLive(
        base,
        member,
        [workspaceName, projectName],
      );
      expect(response.status).toBe(200);
      const iterator = readLiveNdjson(response)[Symbol.asyncIterator]();
      const frames: LiveQueryDiff[] = [];
      try {
        const initial = await withTimeout(iterator.next(), 5_000, "nested live initial");
        expect(initial.done).toBe(false);
        frames.push(initial.value!);
        expect(applyLiveDiffs(frames)).toContain(`first-${suffix}`);

        const secondNote = await invoke(base, member, {
          owner: { kind: "entity", name: "localNestedNote" },
          localName: "create",
        }, { text: `second-${suffix}` }, { at: [workspaceName, projectName] });
        expect(secondNote.status).toBe(200);
        const changed = await withTimeout(iterator.next(), 5_000, "nested live change");
        expect(changed.done).toBe(false);
        frames.push(changed.value!);
        expect(applyLiveDiffs(frames)).toEqual(
          expect.arrayContaining([`first-${suffix}`, `second-${suffix}`]),
        );

        const renamed = await invoke(base, member, {
          owner: { kind: "entity", name: Workspace.ns },
          localName: "rename",
        }, { name: `renamed-${suffix}` }, { target: workspaceId });
        expect(renamed.status).toBe(200);
        const closed = await withTimeout(iterator.next(), 7_000, "ancestor revoke");
        expect(closed.done).toBe(true);
        expect(JSON.stringify(frames)).not.toMatch(
          /basis|txEid|lease|database|catalog|graphEntity|sequence|count/i,
        );
      } finally {
        await iterator.return?.(undefined);
      }
    });

    test("keeps hidden graph facts out of discovery, paths, counts, and errors", async () => {
      const base = ctx.urls().graphPathsUrl;
      await installRoot(base);
      const member = await signToken(GRAPH_PATH_ROOT_DATABASE, "member");
      const admin = await signToken(GRAPH_PATH_ROOT_DATABASE, "admin");
      const beforeHidden = await rootQuery<readonly { readonly id: number }[]>(
        base,
        member,
        Query.from(Graph).ids(),
      );
      const beforeHiddenCount = await rootQuery<number>(base, member, graphCount);
      expect(beforeHidden.response.status).toBe(200);
      expect(beforeHiddenCount.response.status).toBe(200);

      const hidden = await invoke(base, admin, {
        owner: { kind: "entity", name: PrivateWorkspace.ns },
        localName: "create",
      }, { name: "private" });
      expect(hidden.status).toBe(200);

      const afterHidden = await rootQuery<readonly { readonly id: number }[]>(
        base,
        member,
        Query.from(Graph).ids(),
      );
      const afterHiddenCount = await rootQuery<number>(base, member, graphCount);
      expect(afterHidden.response.status).toBe(200);
      expect(afterHiddenCount.response.status).toBe(200);
      expect(afterHidden.result).toEqual(beforeHidden.result);
      expect(afterHidden.response.body).toEqual(beforeHidden.response.body);
      expect(afterHiddenCount.result).toBe(beforeHiddenCount.result);
      expect(afterHiddenCount.response.body).toEqual(beforeHiddenCount.response.body);

      const denied = await nestedEntity(base, member, ["private"], 1000);
      const missing = await nestedEntity(base, member, ["absent-private"], 1000);
      expect(denied.status).toBe(403);
      expect(missing.status).toBe(403);
      expect(denied.body).toEqual(missing.body);
      expect(JSON.stringify(denied.body)).not.toMatch(/private|catalog|database/i);
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
