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
  CatalogId,
  DatabaseId,
  DigestHex,
  deriveDynamicChildDatabaseId,
  lowerOwnedOperations,
} from "../../packages/ramose/src/internal/authorization/index.ts";
import {
  buildOutboxRecord,
} from "../../packages/ramose/src/internal/replication/outbox.ts";
import {
  buildMutationRequest,
  classifyMutationResponse,
  substituteMutationRefs,
} from "../../packages/ramose/src/internal/replication/submission.ts";
import { submitMutation } from "../../packages/ramose/src/internal/replication/transport.ts";
import { invocationId } from "../../packages/ramose/src/db/refs.ts";
import {
  applyLiveDiffs,
  readLiveNdjson,
  type LiveQueryDiff,
} from "../support/live-query.ts";
import {
  collectCommittedSnapshot,
  readReplicationNdjson,
} from "../support/replication.ts";
import { closeObservedStream } from "../support/stream.ts";
import {
  entityHandle,
  json,
  fetchPastProxyBlip,
  openEntityHandle,
  testAdmin,
  type LocalUrls,
} from "./fixtures.ts";
import {
  base64ToBytes,
  bytesToBase64,
} from "../../packages/ramose/src/internal/core/log.ts";
import {
  BulkValue,
  GateHidden,
  GateLink,
  GatePlain,
  GateTagged,
  GateVisible,
  GRAPH_PATH_ROOT_DATABASE,
  graphPathChildReadCompatibilityHash,
  graphPathLeafReadCompatibilityHash,
  graphPathRootReadCompatibilityHash,
  GraphPathLeafSchema,
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

const HALF_MEGABYTE = 512 * 1024;

const utf8Length = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const largeUtf8Text = (bytes: number): string => {
  const unit = "aé☃";
  const repeated = unit.repeat(Math.floor(bytes / utf8Length(unit)));
  return repeated + "x".repeat(bytes - utf8Length(repeated));
};

const largeBytes = (length: number): Uint8Array => {
  const value = new Uint8Array(length);
  let state = 0x9e3779b9;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state ^ (state >>> 15), 0x85ebca6b) + index) >>> 0;
    value[index] = state & 0xff;
  }
  return value;
};

const firstDifferingByte = (left: Uint8Array, right: Uint8Array): number => {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return index;
  }
  return -1;
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

  retryPreResponse: true,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...(options.at === undefined ? {} : { at: options.at }),
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
): Promise<Response> => fetchPastProxyBlip(
  `${base.replace(/\/+$/, "")}/db/${GRAPH_PATH_ROOT_DATABASE}/live`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ at, query: nestedNotesQuery }),
  },
  "nested live",
);

