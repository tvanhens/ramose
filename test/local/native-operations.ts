import { beforeAll, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as EffectSchema from "effect/Schema";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import { schemaTx } from "../../packages/ramose/src/db/internal.ts";
import {
  clientRef,
  Entity,
  EntityId as OperationEntityId,
  isEntityId,
  Schema,
  string,
} from "ramose/db";
import { invocationId, type EntityId } from "../../packages/ramose/src/db/refs.ts";
import { base64Url } from "../../packages/ramose/src/internal/replication/server-identity.ts";
import {
  buildOutboxRecord,
  mappingKey,
  type OutboxDraft,
  type OutboxRecord,
} from "../../packages/ramose/src/internal/replication/outbox.ts";
import {
  buildMutationRequest,
  classifyMutationResponse,
  substituteMutationRefs,
} from "../../packages/ramose/src/internal/replication/submission.ts";
import { submitMutation } from "../../packages/ramose/src/internal/replication/transport.ts";
import { lowerOwnedOperations } from "../../packages/ramose/src/internal/authorization/authoring/index.ts";
import {
  CatalogId,
  DigestHex,
} from "../../packages/ramose/src/internal/authorization/identities.ts";
import {
  json,
  openEntityHandle,
  testAdmin,
  type LocalUrls,
} from "./fixtures.ts";
import {
  OperationSchema,
} from "./operation-catalog.ts";
import { loadOperationProof, operationProof } from "./operation-proof.ts";

const invoke = async (
  base: string,
  database: string,
  token: string,
  operation: {
    readonly owner: { readonly kind: "entity" | "trait"; readonly name: string };
    readonly localName: string;
  },
  input: unknown,
  target?: number,
  invocationId: string = crypto.randomUUID(),
  operationVersion?: string,
) => json(base, `/db/${database}/op`, {
  method: "POST",
  token,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...operationProof,
    invocationId,
    operation,
    input,
    ...(target === undefined ? {} : { target }),
    ...(operationVersion === undefined ? {} : { operationVersion }),
  }),
});

/**
 * Operation-scoped versions (#487) as a *different* deployment computes them.
 * The real lowering pipeline runs here against an artifact hash that is not
 * the deployed Worker's, so any value accepted below is proof that the
 * compatibility digest carries no deployment identity.
 */
const otherDeploymentVersions = async (): Promise<Map<string, string>> => {
  const lowered = await Effect.runPromise(lowerOwnedOperations(
    CatalogId.make("local-native-operations"),
    OperationSchema,
    DigestHex.make("5c".repeat(32)),
  ));
  return new Map(lowered.descriptors.map((descriptor) => [
    `${descriptor.id.owner.name}/${descriptor.id.localName}`,
    descriptor.version as string,
  ]));
};

/**
 * The same `nativeItem/create` contract under an author-declared revision
 * bump — exactly what a semantics-changing redeploy of that one operation
 * produces. At revision 1 it must reproduce the deployed version.
 */
const createVersionAtRevision = async (revision: number): Promise<string> => {
  const Replica = Entity("nativeItem", { title: string() }, {
    operations: (Operation) => ({
      create: Operation({
        self: false,
        revision,
        input: EffectSchema.Struct({ title: EffectSchema.String }),
        output: EffectSchema.Struct({ id: OperationEntityId }),
        run(op, input) {
          return { id: op.create({ title: input.title }) };
        },
      }),
    }),
  });
  const lowered = await Effect.runPromise(lowerOwnedOperations(
    CatalogId.make("local-native-operations"),
    Schema({ nativeItem: Replica }),
    DigestHex.make("7d".repeat(32)),
  ));
  return lowered.descriptors[0]!.version as string;
};

/**
 * The same `nativeItem/create` contract as a *targeted* operation — the shape
 * change that used to make a pinned queued invocation look like an
 * authorization denial rather than a changed operation.
 */
const targetedCreateVersion = async (): Promise<string> => {
  const Replica = Entity("nativeItem", { title: string() }, {
    operations: (Operation) => ({
      create: Operation({
        input: EffectSchema.Struct({ title: EffectSchema.String }),
        output: EffectSchema.Struct({ id: OperationEntityId }),
        run() {
          return { id: 1 };
        },
      }),
    }),
  });
  const lowered = await Effect.runPromise(lowerOwnedOperations(
    CatalogId.make("local-native-operations"),
    Schema({ nativeItem: Replica }),
    DigestHex.make("7d".repeat(32)),
  ));
  return lowered.descriptors[0]!.version as string;
};

/** The same `/op` boundary, for bodies this contract shapes itself. */
const invokeWith = async (
  base: string,
  database: string,
  token: string,
  body: Record<string, unknown>,
) => json(base, `/db/${database}/op`, {
  method: "POST",
  token,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...operationProof, ...body }),
});

/**
 * A syntactically valid sealed envelope this server cannot read.
 *
 * The preamble is what decides quarantine — byte 0 is the codec version and
 * bytes 1..17 are the key id in *every* envelope version — so a handle can be
 * built here without any key material at all, which is exactly the property
 * that makes the quarantine data-free.
 */
const unreadableEntityId = (
  kind: "codec-version" | "key-epoch",
): string => {
  const envelope = new Uint8Array(41);
  envelope[0] = kind === "codec-version" ? 2 : 1;
  // A key id no server ever minted, so the epoch cannot match.
  for (let index = 1; index < 17; index++) envelope[index] = 0xa5;
  return base64Url(envelope);
};

const withoutReceipt = (body: Record<string, unknown>) => {
  const { receipt: _receipt, ...rest } = body;
  return rest;
};

const install = async (base: string, database: string) => {
  const response = await testAdmin(base, database, "/transact", {
    tx: schemaTx(OperationSchema),
  });
  expect(response.status).toBe(200);
};

const operationReceiptCount = async (
  base: string,
  database: string,
): Promise<number> => {
  const response = await testAdmin(
    base,
    database,
    "/operation-receipts",
    {},
  );
  expect(response.status).toBe(200);
  expect(response.body.count).toBeNumber();
  return response.body.count as number;
};

const waitForCheckpoint = async (
  base: string,
  database: string,
  scope: "worker" | "transactor",
  name: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await testAdmin(base, database, "/checkpoint", {
      scope,
      action: "status",
    });
    if (status.body.checkpoints?.[name]?.pending === true) return;
    await Bun.sleep(25);
  }
  throw new Error(`operation did not reach the ${scope} ${name} checkpoint`);
};

export const registerNativeOperations = (ctx: { urls: () => LocalUrls }) => {
  describe("native deployed operations", () => {
    beforeAll(() => loadOperationProof(ctx.urls().nativeOperationsUrl));

    test("static operation commits through the real Worker/Transactor/R2 topology", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-static";
      await install(base, database);
      const token = await signToken(database, "member");
      const created = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "create",
      }, { title: "Created" });
      expect(created.status).toBe(200);
      // The opaque server-issued handle, never the private eid (#475).
      expect(isEntityId(created.body.result.id)).toBe(true);
      const createdEid = await openEntityHandle(
        base,
        database,
        token,
        created.body.result.id as string,
      );
      expect(created.body.receipt).toEqual({
        version: 2,
        invocationId: expect.any(String),
        status: "completed",
      });
      expect(Object.hasOwn(created.body, "t")).toBe(false);
      expect(created.res.headers.get("x-ramose-basis-t")).toBeNull();

      // Test-only instrumentation may observe the internal basis to fence the
      // real Replica read; the public operation response above may not.
      const basis = await testAdmin(base, database, "/basis", { action: "fetch" }, {
        "x-ramose-cache-basis": "0",
      });
      expect(basis.status).toBe(200);
      const committedT = basis.body.basis.t as number;

      const readBack = await json(base, `/db/${database}/entity/${createdEid}`, {
        token,
        headers: {
          "x-ramose-catalog": operationProof.catalog,
          "x-ramose-unit-hash": operationProof.unitHash,
          "x-ramose-min-t": String(committedT),
        },
      });
      expect(readBack.status).toBe(200);
      expect(readBack.body.result).toMatchObject({
        ":ramose/type": ":nativeItem",
        ":nativeItem/title": "Created",
        ":nativeItem/state": "new",
      });

      const transportTag = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "returnTransportTag",
      }, {});
      expect(transportTag.status).toBe(200);
      expect(transportTag.body).toMatchObject({
        result: { $inst: "application-value" },
      });

      const transportTagInput = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "echoTransportTagInput",
      }, { $inst: "application-input" });
      expect(transportTagInput.status).toBe(200);
      expect(transportTagInput.body).toMatchObject({
        result: { $inst: "application-input" },
      });

      const exactToken = await signToken(database, "member", "user_wire", {
        transportClaim: "claim-owned",
      });
      const exactInput = {
        tagged: { vt: 3, v: "input-owned" },
        ownProto: JSON.parse('{"__proto__":"input-owned","kept":true}'),
      };
      const exactWire = await invoke(base, database, exactToken, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "echoExactWireValues",
      }, exactInput);
      expect(exactWire.status).toBe(200);
      const exactResult = exactWire.body.result as Record<string, unknown>;
      expect((exactResult.input as Record<string, unknown>).tagged).toEqual({
        vt: 3,
        v: "input-owned",
      });
      expect(exactResult.claim).toBe("claim-owned");
      expect(exactResult.tagged).toEqual({ vt: 1, v: "output-owned" });
      const inputProto = (exactResult.input as Record<string, unknown>).ownProto as Record<string, unknown>;
      expect(Object.hasOwn(inputProto, "__proto__")).toBe(true);
      expect(inputProto.__proto__).toBe("input-owned");
      const outputProto = exactResult.ownProto as Record<string, unknown>;
      expect(Object.hasOwn(outputProto, "__proto__")).toBe(true);
      expect(outputProto.__proto__).toBe("output-owned");
      expect(outputProto.kept).toBe(true);
    });

    test("concurrent duplicates commit once and replay one exact durable receipt", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-idempotent-concurrent";
      await install(base, database);
      const token = await signToken(database, "member", "user_concurrent");
      const operation = {
        owner: { kind: "entity" as const, name: "nativeItem" },
        localName: "create",
      };
      const input = { title: "Exactly once" };
      const invocationId = "concurrent-invocation-01";

      const delivered = await Promise.all(
        Array.from({ length: 8 }, () =>
          invoke(
            base,
            database,
            token,
            operation,
            input,
            undefined,
            invocationId,
          )
        ),
      );
      expect(delivered.every((response) => response.status === 200)).toBe(true);
      const first = delivered[0]!.body;
      expect(isEntityId(first.result.id)).toBe(true);
      expect(first.receipt).toEqual({
        version: 2,
        invocationId,
        status: "completed",
      });
      expect(delivered.map((response) => response.body)).toEqual(
        Array.from({ length: delivered.length }, () => first),
      );

      const beforeRestart = await testAdmin(base, database, "/query", {
        query: '[:find ?e :where [?e :nativeItem/title "Exactly once"]]',
      });
      expect(beforeRestart.body.result).toEqual([[
        await openEntityHandle(base, database, token, first.result.id as string),
      ]]);

      const aborted = await testAdmin(base, database, "/abort", {
        target: "transactor",
      });
      expect(aborted.status).toBe(200);
      const replayed = await invoke(
        base,
        database,
        token,
        operation,
        input,
        undefined,
        invocationId,
      );
      expect(replayed.status).toBe(200);
      expect(replayed.body).toEqual(first);

      const changed = await invoke(
        base,
        database,
        token,
        operation,
        { title: "Must not execute" },
        undefined,
        invocationId,
      );
      expect(changed.status).toBe(409);
      expect(changed.body).toEqual({
        error: "request rejected",
        code: "invocation_conflict",
      });
      const absent = await testAdmin(base, database, "/query", {
        query: '[:find ?e :where [?e :nativeItem/title "Must not execute"]]',
      });
      expect(absent.body.result).toEqual([]);
    });

    test("a self-deleting operation replays after restart without treating its own commit as revocation", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-idempotent-self-delete";
      await install(base, database);
      const token = await signToken(database, "member", "user_self_delete");
      const created = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "create",
      }, { title: "Erase me" });
      expect(created.status).toBe(200);
      const target = created.body.result.id as number;
      const invocationId = "self-delete-invocation-01";
      const operation = {
        owner: { kind: "entity" as const, name: "nativeItem" },
        localName: "deleteAndEchoTitle",
      };
      const completed = await invoke(
        base,
        database,
        token,
        operation,
        {},
        target,
        invocationId,
      );
      expect(completed.status).toBe(200);
      expect(completed.body).toEqual({
        result: { title: "ERASE ME" },
        receipt: { version: 2, invocationId, status: "completed" },
      });

      // Prove replay remains exact after a later unrelated writer position and
      // a new isolate, while the original target remains absent.
      const unrelated = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "create",
      }, { title: "Unrelated later commit" });
      expect(unrelated.status).toBe(200);
      const aborted = await testAdmin(base, database, "/abort", {
        target: "transactor",
      });
      expect(aborted.status).toBe(200);

      const replayed = await invoke(
        base,
        database,
        token,
        operation,
        {},
        target,
        invocationId,
      );
      expect(replayed.status).toBe(200);
      expect(replayed.body).toEqual(completed.body);
      const state = await testAdmin(base, database, "/query", {
        query: '[:find ?title :where [?e :nativeItem/title ?title]]',
      });
      expect(state.body.result).toEqual([["Unrelated later commit"]]);
    });

    test("a disconnected caller retries the exact post-commit result", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-idempotent-disconnect";
      await install(base, database);
      const token = await signToken(database, "member", "user_disconnect");
      const invocationId = "disconnect-invocation-01";
      const armed = await testAdmin(base, database, "/checkpoint", {
        scope: "worker",
        action: "arm-wait",
        name: "operation.response",
      });
      expect(armed.status).toBe(200);

      const controller = new AbortController();
      const pending = fetch(
        `${base.replace(/\/+$/, "")}/db/${database}/op`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...operationProof,
            invocationId,
            operation: {
              owner: { kind: "entity", name: "nativeItem" },
              localName: "create",
            },
            input: { title: "Lost acknowledgement" },
          }),
        },
      );
      let released = false;
      try {
        await waitForCheckpoint(base, database, "worker", "operation.response");
        controller.abort();
        await pending.catch(() => undefined);
        await testAdmin(base, database, "/checkpoint", {
          scope: "worker",
          action: "release",
          name: "operation.response",
        });
        released = true;
      } finally {
        controller.abort();
        if (!released) {
          await testAdmin(base, database, "/checkpoint", {
            scope: "worker",
            action: "release",
            name: "operation.response",
          });
        }
      }

      const replayed = await invoke(
        base,
        database,
        token,
        {
          owner: { kind: "entity", name: "nativeItem" },
          localName: "create",
        },
        { title: "Lost acknowledgement" },
        undefined,
        invocationId,
      );
      expect(replayed.status).toBe(200);
      expect(isEntityId(replayed.body.result.id)).toBe(true);
      expect(replayed.body.receipt).toEqual({
        version: 2,
        invocationId,
        status: "completed",
      });
      const committed = await testAdmin(base, database, "/query", {
        query: '[:find ?e :where [?e :nativeItem/title "Lost acknowledgement"]]',
      });
      expect(committed.body.result).toEqual([[
        await openEntityHandle(base, database, token, replayed.body.result.id as string),
      ]]);
    });

    test("authorization-scope changes conflict instead of replaying or executing", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-idempotent-authorization";
      await install(base, database);
      const invocationId = "authorization-invocation-01";
      const now = Math.floor(Date.now() / 1_000);
      const member = await signToken(
        database,
        "member",
        "user_scope",
        undefined,
        { iat: now - 30, exp: now + 240 },
      );
      const changedAuthorization = await signToken(
        database,
        "reader",
        "user_scope",
      );
      const operation = {
        owner: { kind: "entity" as const, name: "nativeItem" },
        localName: "create",
      };
      const input = { title: "Scoped result" };
      const completed = await invoke(
        base,
        database,
        member,
        operation,
        input,
        undefined,
        invocationId,
      );
      expect(completed.status).toBe(200);

      const changed = await invoke(
        base,
        database,
        changedAuthorization,
        operation,
        input,
        undefined,
        invocationId,
      );
      expect(changed.status).toBe(409);
      expect(changed.body).toEqual({
        error: "request rejected",
        code: "invocation_conflict",
      });

      const renewed = await signToken(
        database,
        "member",
        "user_scope",
        undefined,
        { iat: now, exp: now + 300 },
      );
      const replayed = await invoke(
        base,
        database,
        renewed,
        operation,
        input,
        undefined,
        invocationId,
      );
      // Byte-identical, including the sealed handle: an ordinary token
      // refresh changes `iat`/`exp`, which the scope deliberately excludes.
      expect(replayed.body).toEqual(completed.body);
      const committed = await testAdmin(base, database, "/query", {
        query: '[:find ?e :where [?e :nativeItem/title "Scoped result"]]',
      });
      expect(committed.body.result).toEqual([[
        await openEntityHandle(
          base,
          database,
          member,
          completed.body.result.id as string,
        ),
      ]]);
    });

    test("the first exact retry lazily recovers an isolate-lost claim without execution", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-idempotent-indeterminate";
      await install(base, database);
      const token = await signToken(database, "member", "user_indeterminate");
      const invocationId = "indeterminate-invocation-01";
      const armed = await testAdmin(base, database, "/checkpoint", {
        scope: "transactor",
        action: "arm-wait",
        name: "operation.claimed",
      });
      expect(armed.status).toBe(200);

      const pending = invoke(
        base,
        database,
        token,
        {
          owner: { kind: "entity", name: "nativeItem" },
          localName: "create",
        },
        { title: "Never executed" },
        undefined,
        invocationId,
      );
      await waitForCheckpoint(
        base,
        database,
        "transactor",
        "operation.claimed",
      );
      const aborted = await testAdmin(base, database, "/abort", {
        target: "transactor",
      });
      expect(aborted.status).toBe(200);
      await pending.catch(() => undefined);

      let recovered: Awaited<ReturnType<typeof invoke>> | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        recovered = await invoke(
          base,
          database,
          token,
          {
            owner: { kind: "entity", name: "nativeItem" },
            localName: "create",
          },
          { title: "Never executed" },
          undefined,
          invocationId,
        );
        if (recovered.status === 409) break;
        await Bun.sleep(50);
      }
      expect(recovered?.status).toBe(409);
      expect(recovered?.body).toEqual({
        error: "request state is indeterminate",
        code: "invocation_indeterminate",
        receipt: {
          version: 2,
          invocationId,
          status: "indeterminate",
        },
      });
      const absent = await testAdmin(base, database, "/query", {
        query: '[:find ?e :where [?e :nativeItem/title "Never executed"]]',
      });
      expect(absent.body.result).toEqual([]);
    });

    test("targeted operation requires both its grant and filtered target visibility", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-targeted";
      await install(base, database);
      const member = await signToken(database, "member");
      const item = await invoke(base, database, member, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "create",
      }, { title: "Before" });
      expect(item.status).toBe(200);
      const renamed = await invoke(base, database, member, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "rename",
      }, { title: "After" }, item.body.result.id);
      expect(renamed.status).toBe(200);
      expect(renamed.body.result).toEqual({ id: item.body.result.id, title: "After" });

      const receiptsBeforeDenials = await operationReceiptCount(base, database);
      const reader = await signToken(database, "reader");
      const readableButNotGranted = await invoke(base, database, reader, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "rename",
      }, { title: "Denied" }, item.body.result.id);
      expect(readableButNotGranted.status).toBe(403);

      const operator = await signToken(database, "operator");
      const grantedButHidden = await invoke(base, database, operator, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "rename",
      }, { title: "Denied" }, item.body.result.id);
      const nonexistent = await invoke(base, database, member, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "rename",
      }, { title: "Denied" }, 999_999);
      expect(grantedButHidden.status).toBe(403);
      expect(nonexistent.status).toBe(403);
      expect(withoutReceipt(grantedButHidden.body)).toEqual(
        withoutReceipt(nonexistent.body),
      );

      const uniqueUnauthorized = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          invoke(
            base,
            database,
            index % 2 === 0 ? reader : operator,
            {
              owner: { kind: "entity" as const, name: "nativeItem" },
              localName: "rename",
            },
            { title: `Denied ${index}` },
            item.body.result.id,
            `unauthorized-unique-${index}`,
          )
        ),
      );
      expect(uniqueUnauthorized.every((response) => response.status === 403))
        .toBe(true);
      expect(await operationReceiptCount(base, database)).toBe(
        receiptsBeforeDenials,
      );

      const invalidInput = await invoke(base, database, member, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "rename",
      }, { title: 42 }, item.body.result.id);
      expect(invalidInput.status).toBe(400);
      expect(invalidInput.res.headers.get("access-control-allow-origin")).toBe("*");
      expect(invalidInput.res.headers.get("access-control-allow-methods")).toContain("POST");
    });

    test("an operation expiring at the real DO commit fence fails atomically", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-expiry";
      await install(base, database);
      const exp = Math.floor(Date.now() / 1_000) + 4;
      const token = await signToken(database, "member", "user_ada", undefined, { exp });
      const armed = await testAdmin(base, database, "/checkpoint", {
        scope: "transactor",
        action: "arm-wait",
        name: "transactor.commit",
      });
      expect(armed.status).toBe(200);

      const pending = invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "create",
      }, { title: "Expired" });
      let released = false;
      try {
        await waitForCheckpoint(base, database, "transactor", "transactor.commit");
        const untilExpiry = exp * 1_000 - Date.now() + 25;
        if (untilExpiry > 0) await Bun.sleep(untilExpiry);
        // Releasing lets the expiry fence abort this DO. The admin request may
        // therefore observe that same abort (500) even though it released the
        // real checkpoint, so the operation result is the authoritative check.
        await testAdmin(base, database, "/checkpoint", {
          scope: "transactor",
          action: "release",
          name: "transactor.commit",
        });
        released = true;
      } finally {
        if (!released) {
          await testAdmin(base, database, "/checkpoint", {
            scope: "transactor",
            action: "release",
            name: "transactor.commit",
          });
        }
      }

      const expired = await pending;
      expect(expired.status).toBe(500);
      expect(expired.body).toEqual({ error: "internal error" });
      expect(Object.hasOwn(expired.body, "t")).toBe(false);
      expect(expired.res.headers.get("x-ramose-basis-t")).toBeNull();

      const absent = await testAdmin(base, database, "/query", {
        query: '[:find ?e :where [?e :nativeItem/title "Expired"]]',
      });
      expect(absent.status).toBe(200);
      expect(absent.body.result).toEqual([]);
    });

    test("an operation expiring after the real DO acknowledgement commits but returns no result", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-response-expiry";
      await install(base, database);
      // Initialize the real Replica before arming module-isolate checkpoint
      // state. DO constructors intentionally reset stale test hooks.
      const warmed = await testAdmin(base, database, "/query", {
        query: "[:find ?e :where [?e :nativeItem/title ?title]]",
      });
      expect(warmed.status).toBe(200);
      const exp = Math.floor(Date.now() / 1_000) + 4;
      const token = await signToken(database, "member", "user_ada", undefined, { exp });
      const armed = await testAdmin(base, database, "/checkpoint", {
        scope: "worker",
        action: "arm-wait",
        name: "operation.response",
        // The delay starts only once the real Worker boundary is reached, so
        // this releases the same isolate-local arm after the JWT is exact-expired.
        releaseAfterMs: exp * 1_000 - Date.now() + 25,
      });
      expect(armed.status).toBe(200);

      const title = "Committed before response expiry";
      const pending = invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "create",
      }, { title });
      await waitForCheckpoint(base, database, "worker", "operation.response");

      // Reaching the Worker checkpoint means the real Transactor returned its
      // acknowledgement. Fence a real Replica read to that committed basis
      // while the public operation response remains parked.
      const basis = await testAdmin(base, database, "/basis", { action: "fetch" }, {
        "x-ramose-cache-basis": "0",
      });
      expect(basis.status).toBe(200);
      const committedT = basis.body.basis.t as number;
      const committed = await testAdmin(base, database, "/query", {
        query: `[:find ?e :where [?e :nativeItem/title ${JSON.stringify(title)}]]`,
      }, {
        "x-ramose-min-t": String(committedT),
      });
      expect(committed.status).toBe(200);
      expect(committed.body.result).toEqual([[expect.any(Number)]]);

      const expired = await pending;
      expect(Date.now()).toBeGreaterThanOrEqual(exp * 1_000);
      expect(expired.status).toBe(403);
      expect(expired.body).toEqual({ error: "unauthorized" });
      expect(Object.hasOwn(expired.body, "result")).toBe(false);
      expect(Object.hasOwn(expired.body, "t")).toBe(false);

      const persisted = await testAdmin(base, database, "/query", {
        query: `[:find ?e :where [?e :nativeItem/title ${JSON.stringify(title)}]]`,
      });
      expect(persisted.status).toBe(200);
      expect(persisted.body.result).toEqual([[expect.any(Number)]]);
    });

    test("trusted native code reads and mutates application data hidden from its caller", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-trusted";
      await install(base, database);
      const member = await signToken(database, "member");
      const created = await invoke(base, database, member, {
        owner: { kind: "entity", name: "nativeOther" },
        localName: "create",
      }, { name: "Hidden" });
      expect(created.status).toBe(200);
      const hiddenId = await openEntityHandle(
        base,
        database,
        member,
        created.body.result.id as string,
      );

      const ordinaryRead = await json(base, `/db/${database}/entity/${hiddenId}`, {
        token: member,
        headers: {
          "x-ramose-catalog": operationProof.catalog,
          "x-ramose-unit-hash": operationProof.unitHash,
        },
      });
      expect(ordinaryRead.status).toBe(200);
      expect(JSON.stringify(ordinaryRead.body)).not.toContain("Hidden");

      const invocationId = "consumed-ref-invocation-01";
      const operation = {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "deleteHiddenOther",
      } as const;
      const input = { id: hiddenId };
      const trusted = await invoke(
        base,
        database,
        member,
        operation,
        input,
        undefined,
        invocationId,
      );
      expect(trusted.status).toBe(200);
      expect(trusted.body).toMatchObject({ result: { name: "HIDDEN" } });

      const absent = await testAdmin(base, database, "/query", {
        query: `[:find ?e :where [?e :nativeOther/name "Hidden"]]`,
      });
      expect(absent.status).toBe(200);
      expect(absent.body.result).toEqual([]);

      const replayed = await invoke(
        base,
        database,
        member,
        operation,
        input,
        undefined,
        invocationId,
      );
      expect(replayed.status).toBe(200);
      expect(replayed.body).toEqual(trusted.body);
    });

    test("raw writes and stale unit proofs remain closed", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-denials";
      await install(base, database);
      const token = await signToken(database, "member");
      const raw = await json(base, `/db/${database}/transact`, {
        method: "POST",
        token,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx: [{ ":nativeItem/title": "raw" }] }),
      });
      expect(raw.status).toBe(401);

      const firstUnique = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeOther" },
        localName: "create",
      }, { name: "Conflict" });
      expect(firstUnique.status).toBe(200);
      const conflictInvocationId = "post-claim-tx-rejection-01";
      const conflict = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeOther" },
        localName: "create",
      }, { name: "Conflict" }, undefined, conflictInvocationId);
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({
        error: "request rejected",
        receipt: { status: "rejected" },
      });
      expect(JSON.stringify(conflict.body)).not.toContain(String(firstUnique.body.result.id));
      const conflictReplay = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeOther" },
        localName: "create",
      }, { name: "Conflict" }, undefined, conflictInvocationId);
      expect(conflictReplay).toMatchObject({
        status: conflict.status,
        body: conflict.body,
      });

      const bodyCrashInvocationId = "post-claim-body-failure-01";
      const crashed = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "crash",
      }, {}, undefined, bodyCrashInvocationId);
      expect(crashed.status).toBe(500);
      expect(crashed.body.error).toBe("internal error");
      expect(crashed.body).toMatchObject({
        code: "invocation_failed",
        receipt: { status: "failed" },
      });
      expect(JSON.stringify(crashed.body)).not.toContain("secret@internal");
      const crashedReplay = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "crash",
      }, {}, undefined, bodyCrashInvocationId);
      expect(crashedReplay).toMatchObject({
        status: crashed.status,
        body: crashed.body,
      });

      const receiptsBeforeInputAdmission = await operationReceiptCount(
        base,
        database,
      );
      const invalidInputId = "pre-admission-invalid-input-01";
      const invalidInput = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "inputCrash",
      }, { value: 42 }, undefined, invalidInputId);
      expect(invalidInput.status).toBe(400);
      expect(invalidInput.body).toEqual({ error: "invalid request" });
      expect((await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "inputCrash",
      }, { value: 42 }, undefined, invalidInputId)).body).toEqual(
        invalidInput.body,
      );

      const inputCrashId = "pre-admission-input-crash-01";
      const inputCrashed = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "inputCrash",
      }, { value: "explode" }, undefined, inputCrashId);
      expect(inputCrashed.status).toBe(500);
      expect(inputCrashed.body).toEqual({ error: "internal error" });
      expect(JSON.stringify(inputCrashed.body)).not.toContain("input-secret@internal");
      expect((await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "inputCrash",
      }, { value: "explode" }, undefined, inputCrashId)).body).toEqual(
        inputCrashed.body,
      );
      expect(await operationReceiptCount(base, database)).toBe(
        receiptsBeforeInputAdmission,
      );

      const item = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "create",
      }, { title: "Field codec" });
      expect(item.status).toBe(200);

      const invalidField = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "fieldCodec",
      }, { kind: "invalid" }, item.body.result.id);
      expect(invalidField.status).toBe(400);
      expect(invalidField.body).toMatchObject({
        error: "invalid request",
        receipt: { status: "rejected" },
      });

      const fieldCrashed = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "fieldCodec",
      }, { kind: "crash" }, item.body.result.id);
      expect(fieldCrashed.status).toBe(500);
      expect(fieldCrashed.body).toMatchObject({
        error: "internal error",
        code: "invocation_failed",
        receipt: { status: "failed" },
      });
      expect(JSON.stringify(fieldCrashed.body)).not.toContain("field-secret@internal");

      const beforeRefCodec = await testAdmin(base, database, "/query", {
        query: "[:find ?e :where [?e :nativeItem/title ?title]]",
      });
      expect(beforeRefCodec.status).toBe(200);
      // An entity-reference *input* position still takes the private eid: only
      // the invocation target and client-visible output are opaque today.
      const firstUniqueEid = await openEntityHandle(
        base,
        database,
        token,
        firstUnique.body.result.id as string,
      );
      const invalidRef = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "refFieldCodec",
      }, { kind: "invalid", id: firstUniqueEid }, item.body.result.id);
      expect(invalidRef.status).toBe(400);
      expect(invalidRef.body).toMatchObject({
        error: "invalid request",
        receipt: { status: "rejected" },
      });

      const refCrashed = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "refFieldCodec",
      }, { kind: "crash", id: firstUniqueEid }, item.body.result.id);
      expect(refCrashed.status).toBe(500);
      expect(refCrashed.body).toMatchObject({
        error: "internal error",
        code: "invocation_failed",
        receipt: { status: "failed" },
      });
      expect(JSON.stringify(refCrashed.body)).not.toContain("ref-secret@internal");
      const afterRefCodec = await testAdmin(base, database, "/query", {
        query: "[:find ?e :where [?e :nativeItem/title ?title]]",
      });
      expect(afterRefCodec.status).toBe(200);
      expect(afterRefCodec.body.t).toBe(beforeRefCodec.body.t);

      const domainRejectionInvocationId = "post-claim-domain-rejection-01";
      const rejected = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "reject",
      }, {}, undefined, domainRejectionInvocationId);
      expect(rejected.status).toBe(409);
      expect(rejected.body).toEqual({
        error: "domain refused",
        tag: "OperationRejected",
        message: "domain refused",
        operation: "nativeItem/reject",
        step: "rule",
        reason: "intentional",
        receipt: {
          version: 2,
          invocationId: expect.any(String),
          status: "rejected",
        },
      });
      const rejectedReplay = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "reject",
      }, {}, undefined, domainRejectionInvocationId);
      expect(rejectedReplay).toMatchObject({
        status: rejected.status,
        body: rejected.body,
      });

      const receiptsBeforeCatalogAdmission = await operationReceiptCount(
        base,
        database,
      );
      const staleInvocationId = "pre-admission-stale-catalog-01";
      const staleRequest = () => json(base, `/db/${database}/op`, {
        method: "POST",
        token,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...operationProof,
          invocationId: staleInvocationId,
          unitHash: "0".repeat(64),
          operation: {
            owner: { kind: "entity", name: "nativeItem" },
            localName: "create",
          },
          input: { title: "stale" },
        }),
      });
      const stale = await staleRequest();
      const staleRetry = await staleRequest();
      const missingOperation = await invoke(base, database, token, {
        owner: { kind: "entity", name: "nativeItem" },
        localName: "missing",
      }, {});
      expect(stale.status).toBe(403);
      expect(staleRetry).toMatchObject({
        status: stale.status,
        body: stale.body,
      });
      expect(missingOperation.status).toBe(403);
      expect(withoutReceipt(stale.body)).toEqual(
        withoutReceipt(missingOperation.body),
      );
      expect(await operationReceiptCount(base, database)).toBe(
        receiptsBeforeCatalogAdmission,
      );
    });

    test("a queued invocation minted by another deployment stays executable and replays", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-version-compatibility";
      await install(base, database);
      const token = await signToken(database, "member", "user_version_ok");
      const versions = await otherDeploymentVersions();
      const createVersion = versions.get("nativeItem/create")!;
      expect(createVersion).toMatch(/^[0-9a-f]{64}$/);
      // The replica proves the value is a pure function of the operation's own
      // public contract, independent of the rest of the catalog.
      expect(await createVersionAtRevision(1)).toBe(createVersion);

      const operation = {
        owner: { kind: "entity" as const, name: "nativeItem" },
        localName: "create",
      };
      const invocationId = "version-compatible-invocation-01";
      const executed = await invoke(
        base,
        database,
        token,
        operation,
        { title: "Queued elsewhere" },
        undefined,
        invocationId,
        createVersion,
      );
      expect(executed.status).toBe(200);
      expect(executed.body.receipt).toEqual({
        version: 2,
        invocationId,
        status: "completed",
      });

      // A new isolate plus the other deployment's version must still replay
      // the original receipt rather than conflict or re-execute.
      const aborted = await testAdmin(base, database, "/abort", {
        target: "transactor",
      });
      expect(aborted.status).toBe(200);
      const replayed = await invoke(
        base,
        database,
        token,
        operation,
        { title: "Queued elsewhere" },
        undefined,
        invocationId,
        createVersion,
      );
      expect(replayed.status).toBe(200);
      expect(replayed.body).toEqual(executed.body);
      const rows = await testAdmin(base, database, "/query", {
        query: '[:find ?e :where [?e :nativeItem/title "Queued elsewhere"]]',
      });
      expect(rows.body.result.length).toBe(1);
    });

    test("an invocation pinned to a changed operation is refused without any effect", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-version-changed";
      await install(base, database);
      const token = await signToken(database, "member", "user_version_changed");
      const versions = await otherDeploymentVersions();
      const bumped = await createVersionAtRevision(2);
      expect(bumped).not.toBe(versions.get("nativeItem/create"));
      const receiptsBefore = await operationReceiptCount(base, database);
      const operation = {
        owner: { kind: "entity" as const, name: "nativeItem" },
        localName: "create",
      };

      // A revision bump and another operation's version are both "not this
      // operation any more"; neither may execute or leave a receipt.
      for (const stale of [bumped, versions.get("nativeItem/rename")!]) {
        const refused = await invoke(
          base,
          database,
          token,
          operation,
          { title: "Must not execute" },
          undefined,
          crypto.randomUUID(),
          stale,
        );
        expect(refused.status).toBe(409);
        expect(refused.body).toEqual({
          error: "request rejected",
          code: "operation_changed",
        });
      }
      const malformed = await invoke(
        base,
        database,
        token,
        operation,
        { title: "Must not execute" },
        undefined,
        crypto.randomUUID(),
        "not-a-version",
      );
      expect(malformed.status).toBe(400);

      // Unauthorized callers keep the ordinary sealed denial: a stale version
      // never reveals that the operation exists.
      const reader = await signToken(database, "reader", "user_version_reader");
      const denied = await invoke(
        base,
        database,
        reader,
        operation,
        { title: "Must not execute" },
        undefined,
        crypto.randomUUID(),
        bumped,
      );
      expect(denied.status).toBe(403);

      const absent = await testAdmin(base, database, "/query", {
        query: '[:find ?e :where [?e :nativeItem/title "Must not execute"]]',
      });
      expect(absent.body.result).toEqual([]);
      expect(await operationReceiptCount(base, database)).toBe(receiptsBefore);
    });

    test("a pinned target-mode change is a changed operation, not a denial", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-version-shape";
      await install(base, database);
      const token = await signToken(database, "member", "user_version_shape");
      const targeted = await targetedCreateVersion();
      const receiptsBefore = await operationReceiptCount(base, database);
      const operation = {
        owner: { kind: "entity" as const, name: "nativeItem" },
        localName: "create",
      };

      // The queued request carries the old targeted shape: a target the
      // deployed targetless operation would refuse outright. Compatibility is
      // decided before that current-shape check, so an authorized caller
      // learns the operation moved instead of seeing a 403.
      const refused = await invoke(
        base,
        database,
        token,
        operation,
        { title: "Must not execute" },
        1000,
        crypto.randomUUID(),
        targeted,
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({
        error: "request rejected",
        code: "operation_changed",
      });
      const absent = await testAdmin(base, database, "/query", {
        query: '[:find ?e :where [?e :nativeItem/title "Must not execute"]]',
      });
      expect(absent.body.result).toEqual([]);
      expect(await operationReceiptCount(base, database)).toBe(receiptsBefore);
    });

    test("a stale pin refuses a completed invocation without disturbing its replay", async () => {
      const base = ctx.urls().nativeOperationsUrl;
      const database = "operations-version-pinned-replay";
      await install(base, database);
      const token = await signToken(database, "member", "user_version_pinned");
      const operation = {
        owner: { kind: "entity" as const, name: "nativeItem" },
        localName: "create",
      };
      const invocationId = "pinned-replay-invocation-01";
      const input = { title: "Pinned replay" };
      const completed = await invoke(
        base,
        database,
        token,
        operation,
        input,
        undefined,
        invocationId,
      );
      expect(completed.status).toBe(200);

      // Retrying the same invocation while pinning a version the caller never
      // consented to must not hand back a result minted under another one.
      const pinned = await invoke(
        base,
        database,
        token,
        operation,
        input,
        undefined,
        invocationId,
        await createVersionAtRevision(2),
      );
      expect(pinned.status).toBe(409);
      expect(pinned.body).toEqual({
        error: "request rejected",
        code: "operation_changed",
      });

      // The receipt is untouched: the ordinary retry still replays exactly.
      const replayed = await invoke(
        base,
        database,
        token,
        operation,
        input,
        undefined,
        invocationId,
      );
      expect(replayed.status).toBe(200);
      expect(replayed.body).toEqual(completed.body);
      const rows = await testAdmin(base, database, "/query", {
        query: '[:find ?e :where [?e :nativeItem/title "Pinned replay"]]',
      });
      expect(rows.body.result.length).toBe(1);
    });

    describe("opaque targets and exact allocation mappings", () => {
      const createItem = {
        owner: { kind: "entity" as const, name: "nativeItem" },
        localName: "createAllocating",
      };
      const renameItem = {
        owner: { kind: "entity" as const, name: "nativeItem" },
        localName: "rename",
      };

      test("a create with slots returns exact sealed mappings, and an exact replay returns the identical ones", async () => {
        const base = ctx.urls().nativeOperationsUrl;
        const database = "operations-allocation-mappings";
        await install(base, database);
        const token = await signToken(database, "member", "user_allocations");
        const ref = clientRef();
        const invocationId = "allocation-invocation-01";
        const body = {
          invocationId,
          operation: createItem,
          input: { title: "Allocated" },
          allocations: [{ slot: "item", clientRef: ref }],
        };

        const created = await invokeWith(base, database, token, body);
        expect(created.status).toBe(200);
        expect(created.body.mappings).toEqual([
          { clientRef: ref, entityId: expect.any(String) },
        ]);
        const entityId = created.body.mappings[0].entityId as string;
        // A sealed handle, never a numeric eid, and never the slot name.
        expect(isEntityId(entityId)).toBe(true);
        expect(JSON.stringify(created.body.mappings)).not.toContain("item");
        // One entity is one handle: the mapping and the sealed output position
        // that named the same allocated entity are byte-identical (#475).
        expect(created.body.result.id).toBe(entityId);
        // And the frozen rule itself, checked against the private eid the real
        // resolver hands back: no numeric eid crosses the operation boundary.
        const allocatedEid = await openEntityHandle(
          base,
          database,
          token,
          entityId,
        );
        expect(JSON.stringify(created.body)).not.toContain(String(allocatedEid));

        const receiptsBefore = await operationReceiptCount(base, database);
        // The lost-acknowledgement retry: #487's exact replay, extended with
        // the same mappings and no second commit.
        const replayed = await invokeWith(base, database, token, body);
        expect(replayed.status).toBe(200);
        expect(replayed.body).toEqual(created.body);
        expect(await operationReceiptCount(base, database)).toBe(receiptsBefore);
        const rows = await testAdmin(base, database, "/query", {
          query: '[:find ?e :where [?e :nativeItem/title "Allocated"]]',
        });
        expect(rows.body.result.length).toBe(1);

        // Reusing the id while promising the slot to a *different* durable
        // client identity is the ordinary invocation conflict, not a silent
        // rebinding of a client ref to a different entity.
        const rebound = await invokeWith(base, database, token, {
          ...body,
          allocations: [{ slot: "item", clientRef: clientRef() }],
        });
        expect(rebound.status).toBe(409);
        expect(rebound.body).toEqual({
          error: "request rejected",
          code: "invocation_conflict",
        });
        expect(await operationReceiptCount(base, database)).toBe(receiptsBefore);
      });

      test("a sealed target resolves, and admission is rerun against the resolved entity", async () => {
        const base = ctx.urls().nativeOperationsUrl;
        const database = "operations-sealed-target";
        await install(base, database);
        const token = await signToken(database, "member", "user_sealed_target");
        const created = await invokeWith(base, database, token, {
          invocationId: "sealed-target-create-01",
          operation: createItem,
          input: { title: "Sealed" },
          allocations: [{ slot: "item", clientRef: clientRef() }],
        });
        expect(created.status).toBe(200);
        const entityId = created.body.mappings[0].entityId as string;

        const renamed = await invokeWith(base, database, token, {
          invocationId: "sealed-target-rename-01",
          operation: renameItem,
          target: entityId,
          input: { title: "Renamed through a sealed handle" },
        });
        expect(renamed.status).toBe(200);
        expect(renamed.body.result.title).toBe("Renamed through a sealed handle");

        // Resolution grants nothing. Once the entity is gone, the same handle
        // still opens deterministically and ordinary target visibility refuses
        // exactly as it would for the numeric eid.
        const deleted = await invokeWith(base, database, token, {
          invocationId: "sealed-target-delete-01",
          operation: {
            owner: { kind: "entity" as const, name: "nativeItem" },
            localName: "deleteAndEchoTitle",
          },
          target: entityId,
          input: {},
        });
        expect(deleted.status).toBe(200);
        const afterDelete = await invokeWith(base, database, token, {
          invocationId: "sealed-target-rename-02",
          operation: renameItem,
          target: entityId,
          input: { title: "Should never land" },
        });
        expect(afterDelete.status).toBe(403);

        // Malformed, tampered, and foreign handles are all the same sealed
        // denial — a truncated or non-canonical handle must be
        // indistinguishable from a wrong-scope or unauthorized one, so none of
        // them may come back as a shape complaint.
        const tampered = `${entityId.slice(0, 30)}${entityId[30] === "A" ? "B" : "A"}${entityId.slice(31)}`;
        for (const [label, target] of [
          ["tampered", tampered],
          ["truncated", entityId.slice(0, 40)],
          ["non-base64url", `${"!".repeat(54)}A`],
          ["empty", ""],
        ] as const) {
          const forged = await invokeWith(base, database, token, {
            invocationId: `sealed-target-forged-${label}`,
            operation: renameItem,
            target,
            input: { title: "Should never land" },
          });
          expect([label, forged.status]).toEqual([label, 403]);
        }
      });

      test("a target the caller may not read fails sealed even though its handle resolves", async () => {
        const base = ctx.urls().nativeOperationsUrl;
        const database = "operations-sealed-hidden";
        await install(base, database);
        // `nativeOther` is readable by `reader` only, while both operations
        // below are invocable by `member`: the member mints a handle it can
        // never target, so resolution succeeding is not visibility.
        const token = await signToken(database, "member", "user_sealed_hidden");
        const created = await invokeWith(base, database, token, {
          invocationId: "sealed-hidden-create-01",
          operation: {
            owner: { kind: "entity" as const, name: "nativeOther" },
            localName: "createAllocating",
          },
          input: { name: "hidden-other" },
          allocations: [{ slot: "other", clientRef: clientRef() }],
        });
        expect(created.status).toBe(200);
        const entityId = created.body.mappings[0].entityId as string;

        const renamed = await invokeWith(base, database, token, {
          invocationId: "sealed-hidden-rename-01",
          operation: {
            owner: { kind: "entity" as const, name: "nativeOther" },
            localName: "rename",
          },
          target: entityId,
          input: { name: "should-never-land" },
        });
        expect(renamed.status).toBe(403);
        const rows = await testAdmin(base, database, "/query", {
          query: '[:find ?e :where [?e :nativeOther/name "should-never-land"]]',
        });
        expect(rows.body.result).toEqual([]);
      });

      test("an unreadable codec version or key epoch quarantines data-free", async () => {
        const base = ctx.urls().nativeOperationsUrl;
        const database = "operations-sealed-quarantine";
        await install(base, database);
        const token = await signToken(database, "member", "user_sealed_quarantine");
        const receiptsBefore = await operationReceiptCount(base, database);
        for (const kind of ["codec-version", "key-epoch"] as const) {
          const quarantined = await invokeWith(base, database, token, {
            invocationId: `sealed-quarantine-${kind}`,
            operation: renameItem,
            target: unreadableEntityId(kind),
            input: { title: "Should never land" },
          });
          expect(quarantined.status).toBe(409);
          expect(quarantined.body).toEqual({
            error: "request rejected",
            code: "invocation_update_required",
          });
        }
        // Data-free and effect-free: nothing was claimed, nothing executed.
        expect(await operationReceiptCount(base, database)).toBe(receiptsBefore);
      });

      test("a cold Worker isolate re-derives the same epoch and scope", async () => {
        const base = ctx.urls().nativeOperationsUrl;
        const database = "operations-sealed-cold";
        await install(base, database);
        const token = await signToken(database, "member", "user_sealed_cold");

        // The Worker derives the scope from its cached root and the writer
        // seals from its own; the two caches are independent. Discarding the
        // Worker's forces a fresh derivation against the same durable root,
        // which is the seam the epoch rule exists to keep coherent — if the
        // carried key id and the writer's disagreed, this would quarantine
        // rather than commit.
        const forget = await testAdmin(base, database, "/server-identity", {
          action: "forget-isolate-cache",
        });
        expect(forget.status).toBe(200);

        const created = await invokeWith(base, database, token, {
          invocationId: "sealed-cold-create-01",
          operation: createItem,
          input: { title: "Cold isolate" },
          allocations: [{ slot: "item", clientRef: clientRef() }],
        });
        expect(created.status).toBe(200);
        const entityId = created.body.mappings[0].entityId as string;
        expect(isEntityId(entityId)).toBe(true);

        // Cold again, then use the handle the previous (equally cold)
        // derivation produced: it resolves under the scope this fresh
        // derivation computes, which is the whole point of binding the two.
        await testAdmin(base, database, "/server-identity", {
          action: "forget-isolate-cache",
        });
        const renamed = await invokeWith(base, database, token, {
          invocationId: "sealed-cold-rename-01",
          operation: renameItem,
          target: entityId,
          input: { title: "Renamed after a cold derivation" },
        });
        expect(renamed.status).toBe(200);

        // And the exact replay across another cold derivation is byte-identical:
        // sealing is deterministic in (root, scope, eid), so a restarted isolate
        // reproduces the same handle rather than minting a second identity.
        await testAdmin(base, database, "/server-identity", {
          action: "forget-isolate-cache",
        });
        const replayed = await invokeWith(base, database, token, {
          invocationId: "sealed-cold-create-01",
          operation: createItem,
          input: { title: "Cold isolate" },
          allocations: created.body.mappings.map((mapping: {
            readonly clientRef: string;
          }) => ({ slot: "item", clientRef: mapping.clientRef })),
        });
        expect(replayed.status).toBe(200);
        expect(replayed.body.mappings).toEqual(created.body.mappings);
      });

      test("a slot bound to an entity the commit did not allocate is refused", async () => {
        const base = ctx.urls().nativeOperationsUrl;
        const database = "operations-allocation-misbound";
        await install(base, database);
        const token = await signToken(database, "member", "user_misallocating");
        const created = await invokeWith(base, database, token, {
          invocationId: "allocation-misbound-create-01",
          operation: createItem,
          input: { title: "Pre-existing" },
          allocations: [{ slot: "item", clientRef: clientRef() }],
        });
        expect(created.status).toBe(200);

        // `misallocating` returns `op.self` at its declared slot path. The
        // entity is real and visible, and the path is a genuine ref position —
        // it simply is not one this transaction allocated, so the client would
        // otherwise bind a fresh, immutable ClientRef to a pre-existing row.
        const refused = await invokeWith(base, database, token, {
          invocationId: "allocation-misbound-01",
          operation: {
            owner: { kind: "entity" as const, name: "nativeItem" },
            localName: "misallocating",
          },
          target: created.body.mappings[0].entityId,
          input: { title: "Should never land" },
          allocations: [{ slot: "item", clientRef: clientRef() }],
        });
        expect(refused.status).toBe(409);
        expect(refused.body.tag).toBe("OperationRejected");
        // Refused before the commit: the write the body attempted is absent.
        const rows = await testAdmin(base, database, "/query", {
          query: '[:find ?e :where [?e :nativeItem/title "Should never land"]]',
        });
        expect(rows.body.result).toEqual([]);
      });

      const retitleByRef = {
        owner: { kind: "entity" as const, name: "nativeItem" },
        localName: "retitleByRef",
      };

      test("a sealed handle at a declared input position commits, and the same invocation replays exactly", async () => {
        const base = ctx.urls().nativeOperationsUrl;
        const database = "operations-sealed-input";
        await install(base, database);
        const token = await signToken(database, "member", "user_sealed_input");
        const created = await invokeWith(base, database, token, {
          invocationId: "sealed-input-create-01",
          operation: createItem,
          input: { title: "Dependency" },
          allocations: [{ slot: "item", clientRef: clientRef() }],
        });
        expect(created.status).toBe(200);
        const entityId = created.body.mappings[0].entityId as string;
        expect(isEntityId(entityId)).toBe(true);

        // The dependent invocation: no target at all, the entity named only by
        // its sealed handle at the declared `item` ref position — and the same
        // handle repeated at `note`, which the deployed input shape declares a
        // plain string.
        const body = {
          invocationId: "sealed-input-retitle-01",
          operation: retitleByRef,
          input: {
            item: entityId,
            title: "Retitled through an input handle",
            note: entityId,
          },
        };
        const retitled = await invokeWith(base, database, token, body);
        expect(retitled.status).toBe(200);
        // An undeclared position is data: the handle was never opened, so it
        // comes back exactly as it was submitted.
        expect(retitled.body.result).toEqual({
          title: "Retitled through an input handle",
          note: entityId,
        });

        // It committed against the entity the handle named, and only it.
        const rows = await testAdmin(base, database, "/query", {
          query:
            '[:find ?e :where [?e :nativeItem/title "Retitled through an input handle"]]',
        });
        expect(rows.body.result.length).toBe(1);
        const stale = await testAdmin(base, database, "/query", {
          query: '[:find ?e :where [?e :nativeItem/title "Dependency"]]',
        });
        expect(stale.body.result).toEqual([]);

        // A second entity, so the conflict below names a different one.
        const other = await invokeWith(base, database, token, {
          invocationId: "sealed-input-create-02",
          operation: createItem,
          input: { title: "Other dependency" },
          allocations: [{ slot: "item", clientRef: clientRef() }],
        });
        expect(other.status).toBe(200);

        // The lost-acknowledgement retry. The canonical digest covers the
        // *resolved* eid, and resolution is deterministic, so the identical
        // sealed input reproduces the digest and consumes #487's exact replay
        // rather than committing again.
        const receiptsBefore = await operationReceiptCount(base, database);
        const replayed = await invokeWith(base, database, token, body);
        expect(replayed.status).toBe(200);
        expect(replayed.body).toEqual(retitled.body);
        expect(await operationReceiptCount(base, database)).toBe(receiptsBefore);

        // Reusing the id with a different entity at the same input position is
        // a different invocation, and the conflict proves the input ref really
        // is inside the digest.
        const rebound = await invokeWith(base, database, token, {
          ...body,
          input: { ...body.input, item: other.body.mappings[0].entityId },
        });
        expect(rebound.status).toBe(409);
        expect(rebound.body).toEqual({
          error: "request rejected",
          code: "invocation_conflict",
        });
        expect(await operationReceiptCount(base, database)).toBe(receiptsBefore);
      });

      test("input handles carry the target position's exact failure taxonomy", async () => {
        const base = ctx.urls().nativeOperationsUrl;
        const database = "operations-sealed-input-taxonomy";
        await install(base, database);
        const token = await signToken(database, "member", "user_sealed_input_tax");
        const created = await invokeWith(base, database, token, {
          invocationId: "sealed-input-tax-create-01",
          operation: createItem,
          input: { title: "Taxonomy" },
          allocations: [{ slot: "item", clientRef: clientRef() }],
        });
        expect(created.status).toBe(200);
        const entityId = created.body.mappings[0].entityId as string;
        const receiptsBefore = await operationReceiptCount(base, database);

        // An unreadable codec version or a replaced key epoch is the typed,
        // data-free quarantine — decided from the envelope preamble, exactly as
        // it is for a target.
        for (const kind of ["codec-version", "key-epoch"] as const) {
          const quarantined = await invokeWith(base, database, token, {
            invocationId: `sealed-input-tax-${kind}`,
            operation: retitleByRef,
            input: {
              item: unreadableEntityId(kind),
              title: "Should never land",
              note: "",
            },
          });
          expect([kind, quarantined.status]).toEqual([kind, 409]);
          expect(quarantined.body).toEqual({
            error: "request rejected",
            code: "invocation_update_required",
          });
        }

        // Everything else collapses into the ordinary sealed denial. A string
        // no codec could have minted is that same denial, not a shape
        // complaint and not a quarantine.
        const tampered =
          `${entityId.slice(0, 30)}${entityId[30] === "A" ? "B" : "A"}${entityId.slice(31)}`;
        for (const [label, handle] of [
          ["tampered", tampered],
          ["truncated", entityId.slice(0, 40)],
          ["non-base64url", `${"!".repeat(54)}A`],
          ["far too short", "nope"],
          ["empty", ""],
        ] as const) {
          const forged = await invokeWith(base, database, token, {
            invocationId: `sealed-input-tax-forged-${label}`,
            operation: retitleByRef,
            input: { item: handle, title: "Should never land", note: "" },
          });
          expect([label, forged.status]).toEqual([label, 403]);
        }

        // Resolution grants nothing, and the ordinary entity-type check reruns
        // against the resolved eid: a `nativeItem` handle at a position
        // declared `Ref(nativeOther)` is refused exactly as the numeric eid
        // would be.
        const mistyped = await invokeWith(base, database, token, {
          invocationId: "sealed-input-tax-mistyped",
          operation: {
            owner: { kind: "entity" as const, name: "nativeItem" },
            localName: "deleteHiddenOther",
          },
          input: { id: entityId },
        });
        expect(mistyped.status).toBe(400);

        // Effect-free throughout: nothing was claimed and nothing executed.
        expect(await operationReceiptCount(base, database)).toBe(receiptsBefore);
        const rows = await testAdmin(base, database, "/query", {
          query: '[:find ?e :where [?e :nativeItem/title "Should never land"]]',
        });
        expect(rows.body.result).toEqual([]);
      });

      test("an undeclared slot is refused before the operation body runs", async () => {
        const base = ctx.urls().nativeOperationsUrl;
        const database = "operations-allocation-undeclared";
        await install(base, database);
        const token = await signToken(database, "member", "user_undeclared_slot");
        const refused = await invokeWith(base, database, token, {
          invocationId: "allocation-undeclared-01",
          operation: createItem,
          input: { title: "Undeclared" },
          allocations: [{ slot: "nothingDeclaresThis", clientRef: clientRef() }],
        });
        expect(refused.status).toBe(400);
        const rows = await testAdmin(base, database, "/query", {
          query: '[:find ?e :where [?e :nativeItem/title "Undeclared"]]',
        });
        expect(rows.body.result).toEqual([]);
      });
    });

    /**
     * The offline client's own submission path, end to end.
     *
     * The record is a real durable outbox row, built by the same canonical
     * builder the browser queue writes through; the request is the one
     * `buildMutationRequest` produces; the transport is the real `submitMutation`
     * over `fetch`; and the answers are the real deployed Worker's. Nothing is
     * scripted, so the classification table is proven against the responses the
     * server actually sends rather than against an imagined vocabulary.
     */
    describe("offline client submission through the real transport", () => {
      const RECEIVER = Object.freeze({
        server: "s".repeat(43),
        principal: "p".repeat(43),
        database: "d".repeat(43),
      });

      const endpointFor = (base: string, database: string, token: string) =>
        Object.freeze({
          origin: new URL(base).origin,
          database,
          graphPath: [] as readonly string[],
          credential: token,
          catalog: operationProof.catalog,
          unitHash: operationProof.unitHash,
        });

      const queued = (
        version: string,
        overrides: Partial<OutboxDraft> = {},
      ): OutboxRecord =>
        buildOutboxRecord({
          invocation: invocationId(),
          receiver: RECEIVER,
          operation: {
            catalog: operationProof.catalog as never,
            owner: { kind: "entity", name: "nativeItem" },
            localName: "createAllocating",
          },
          operationVersion: version as never,
          target: { type: "none" },
          input: { title: "Queued offline" },
          allocations: [],
          inputRefs: [],
          enqueuedAt: 1_700_000_000_000,
          ...overrides,
        }, "scope", 1);

      /**
       * The classification, and the raw answer it came from.
       *
       * The raw answer is kept so an unexpected classification names the status
       * and body the server actually sent. A bare "expected Committed, received
       * Retry" says nothing about which 5xx produced it, and a `/op` answer this
       * contract did not anticipate is exactly the thing worth seeing.
       */
      const submitRaw = async (
        record: OutboxRecord,
        endpoint: ReturnType<typeof endpointFor>,
        handles: ReadonlyMap<string, EntityId> = new Map(),
      ) => {
        const substituted = substituteMutationRefs(record, handles);
        expect(substituted).toBeDefined();
        const response = await submitMutation(
          buildMutationRequest(record, endpoint, substituted!),
        );
        return {
          acknowledgement: classifyMutationResponse(record, response),
          raw: JSON.stringify(response),
        };
      };

      const submit = async (
        record: OutboxRecord,
        endpoint: ReturnType<typeof endpointFor>,
        handles: ReadonlyMap<string, EntityId> = new Map(),
      ) => (await submitRaw(record, endpoint, handles)).acknowledgement;

      /**
       * Submit until the queue reaches an answer it would act on.
       *
       * `Retry` is *defined* as non-terminal: the record stays queued and the
       * driver asks again. A test that demanded a terminal answer from the
       * first attempt would be asserting something stronger than the contract,
       * and would fail on any transient the contract already covers — a
       * momentarily unreachable sealing root, a restarting Durable Object. What
       * the contract does promise is that the answer eventually reached is
       * exact and idempotent, which is what the callers below assert.
       */
      const submitUntilTerminal = async (
        record: OutboxRecord,
        endpoint: ReturnType<typeof endpointFor>,
        handles: ReadonlyMap<string, EntityId> = new Map(),
      ) => {
        const seen: string[] = [];
        for (let attempt = 0; attempt < 5; attempt++) {
          const result = await submitRaw(record, endpoint, handles);
          seen.push(result.raw);
          if (result.acknowledgement._tag !== "Retry") {
            return { ...result, seen: seen.join(" | ") };
          }
          await Bun.sleep(100);
        }
        throw new Error(`submission never left Retry: ${seen.join(" | ")}`);
      };

      test("a queued create commits, and the lost-ack retry returns the identical mappings", async () => {
        const base = ctx.urls().nativeOperationsUrl;
        const database = "operations-client-submission";
        await install(base, database);
        const token = await signToken(database, "member", "user_client_submit");
        const endpoint = endpointFor(base, database, token);
        const version = (await otherDeploymentVersions())
          .get("nativeItem/createAllocating")!;
        const ref = clientRef();
        const record = queued(version, {
          allocations: [{ slot: "item", clientRef: ref }],
        });

        const first = await submitUntilTerminal(record, endpoint);
        const committed = first.acknowledgement;
        expect([first.seen, committed._tag]).toEqual([first.seen, "Committed"]);
        if (committed._tag !== "Committed") throw new Error("expected a commit");
        expect(committed.mappings).toHaveLength(1);
        expect(committed.mappings[0]!.clientRef).toBe(ref);
        expect(isEntityId(committed.mappings[0]!.entityId)).toBe(true);

        const receiptsBefore = await operationReceiptCount(base, database);
        // The acknowledgement this client never received: resubmitting the same
        // durable row consumes #487's exact replay. However many times it takes
        // to get an answer, the answer is byte-identical and commits nothing
        // further — that idempotence is the whole contract.
        const replayed = await submitUntilTerminal(record, endpoint);
        expect([replayed.seen, replayed.acknowledgement])
          .toEqual([replayed.seen, committed]);
        expect(await operationReceiptCount(base, database)).toBe(receiptsBefore);
        const rows = await testAdmin(base, database, "/query", {
          query: '[:find ?e :where [?e :nativeItem/title "Queued offline"]]',
        });
        expect(rows.body.result.length).toBe(1);

        // A dependent record submits the sealed handle in place of the ref,
        // exactly as the queue would once the mapping is durable.
        const dependent = buildOutboxRecord({
          invocation: invocationId(),
          receiver: RECEIVER,
          operation: {
            catalog: operationProof.catalog as never,
            owner: { kind: "entity", name: "nativeItem" },
            localName: "rename",
          },
          operationVersion: (await otherDeploymentVersions())
            .get("nativeItem/rename")! as never,
          target: { type: "client-ref", clientRef: ref },
          input: { title: "Renamed through the queue" },
          allocations: [],
          inputRefs: [],
          enqueuedAt: 1_700_000_000_001,
        }, "scope", 2);
        expect(substituteMutationRefs(dependent, new Map())).toBeUndefined();
        const renamed = await submitUntilTerminal(
          dependent,
          endpoint,
          new Map([[
            mappingKey(dependent.partition, ref),
            committed.mappings[0]!.entityId as EntityId,
          ]]),
        );
        expect([renamed.seen, renamed.acknowledgement]).toMatchObject([
          renamed.seen,
          { _tag: "Committed", output: { title: "Renamed through the queue" } },
        ]);
      });


      /**
       * Acceptance: an offline create followed by a dependent invocation that
       * refers to its `ClientRef` at a *declared input position* (#475 WR-17).
       *
       * Both records are durable before either is submitted, and the dependent
       * one holds the client ref itself — no mapping exists yet. Reconnecting
       * submits the create, the exact mapping unblocks the dependent record,
       * and the sealed handle the queue substitutes is what the authoritative
       * edge opens. Each commits exactly once even though both are submitted
       * twice, and no raw eid appears anywhere.
       */
      test("a dependent invocation resolves its ClientRef into a sealed input handle", async () => {
        const base = ctx.urls().nativeOperationsUrl;
        const database = "operations-client-input-refs";
        await install(base, database);
        const token = await signToken(database, "member", "user_client_input_refs");
        const endpoint = endpointFor(base, database, token);
        const versions = await otherDeploymentVersions();
        const ref = clientRef();
        const create = queued(versions.get("nativeItem/createAllocating")!, {
          input: { title: "Created offline" },
          allocations: [{ slot: "item", clientRef: ref }],
        });
        const dependent = buildOutboxRecord({
          invocation: invocationId(),
          receiver: RECEIVER,
          operation: {
            catalog: operationProof.catalog as never,
            owner: { kind: "entity", name: "nativeItem" },
            localName: "retitleByRef",
          },
          operationVersion: versions.get("nativeItem/retitleByRef")! as never,
          target: { type: "none" },
          input: { item: ref, title: "Retitled offline", note: "plain" },
          allocations: [],
          inputRefs: [{ path: ["item"], ref }],
          enqueuedAt: 1_700_000_000_010,
        }, "scope", 2);
        // Blocked while the dependency is unmapped: the queue never submits a
        // client ref as if it were an entity.
        expect(substituteMutationRefs(dependent, new Map())).toBeUndefined();

        const first = await submitUntilTerminal(create, endpoint);
        const committed = first.acknowledgement;
        expect([first.seen, committed._tag]).toEqual([first.seen, "Committed"]);
        if (committed._tag !== "Committed") throw new Error("expected a commit");
        expect(committed.mappings).toHaveLength(1);
        const handles = new Map([[
          mappingKey(dependent.partition, ref),
          committed.mappings[0]!.entityId as EntityId,
        ]]);

        const done = await submitUntilTerminal(dependent, endpoint, handles);
        expect([done.seen, done.acknowledgement]).toMatchObject([
          done.seen,
          {
            _tag: "Committed",
            output: { title: "Retitled offline", note: "plain" },
          },
        ]);

        // Exactly once, both of them, however many acknowledgements were lost.
        const receiptsBefore = await operationReceiptCount(base, database);
        expect((await submitUntilTerminal(create, endpoint)).acknowledgement)
          .toEqual(committed);
        expect(
          (await submitUntilTerminal(dependent, endpoint, handles)).acknowledgement,
        ).toEqual(done.acknowledgement);
        expect(await operationReceiptCount(base, database)).toBe(receiptsBefore);
        const rows = await testAdmin(base, database, "/query", {
          query: '[:find ?e :where [?e :nativeItem/title "Retitled offline"]]',
        });
        expect(rows.body.result.length).toBe(1);
        const stale = await testAdmin(base, database, "/query", {
          query: '[:find ?e :where [?e :nativeItem/title "Created offline"]]',
        });
        expect(stale.body.result).toEqual([]);
      });

      test("every non-terminal and terminal answer classifies from the real Worker", async () => {
        const base = ctx.urls().nativeOperationsUrl;
        const database = "operations-client-answers";
        await install(base, database);
        const token = await signToken(database, "member", "user_client_answers");
        const endpoint = endpointFor(base, database, token);
        const versions = await otherDeploymentVersions();
        const version = versions.get("nativeItem/createAllocating")!;
        const ref = clientRef();
        const record = queued(version, {
          allocations: [{ slot: "item", clientRef: ref }],
        });
        expect((await submitUntilTerminal(record, endpoint)).acknowledgement._tag).toBe("Committed");

        // Same id, a different durable client identity for the slot.
        const rebound = buildOutboxRecord({
          invocation: record.invocation,
          receiver: RECEIVER,
          operation: record.operation,
          operationVersion: record.operationVersion,
          target: { type: "none" },
          input: record.input,
          allocations: [{ slot: "item", clientRef: clientRef() }],
          inputRefs: [],
          enqueuedAt: 1_700_000_000_002,
        }, "scope", 1);
        expect((await submitUntilTerminal(rebound, endpoint)).acknowledgement)
          .toEqual({ _tag: "Rejected", code: "invocation_conflict" });

        // A queued invocation pinned to a contract the deployment has moved
        // past: non-terminal, typed, and never a silent drop.
        const stale = queued(versions.get("nativeItem/create")!, {
          allocations: [{ slot: "item", clientRef: clientRef() }],
        });
        expect((await submitUntilTerminal(stale, endpoint)).acknowledgement)
          .toEqual({ _tag: "UpdateRequired", reason: "operation-changed" });

        // An unreadable sealing epoch reaches the same non-terminal state
        // through a different code, and still commits nothing.
        const quarantined = buildOutboxRecord({
          invocation: invocationId(),
          receiver: RECEIVER,
          operation: {
            catalog: operationProof.catalog as never,
            owner: { kind: "entity", name: "nativeItem" },
            localName: "rename",
          },
          operationVersion: versions.get("nativeItem/rename")! as never,
          target: {
            type: "entity",
            entityId: unreadableEntityId("key-epoch") as EntityId,
          },
          input: { title: "Should never land" },
          allocations: [],
          inputRefs: [],
          enqueuedAt: 1_700_000_000_003,
        }, "scope", 3);
        expect((await submitUntilTerminal(quarantined, endpoint)).acknowledgement).toEqual({
          _tag: "UpdateRequired",
          reason: "invocation-update-required",
        });

        // A refusal the server bound to a durable receipt is terminal: the
        // operation body refused, after the claim, so replaying returns the
        // same answer forever.
        const refused = buildOutboxRecord({
          invocation: invocationId(),
          receiver: RECEIVER,
          operation: {
            catalog: operationProof.catalog as never,
            owner: { kind: "entity", name: "nativeItem" },
            localName: "reject",
          },
          operationVersion: versions.get("nativeItem/reject")! as never,
          target: { type: "none" },
          input: {},
          allocations: [],
          inputRefs: [],
          enqueuedAt: 1_700_000_000_004,
        }, "scope", 4);
        expect((await submitUntilTerminal(refused, endpoint)).acknowledgement)
          .toEqual({ _tag: "Rejected", code: "operation_rejected" });

        // A refusal the server reached *before* writing any receipt carries
        // none, and must never remove durable work — the same shape the Worker
        // answers when a lease expires between the commit and the response.
        const unproven = await submit(queued(version), {
          ...endpoint,
          credential: await signToken(database, "reader", "user_client_reader"),
        });
        expect(unproven._tag).toBe("Retry");

        // And an unreachable peer is the one answer that must be asked again.
        expect(await submit(queued(version), {
          ...endpoint,
          origin: "http://127.0.0.1:1",
        })).toEqual({ _tag: "Retry", reason: "unreachable" });
      });
    });

  });
};