const nestedReplication = (
  base: string,
  token: string,
  at: readonly string[],
  resumeRevision?: string,
  readCompatibilityHash: string = graphPathLeafReadCompatibilityHash,
): Promise<Response> => fetchPastProxyBlip(
  `${base.replace(/\/+$/, "")}/db/${GRAPH_PATH_ROOT_DATABASE}/replicate`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "Activate",
      protocol: 2,
      graphPath: at,
      scope: { type: "database" },
      readCompatibilityHash,
      ...(resumeRevision === undefined ? {} : { resumeRevision }),
    }),
  },
  "nested replicate",
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

      const open = (response: { body: { result: { id: unknown } } }) =>
        openEntityHandle(base, root, member, response.body.result.id as string);
      const visibleId = await open(visible);
      const emptyId = await open(empty);
      const plainId = await open(plain);

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
      const hiddenId = await openEntityHandle(
        base,
        root,
        admin,
        hidden.body.result.id as string,
      );

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

      expect(retagged.body.result).toEqual({
        id: await entityHandle(base, root, member, visibleId),
        label: "retagged",
      });

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

      const visibleLinkRead = await rootEntity(base, member, await open(visibleLink));
      const hiddenLinkRead = await rootEntity(base, member, await open(hiddenLink));
      const emptyLinkRead = await rootEntity(base, member, await open(emptyLink));
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

      const workspaceId = await openEntityHandle(
        base,
        root,
        member,
        workspace.body.result.id as string,
      );

      const secondWorkspace = await invoke(base, member, {
        owner: { kind: "entity", name: Workspace.ns },
        localName: "create",
      }, { name: "beta" });
      expect(secondWorkspace.status).toBe(200);
      const secondWorkspaceId = await openEntityHandle(
        base,
        root,
        member,
        secondWorkspace.body.result.id as string,
      );
      const childDatabase = await Effect.runPromise(
        deriveDynamicChildDatabaseId(DatabaseId.make(root), workspaceId),
      );
      const secondChildDatabase = await Effect.runPromise(
        deriveDynamicChildDatabaseId(DatabaseId.make(root), secondWorkspaceId),
      );

      const project = await invoke(base, member, {
        owner: { kind: "entity", name: "localProject" },
        localName: "create",
      }, { name: "design" }, { at: ["acme"] });
      expect(project.status).toBe(200);
      const projectId = await openEntityHandle(
        base,
        childDatabase,
        member,
        project.body.result.id as string,
      );
      const leafDatabase = await Effect.runPromise(
        deriveDynamicChildDatabaseId(childDatabase, projectId),
      );

      const secondProject = await invoke(base, member, {
        owner: { kind: "entity", name: "localProject" },
        localName: "create",
      }, { name: "design" }, { at: ["beta"] });
      expect(secondProject.status).toBe(200);
      const secondProjectId = await openEntityHandle(
        base,
        secondChildDatabase,
        member,
        secondProject.body.result.id as string,
      );

      const note = await invoke(base, member, {
        owner: { kind: "entity", name: "localNestedNote" },
        localName: "create",
      }, { text: "two levels deep" }, { at: ["acme", "design"] });
      expect(note.status).toBe(200);
      const noteId = await openEntityHandle(
        base,
        leafDatabase,
        member,
        note.body.result.id as string,
      );

      const read = await nestedEntity(base, member, ["acme", "design"], noteId);
      expect(read.status).toBe(200);
      expect(read.body.result).toMatchObject({
        ":ramose/type": ":localNestedNote",
        ":localNestedNote/text": "two levels deep",
      });

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
      const workspaceId = await openEntityHandle(
        base,
        GRAPH_PATH_ROOT_DATABASE,
        member,
        workspace.body.result.id as string,
      );

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
        await closeObservedStream(iterator);
      }
    });

    test("replication renews the complete nested path and terminates opaquely on ancestor rename", async () => {
      const base = ctx.urls().graphPathsUrl;
      await installRoot(base);
      const member = await signToken(GRAPH_PATH_ROOT_DATABASE, "member");
      const suffix = crypto.randomUUID().slice(0, 8);
      const workspaceName = `replicate-${suffix}`;
      const projectName = `project-${suffix}`;
      const noteText = `replicated-${suffix}`;

      const workspace = await invoke(base, member, {
        owner: { kind: "entity", name: Workspace.ns },
        localName: "create",
      }, { name: workspaceName });
      expect(workspace.status).toBe(200);
      const workspaceId = await openEntityHandle(
        base,
        GRAPH_PATH_ROOT_DATABASE,
        member,
        workspace.body.result.id as string,
      );
      const project = await invoke(base, member, {
        owner: { kind: "entity", name: Project.ns },
        localName: "create",
      }, { name: projectName }, { at: [workspaceName] });
      expect(project.status).toBe(200);
      const note = await invoke(base, member, {
        owner: { kind: "entity", name: "localNestedNote" },
        localName: "create",
      }, { text: noteText }, { at: [workspaceName, projectName] });
      expect(note.status).toBe(200);

      const response = await nestedReplication(
        base,
        member,
        [workspaceName, projectName],
      );
      expect(response.status).toBe(200);
      const iterator = readReplicationNdjson(response)[Symbol.asyncIterator]();
      const snapshot = await collectCommittedSnapshot(iterator);
      const snapshotIdentity = snapshot.state.identity;
      if (snapshotIdentity === undefined) {
        throw new Error("nested snapshot had no authenticated identity");
      }
      try {
        expect(
          snapshot.state.committed?.datoms.some((datom) =>
            datom.field === ":localNestedNote/text" &&
            datom.value.type === "string" &&
            datom.value.value === noteText
          ),
        ).toBe(true);
      } finally {
        await closeObservedStream(iterator);
      }

      const refreshed = await signToken(GRAPH_PATH_ROOT_DATABASE, "member");
      const resumedResponse = await nestedReplication(
        base,
        refreshed,
        [workspaceName, projectName],
        snapshot.state.committed!.revision,
      );
      expect(resumedResponse.status).toBe(200);
      const resumed = readReplicationNdjson(resumedResponse)[Symbol.asyncIterator]();
      try {
        const ready = await withTimeout(
          resumed.next(),
          7_000,
          "nested replication resume ready",
        );
        expect(ready.done).toBe(false);
        expect(ready.value?.frame).toEqual({
          type: "ResumeReady",
          protocol: 2,
          identity: snapshotIdentity,
          revision: snapshot.state.committed!.revision,
          ordinal: snapshot.state.committed!.ordinal,
        });
        const changed = resumed.next();
        const secondNote = await invoke(base, member, {
          owner: { kind: "entity", name: "localNestedNote" },
          localName: "create",
        }, { text: `resumed-${suffix}` }, { at: [workspaceName, projectName] });
        expect(secondNote.status).toBe(200);
        const change = await withTimeout(
          changed,
          7_000,
          "nested replication resumed change",
        );
        expect(change.done).toBe(false);
        expect(change.value?.frame.type).toBe("Change");
        if (change.value?.frame.type === "Change") {
          expect(change.value.frame.from).toBe(snapshot.state.committed!.revision);
          expect(change.value.frame.identity).toEqual(snapshotIdentity);
          expect(change.value.frame.datoms.some((datom) =>
            datom.field === ":localNestedNote/text" &&
            datom.value.type === "string" &&
            datom.value.value === `resumed-${suffix}`
          )).toBe(true);
        }

        const terminal = resumed.next();
        const renamed = await invoke(base, member, {
          owner: { kind: "entity", name: Workspace.ns },
          localName: "rename",
        }, { name: `renamed-${suffix}` }, { target: workspaceId });
        expect(renamed.status).toBe(200);
        const closed = await withTimeout(
          terminal,
          7_000,
          "replication ancestor revoke",
        );
        expect(closed.done).toBe(false);
        expect(closed.value?.frame).toEqual({
          type: "TerminalError",
          protocol: 2,
          code: "closed",
          identity: snapshotIdentity,
        });
        expect(closed.value?.wire).not.toMatch(
          /lease|databaseName|catalogKey|graphEntity|basis|sequence|reason/i,
        );
      } finally {
        await closeObservedStream(resumed);
      }
    });

    test("a fully online rename resumes the same child replica without a snapshot", async () => {
      const base = ctx.urls().graphPathsUrl;
      await installRoot(base);
      const member = await signToken(GRAPH_PATH_ROOT_DATABASE, "member");
      const suffix = crypto.randomUUID().slice(0, 8);
      const before = `move-${suffix}`;
      const after = `moved-${suffix}`;
      const projectName = `project-${suffix}`;

      const workspace = await invoke(base, member, {
        owner: { kind: "entity", name: Workspace.ns },
        localName: "create",
      }, { name: before });
      expect(workspace.status).toBe(200);
      const workspaceId = await openEntityHandle(
        base,
        GRAPH_PATH_ROOT_DATABASE,
        member,
        workspace.body.result.id as string,
      );
      const project = await invoke(base, member, {
        owner: { kind: "entity", name: Project.ns },
        localName: "create",
      }, { name: projectName }, { at: [before] });
      expect(project.status).toBe(200);
      const note = await invoke(base, member, {
        owner: { kind: "entity", name: "localNestedNote" },
        localName: "create",
      }, { text: `before-${suffix}` }, { at: [before, projectName] });
      expect(note.status).toBe(200);

      const activated = await nestedReplication(
        base,
        member,
        [before, projectName],
      );
      expect(activated.status).toBe(200);
      const activation = readReplicationNdjson(activated)[Symbol.asyncIterator]();
      const snapshot = await collectCommittedSnapshot(activation);
      await closeObservedStream(activation);
      const identity = snapshot.state.identity;
      if (identity === undefined) {
        throw new Error("the nested activation had no authenticated identity");
      }
      const revision = snapshot.state.committed!.revision;

      const renamed = await invoke(base, member, {
        owner: { kind: "entity", name: Workspace.ns },
        localName: "rename",
      }, { name: after }, { target: workspaceId });
      expect(renamed.status).toBe(200);

      const stale = await nestedReplication(
        base,
        member,
        [before, projectName],
        revision,
      );
      expect(stale.status).toBe(403);
      await stale.text();

      const resumedResponse = await nestedReplication(
        base,
        member,
        [after, projectName],
        revision,
      );
      expect(resumedResponse.status).toBe(200);
      const resumed = readReplicationNdjson(resumedResponse)[Symbol.asyncIterator]();
      try {
        const ready = await withTimeout(
          resumed.next(),
          7_000,
          "renamed-path resume",
        );
        expect(ready.done).toBe(false);
        expect(ready.value?.frame).toEqual({
          type: "ResumeReady",
          protocol: 2,
          identity,
          revision,
          ordinal: 1,
        });

        const following = resumed.next();
        const second = await invoke(base, member, {
          owner: { kind: "entity", name: "localNestedNote" },
          localName: "create",
        }, { text: `after-${suffix}` }, { at: [after, projectName] });
        expect(second.status).toBe(200);
        const change = await withTimeout(
          following,
          7_000,
          "renamed-path change",
        );
        expect(change.done).toBe(false);
        expect(change.value?.frame.type).toBe("Change");
        if (change.value?.frame.type === "Change") {
          expect(change.value.frame.from).toBe(revision);
          expect(change.value.frame.identity).toEqual(identity);
        }
      } finally {
        await closeObservedStream(resumed);
      }
    });

    test("a recreated same-named Graph never reads its predecessor's replica", async () => {
      const base = ctx.urls().graphPathsUrl;
      await installRoot(base);
      const member = await signToken(GRAPH_PATH_ROOT_DATABASE, "member");
      const suffix = crypto.randomUUID().slice(0, 8);
      const workspaceName = `reused-${suffix}`;
      const projectName = `project-${suffix}`;
      const predecessorText = `predecessor-${suffix}`;

      const workspace = await invoke(base, member, {
        owner: { kind: "entity", name: Workspace.ns },
        localName: "create",
      }, { name: workspaceName });
      expect(workspace.status).toBe(200);
      const workspaceId = await openEntityHandle(
        base,
        GRAPH_PATH_ROOT_DATABASE,
        member,
        workspace.body.result.id as string,
      );
      expect((await invoke(base, member, {
        owner: { kind: "entity", name: Project.ns },
        localName: "create",
      }, { name: projectName }, { at: [workspaceName] })).status).toBe(200);
      expect((await invoke(base, member, {
        owner: { kind: "entity", name: "localNestedNote" },
        localName: "create",
      }, { text: predecessorText }, { at: [workspaceName, projectName] })).status)
        .toBe(200);

      const activated = await nestedReplication(
        base,
        member,
        [workspaceName, projectName],
      );
      expect(activated.status).toBe(200);
      const activation = readReplicationNdjson(activated)[Symbol.asyncIterator]();
      const predecessor = await collectCommittedSnapshot(activation);
      await closeObservedStream(activation);
      const predecessorIdentity = predecessor.state.identity!;
      const predecessorRevision = predecessor.state.committed!.revision;
      expect(predecessor.state.committed?.datoms.some((datom) =>
        datom.value.type === "string" && datom.value.value === predecessorText
      )).toBe(true);

      const removed = await invoke(base, member, {
        owner: { kind: "entity", name: Workspace.ns },
        localName: "remove",
      }, {}, { target: workspaceId });
      expect(removed.status).toBe(200);

      const gone = await nestedReplication(
        base,
        member,
        [workspaceName, projectName],
        predecessorRevision,
      );
      expect(gone.status).toBe(403);
      await gone.text();

      const recreated = await invoke(base, member, {
        owner: { kind: "entity", name: Workspace.ns },
        localName: "create",
      }, { name: workspaceName });
      expect(recreated.status).toBe(200);
      const recreatedId = await openEntityHandle(
        base,
        GRAPH_PATH_ROOT_DATABASE,
        member,
        recreated.body.result.id as string,
      );
      expect(recreatedId).not.toBe(workspaceId);
      expect((await invoke(base, member, {
        owner: { kind: "entity", name: Project.ns },
        localName: "create",
      }, { name: projectName }, { at: [workspaceName] })).status).toBe(200);

      const successorResponse = await nestedReplication(
        base,
        member,
        [workspaceName, projectName],
        predecessorRevision,
      );
      expect(successorResponse.status).toBe(200);
      const successorFrames = readReplicationNdjson(
        successorResponse,
      )[Symbol.asyncIterator]();
      try {
        const successor = await collectCommittedSnapshot(successorFrames);
        expect(successor.frames.some((observed) =>
          observed.frame.type === "ResumeReady"
        )).toBe(false);
        const successorIdentity = successor.state.identity!;
        expect(successorIdentity.database).not.toBe(predecessorIdentity.database);
        expect(successorIdentity.readView).not.toBe(predecessorIdentity.readView);
        expect(successorIdentity.graphLineage)
          .not.toEqual(predecessorIdentity.graphLineage);
        expect(successorIdentity.authenticator)
          .not.toBe(predecessorIdentity.authenticator);
        expect(successorIdentity.readCompatibilityHash)
          .toBe(predecessorIdentity.readCompatibilityHash);
        expect(successor.frames.map((observed) => observed.wire).join("\n"))
          .not.toMatch(new RegExp(predecessorText));
      } finally {
        await closeObservedStream(successorFrames);
      }
    });

    test("half-megabyte string and byte values arrive whole over the real snapshot path", async () => {
      const base = ctx.urls().graphPathsUrl;
      await installRoot(base);
      const member = await signToken(GRAPH_PATH_ROOT_DATABASE, "member");
      const suffix = crypto.randomUUID().slice(0, 8);
      const workspaceName = `bulk-${suffix}`;
      const projectName = `project-${suffix}`;

      const workspace = await invoke(base, member, {
        owner: { kind: "entity", name: Workspace.ns },
        localName: "create",
      }, { name: workspaceName });
      expect(workspace.status).toBe(200);
      const project = await invoke(base, member, {
        owner: { kind: "entity", name: Project.ns },
        localName: "create",
      }, { name: projectName }, { at: [workspaceName] });
      expect(project.status).toBe(200);

      const body = largeUtf8Text(HALF_MEGABYTE);
      const blob = largeBytes(HALF_MEGABYTE);
      expect(new TextEncoder().encode(body).byteLength).toBe(HALF_MEGABYTE);
      expect(blob.byteLength).toBe(HALF_MEGABYTE);

      const written = await invoke(base, member, {
        owner: { kind: "entity", name: BulkValue.ns },
        localName: "create",
      }, {
        label: `bulk-${suffix}`,
        body,
        blob: bytesToBase64(blob),
      }, { at: [workspaceName, projectName] });
      expect(written.status).toBe(200);

      const response = await nestedReplication(
        base,
        member,
        [workspaceName, projectName],
      );
      expect(response.status).toBe(200);
      const frames = readReplicationNdjson(response)[Symbol.asyncIterator]();
      try {
        const snapshot = await collectCommittedSnapshot(frames);
        const parts = snapshot.frames.flatMap((observed) =>
          observed.frame.type === "SnapshotChunk"
            ? observed.frame.datoms.map((datom) => datom.value.type)
            : []
        );
        expect(parts.filter((type) => type === "string-part").length)
          .toBeGreaterThan(1);
        expect(parts.filter((type) => type === "bytes-part").length)
          .toBeGreaterThan(1);

        const datoms = snapshot.state.committed?.datoms ?? [];
        const restoredBody = datoms.find((datom) =>
          datom.field === ":localBulkValue/body"
        );
        const restoredBlob = datoms.find((datom) =>
          datom.field === ":localBulkValue/blob"
        );
        expect(restoredBody?.value.type).toBe("string");
        expect(restoredBlob?.value.type).toBe("bytes");
        if (restoredBody?.value.type !== "string") throw new Error("no body");
        if (restoredBlob?.value.type !== "bytes") throw new Error("no blob");
        expect(restoredBody.value.value).toBe(body);
        const restoredBlobBytes = base64ToBytes(restoredBlob.value.value);
        expect(restoredBlobBytes.byteLength).toBe(blob.byteLength);
        expect(firstDifferingByte(restoredBlobBytes, blob)).toBe(-1);
      } finally {
        await closeObservedStream(frames);
      }
    });

    test("an offline-queued child mutation reaches the child, not the root", async () => {
      const base = ctx.urls().graphPathsUrl;
      await installRoot(base);
      const member = await signToken(GRAPH_PATH_ROOT_DATABASE, "member");
      const suffix = crypto.randomUUID().slice(0, 8);
      const workspaceName = `queued-${suffix}`;
      const projectName = `queued-project-${suffix}`;
      const text = `queued-note-${suffix}`;

      const workspace = await invoke(base, member, {
        owner: { kind: "entity", name: Workspace.ns },
        localName: "create",
      }, { name: workspaceName });
      expect(workspace.status).toBe(200);
      const project = await invoke(base, member, {
        owner: { kind: "entity", name: Project.ns },
        localName: "create",
      }, { name: projectName }, { at: [workspaceName] });
      expect(project.status).toBe(200);

      const lowered = await Effect.runPromise(lowerOwnedOperations(
        CatalogId.make("local-graph-leaf"),
        GraphPathLeafSchema,
        DigestHex.make("0".repeat(64)),
      ));
      const version = lowered.descriptors.find((descriptor) =>
        descriptor.id.owner.name === "localNestedNote" &&
        descriptor.id.localName === "create"
      )!.version;

      const record = buildOutboxRecord({
        invocation: invocationId(),
        receiver: {
          server: "s".repeat(43),
          principal: "p".repeat(43),
          database: "d".repeat(43),
        },
        operation: {
          catalog: "local-graph-leaf" as never,
          owner: { kind: "entity", name: "localNestedNote" },
          localName: "create",
        },
        operationVersion: version as never,
        target: { type: "none" },
        input: { text },
        allocations: [],
        inputRefs: [],
        enqueuedAt: 1_700_000_000_000,
      }, "scope", 1);

      const substituted = substituteMutationRefs(record, new Map());
      expect(substituted).toBeDefined();
      const response = await submitMutation(buildMutationRequest(record, {
        origin: new URL(base).origin,
        database: GRAPH_PATH_ROOT_DATABASE,
        graphPath: [workspaceName, projectName],
        credential: member,
      }, substituted!));
      expect(classifyMutationResponse(record, response)._tag).toBe("Committed");

      const notes = await nestedLive(base, member, [workspaceName, projectName]);
      expect(notes.status).toBe(200);
      const diffs = readLiveNdjson(notes)[Symbol.asyncIterator]();
      try {
        const first = await withTimeout(diffs.next(), 7_000, "queued child note");
        expect(first.done).toBe(false);
        expect(applyLiveDiffs([first.value!])).toContain(text);
      } finally {
        await closeObservedStream(diffs);
      }
    });

    test("a child bound to another catalog is refused before any data", async () => {
      const base = ctx.urls().graphPathsUrl;
      await installRoot(base);
      const member = await signToken(GRAPH_PATH_ROOT_DATABASE, "member");
      const suffix = crypto.randomUUID().slice(0, 8);
      const workspaceName = `foreign-catalog-${suffix}`;

      const workspace = await invoke(base, member, {
        owner: { kind: "entity", name: Workspace.ns },
        localName: "create",
      }, { name: workspaceName });
      expect(workspace.status).toBe(200);
      const project = await invoke(base, member, {
        owner: { kind: "entity", name: Project.ns },
        localName: "create",
      }, { name: `project-${suffix}` }, { at: [workspaceName] });
      expect(project.status).toBe(200);

      const response = await nestedReplication(
        base,
        member,
        [workspaceName],
        undefined,
        graphPathRootReadCompatibilityHash,
      );

      expect(response.status).toBe(409);
      const frames = readReplicationNdjson(response)[Symbol.asyncIterator]();
      try {
        const first = await withTimeout(
          frames.next(),
          7_000,
          "foreign-catalog activation",
        );
        expect(first.done).toBe(false);
        expect(first.value?.frame).toEqual({
          type: "TerminalError",
          protocol: 2,
          code: "update-required",
        });
        const next = await withTimeout(
          frames.next(),
          7_000,
          "foreign-catalog stream end",
        );
        expect(next.done).toBe(true);
        expect(first.value?.wire).not.toMatch(
          /local-graph-child|local-graph-root|catalog|hash/i,
        );
      } finally {
        await closeObservedStream(frames);
      }

      const compatible = await nestedReplication(
        base,
        member,
        [workspaceName],
        undefined,
        graphPathChildReadCompatibilityHash,
      );
      expect(compatible.status).toBe(200);
      const stream = readReplicationNdjson(compatible)[Symbol.asyncIterator]();
      await closeObservedStream(stream);
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
