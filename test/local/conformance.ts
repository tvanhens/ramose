/**
 * #422 — black-box noninterference through the real Alchemy/workerd stack.
 *
 * This suite owns the broad one-shot/live paired-world cases. The same
 * required gate also retains the narrower cases instead of copying them:
 *
 * - `graph-paths.ts`: derived traits, trait/field rules and nested Graph paths
 * - `native-operations.ts`: trusted native bodies and authoritative writes
 * - `auth.contract.ts`: JWT/JWKS admission and opaque authentication failures
 * - `operations.contract.ts`: minimal public health/metadata surface
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Query } from "ramose/db";
import { lowerQueryObject, schemaTx } from "../../packages/ramose/src/db/internal.ts";
import { signToken } from "../../packages/ramose/test/sign-local-token.ts";
import {
  applyLiveDiffs,
  readLiveNdjson,
  type LiveQueryDiff,
} from "../support/live-query.ts";
import {
  CONFORMANCE_DATABASES,
  ConformanceIssue,
  ConformanceSchema,
  ConformanceUser,
} from "./conformance-catalog.ts";
import {
  conformanceProof,
  loadConformanceProof,
} from "./conformance-proof.ts";
import { json, openStream, testAdmin, type LocalUrls } from "./fixtures.ts";

const TITLES =
  "[:find [?title ...] :where [?e :conformanceIssue/title ?title]]";
const JOIN_OWNER =
  "[:find ?title ?sub :where [?e :conformanceIssue/title ?title] [?e :conformanceIssue/owner ?owner] [?owner :conformanceUser/sub ?sub]]";
const CHILDREN =
  "[:find [?title ...] :in $ ?parent :where [?e :conformanceIssue/parent ?parent] [?e :conformanceIssue/title ?title]]";
const GRAPH =
  "[:find ?child ?parent :where [?c :conformanceIssue/parent ?p] [?c :conformanceIssue/title ?child] [?p :conformanceIssue/title ?parent]]";
const COUNT =
  "[:find (count ?e) . :where [?e :conformanceIssue/title]]";
const NEGATION =
  "[:find [?title ...] :where [?e :conformanceIssue/title ?title] (not [?e :conformanceIssue/audit _])]";
const ORDER_LIMIT = {
  find: [["?title", "..."]],
  where: [["?e", ":conformanceIssue/title", "?title"]],
  order: [["?title"]],
  limit: 2,
};

const typedIssues = lowerQueryObject(
  Query.from(ConformanceIssue).select({
    id: ConformanceIssue.id,
    title: ConformanceIssue.title,
  }),
);

export type OperationAddress = {
  readonly owner: {
    readonly kind: "entity" | "trait";
    readonly name: string;
  };
  readonly localName: string;
};

export type World = {
  readonly database: string;
  readonly member: string;
  readonly admin: string;
  readonly visibleT: number;
  readonly ids: {
    readonly alice: number;
    readonly bob: number;
    readonly parent: number;
    readonly child: number;
    readonly claim: number;
  };
  readonly hiddenId?: number;
};

export const originHeaders = { origin: "https://app.acme.test" };

export const invoke = (
  base: string,
  database: string,
  token: string,
  operation: OperationAddress,
  input: unknown,
  target?: number | readonly [string, unknown],
  invocationId: string = crypto.randomUUID(),
) => json(base, `/db/${database}/op`, {
  method: "POST",
  token,
  headers: { "content-type": "application/json", ...originHeaders },
  body: JSON.stringify({
    ...conformanceProof,
    invocationId,
    operation,
    input,
    ...(target === undefined ? {} : { target }),
  }),
});

const query = (
  base: string,
  database: string,
  token: string | undefined,
  value: unknown,
  options: {
    readonly inputs?: readonly unknown[];
    readonly asOf?: number;
    readonly history?: boolean;
    readonly proof?: { readonly catalog: string; readonly unitHash: string };
  } = {},
) => json(base, `/db/${database}/query`, {
  method: "POST",
  ...(token === undefined ? {} : { token }),
  headers: { "content-type": "application/json", ...originHeaders },
  body: JSON.stringify({
    ...(options.proof ?? conformanceProof),
    query: value,
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
    ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
    ...(options.history === undefined ? {} : { history: options.history }),
  }),
});

const entity = (
  base: string,
  database: string,
  token: string,
  eid: number,
  asOf?: number,
) => json(
  base,
  `/db/${database}/entity/${eid}${asOf === undefined ? "" : `?asOf=${asOf}`}`,
  {
    token,
    headers: {
      "x-ramose-catalog": conformanceProof.catalog,
      "x-ramose-unit-hash": conformanceProof.unitHash,
      ...originHeaders,
    },
  },
);

const pull = (
  base: string,
  database: string,
  token: string,
  eid: number,
  pattern: unknown,
) => json(base, `/db/${database}/pull`, {
  method: "POST",
  token,
  headers: { "content-type": "application/json", ...originHeaders },
  body: JSON.stringify({ ...conformanceProof, eid, pattern }),
});

const lookup = (
  base: string,
  database: string,
  token: string,
  ref: readonly [string, unknown],
) => json(base, `/db/${database}/query`, {
  method: "POST",
  token,
  headers: { "content-type": "application/json", ...originHeaders },
  body: JSON.stringify({ ...conformanceProof, lookup: ref }),
});

export const install = async (base: string, database: string): Promise<void> => {
  const installed = await testAdmin(base, database, "/transact", {
    tx: schemaTx(ConformanceSchema),
  });
  expect(installed.status).toBe(200);
};

export const create = async (
  base: string,
  database: string,
  token: string,
  owner: string,
  input: unknown,
): Promise<number> => {
  const response = await invoke(base, database, token, {
    owner: { kind: "entity", name: owner },
    localName: "create",
  }, input);
  expect(response.status).toBe(200);
  expect(typeof response.body.result.id).toBe("number");
  expect(response.body.receipt).toEqual({
    version: 2,
    invocationId: expect.any(String),
    status: "completed",
  });
  return response.body.result.id as number;
};

export const currentBasis = async (base: string, database: string): Promise<number> => {
  const response = await testAdmin(base, database, "/basis", {
    action: "fetch",
  }, { "x-ramose-cache-basis": "0" });
  expect(response.status).toBe(200);
  return response.body.basis.t as number;
};

export const seedWorld = async (
  base: string,
  database: string,
  includeHidden: boolean,
): Promise<World> => {
  await install(base, database);
  const admin = await signToken(database, "admin", "admin-sub", {
    org: "admin-org",
  });
  const member = await signToken(database, "member", "alice-sub", {
    org: "acme",
  });
  const alice = await create(
    base,
    database,
    admin,
    ConformanceUser.ns,
    { sub: "alice-sub" },
  );
  const bob = await create(
    base,
    database,
    admin,
    ConformanceUser.ns,
    { sub: "bob-sub" },
  );
  const parent = await create(
    base,
    database,
    admin,
    ConformanceIssue.ns,
    {
      key: "parent",
      title: "Beta",
      owner: alice,
      org: "acme",
      audit: "visible-audit-secret",
    },
  );
  const child = await create(
    base,
    database,
    admin,
    ConformanceIssue.ns,
    {
      key: "child",
      title: "Gamma",
      owner: alice,
      org: "acme",
      parent,
    },
  );
  const claim = await create(
    base,
    database,
    admin,
    ConformanceIssue.ns,
    {
      key: "claim",
      title: "Omega",
      owner: bob,
      org: "acme",
    },
  );
  const visibleT = await currentBasis(base, database);
  const hiddenId = includeHidden
    ? await create(
      base,
      database,
      admin,
      ConformanceIssue.ns,
      {
        key: "hidden",
        title: "Alpha-hidden-secret",
        owner: bob,
        org: "other",
        parent,
        audit: "hidden-audit-secret",
      },
    )
    : undefined;
  await currentBasis(base, database);
  return {
    database,
    member,
    admin,
    visibleT,
    ids: { alice, bob, parent, child, claim },
    ...(hiddenId === undefined ? {} : { hiddenId }),
  };
};

/** Complete application-controlled public header vocabulary from #419. */
const PUBLIC_HEADERS = [
  "content-type",
  "cache-control",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "retry-after",
] as const;

const responseObservation = (response: Awaited<ReturnType<typeof json>>) => ({
  status: response.status,
  body: response.body,
  headers: Object.fromEntries(
    PUBLIC_HEADERS.flatMap((name) => {
      const value = response.res.headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  ),
});

const observeWorld = async (base: string, world: World) => {
  const { database, member, ids } = world;
  const responses = {
    titles: await query(base, database, member, TITLES),
    ownerJoin: await query(base, database, member, JOIN_OWNER),
    children: await query(base, database, member, CHILDREN, {
      inputs: [ids.parent],
    }),
    graph: await query(base, database, member, GRAPH),
    count: await query(base, database, member, COUNT),
    negation: await query(base, database, member, NEGATION),
    orderLimit: await query(base, database, member, ORDER_LIMIT),
    typed: await query(base, database, member, typedIssues.query),
    parentPull: await pull(
      base,
      database,
      member,
      ids.parent,
      "[:conformanceIssue/title {:conformanceIssue/_parent [:conformanceIssue/title]}]",
    ),
    claimPull: await pull(
      base,
      database,
      member,
      ids.claim,
      "[:conformanceIssue/title {:conformanceIssue/owner [:conformanceUser/sub]}]",
    ),
    parentEntity: await entity(base, database, member, ids.parent),
    claimEntity: await entity(base, database, member, ids.claim),
    bobLookup: await lookup(
      base,
      database,
      member,
      [":conformanceUser/sub", "bob-sub"],
    ),
    missingLookup: await lookup(
      base,
      database,
      member,
      [":conformanceUser/sub", "missing-sub"],
    ),
    missingEntity: await entity(base, database, member, 9_999_999),
  };
  return Object.fromEntries(
    Object.entries(responses).map(([name, response]) => [
      name,
      responseObservation(response),
    ]),
  );
};

const sortedResult = (response: Awaited<ReturnType<typeof query>>): string[] =>
  [...(response.body.result as string[])].sort();

const waitForTitles = async (
  base: string,
  world: World,
  expected: readonly string[],
): Promise<Awaited<ReturnType<typeof query>>> => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await query(base, world.database, world.member, TITLES);
    if (
      response.status === 200 &&
      JSON.stringify(sortedResult(response)) === JSON.stringify([...expected].sort())
    ) {
      return response;
    }
    await Bun.sleep(25);
  }
  throw new Error(`public read for ${world.database} did not reach the expected basis`);
};

const waitForCheckpoint = async (
  base: string,
  database: string,
  name: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await testAdmin(base, database, "/checkpoint", {
      scope: "worker",
      action: "status",
    });
    if (response.body.checkpoints?.[name]?.pending === true) return;
    await Bun.sleep(25);
  }
  throw new Error(`live query did not reach ${name}`);
};

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

const openLive = async (
  base: string,
  database: string,
  token: string,
): Promise<Response> => openStream(
  `${base.replace(/\/+$/, "")}/db/${database}/live`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...originHeaders,
    },
    body: JSON.stringify({ ...conformanceProof, query: TITLES }),
  },
  `live ${database}`,
);

export const registerConformance = (ctx: { urls: () => LocalUrls }) => {
  describe("required real-stack filtered-Db conformance", () => {
    beforeAll(() => loadConformanceProof(ctx.urls().conformanceUrl));

    test("paired worlds have identical public reads despite hidden datoms", async () => {
      const base = ctx.urls().conformanceUrl;
      const absent = await seedWorld(base, CONFORMANCE_DATABASES[0]!, false);
      const hidden = await seedWorld(base, CONFORMANCE_DATABASES[1]!, true);
      expect(hidden.ids).toEqual(absent.ids);
      expect(hidden.hiddenId).toBeDefined();

      await waitForTitles(base, absent, ["Beta", "Gamma", "Omega"]);
      await waitForTitles(base, hidden, ["Beta", "Gamma", "Omega"]);
      const absentObservation = await observeWorld(base, absent);
      const hiddenObservation = await observeWorld(base, hidden);
      expect(hiddenObservation).toEqual(absentObservation);

      const observationText = JSON.stringify(hiddenObservation);
      expect(observationText).not.toContain("Alpha-hidden-secret");
      expect(observationText).not.toContain("audit-secret");
      expect(observationText).not.toMatch(/basisT|txEid|rule|grant/);

      const adminHidden = await query(base, hidden.database, hidden.admin, TITLES);
      expect(sortedResult(adminHidden)).toEqual([
        "Alpha-hidden-secret",
        "Beta",
        "Gamma",
        "Omega",
      ]);
      const memberParent = await entity(
        base,
        hidden.database,
        hidden.member,
        hidden.ids.parent,
      );
      const adminParent = await entity(
        base,
        hidden.database,
        hidden.admin,
        hidden.ids.parent,
      );
      expect(memberParent.body.result[":conformanceIssue/audit"]).toBeUndefined();
      expect(adminParent.body.result[":conformanceIssue/audit"]).toBe(
        "visible-audit-secret",
      );
      const typed = await query(
        base,
        hidden.database,
        hidden.member,
        typedIssues.query,
      );
      const finalized = typedIssues.finalize(typed.body.result) as readonly {
        readonly title: string;
      }[];
      expect(
        finalized.map(({ title }) => title).sort(),
      ).toEqual(["Beta", "Gamma", "Omega"]);

      const stored = await testAdmin(base, hidden.database, "/query", {
        entity: hidden.ids.parent,
      });
      expect(stored.status).toBe(200);
      expect(stored.body.entity).toMatchObject({
        ":ramose/type": ":conformanceIssue",
        ":conformanceIssue/key": "parent",
      });
      expect(stored.body.entity[":ramose/trait"]).toBeUndefined();

      const hiddenEntity = await entity(
        base,
        hidden.database,
        hidden.member,
        hidden.hiddenId!,
      );
      const missingEntity = await entity(
        base,
        hidden.database,
        hidden.member,
        9_999_999,
      );
      expect(responseObservation(hiddenEntity)).toEqual(
        responseObservation(missingEntity),
      );
      expect(hiddenEntity.body).toEqual({ result: null });
    });

    test("current grants govern current, as-of, and history values", async () => {
      const base = ctx.urls().conformanceUrl;
      const absent = await seedWorld(base, CONFORMANCE_DATABASES[2]!, false);
      const hidden = await seedWorld(base, CONFORMANCE_DATABASES[3]!, true);
      expect(hidden.ids).toEqual(absent.ids);
      expect(hidden.visibleT).toBe(absent.visibleT);

      for (const world of [absent, hidden]) {
        const transferred = await invoke(base, world.database, world.member, {
          owner: { kind: "entity", name: ConformanceIssue.ns },
          localName: "transfer",
        }, { owner: world.ids.bob, org: "other" }, world.ids.parent);
        expect(transferred.status).toBe(200);
        await currentBasis(base, world.database);
        await waitForTitles(base, world, ["Gamma", "Omega"]);
      }

      const observeTemporal = async (world: World, token: string) => ({
        current: responseObservation(
          await query(base, world.database, token, TITLES),
        ),
        asOf: responseObservation(
          await query(base, world.database, token, TITLES, {
            asOf: world.visibleT,
          }),
        ),
        history: responseObservation(
          await query(base, world.database, token, TITLES, { history: true }),
        ),
      });
      const absentMember = await observeTemporal(absent, absent.member);
      const hiddenMember = await observeTemporal(hidden, hidden.member);
      expect(hiddenMember).toEqual(absentMember);
      for (const response of Object.values(absentMember)) {
        expect([...(response.body.result as string[])].sort()).toEqual([
          "Gamma",
          "Omega",
        ]);
      }

      const adminAsOf = await query(
        base,
        absent.database,
        absent.admin,
        TITLES,
        { asOf: absent.visibleT },
      );
      expect(sortedResult(adminAsOf)).toEqual(["Beta", "Gamma", "Omega"]);
    });

    test("receipt replay reauthorizes a revoked target without running its body", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = CONFORMANCE_DATABASES[6]!;
      await install(base, database);
      const admin = await signToken(database, "admin", "admin-sub", {
        org: "admin-org",
      });
      const member = await signToken(database, "member", "alice-sub", {
        org: "acme",
      });
      const alice = await create(
        base,
        database,
        admin,
        ConformanceUser.ns,
        { sub: "alice-sub" },
      );
      const bob = await create(
        base,
        database,
        admin,
        ConformanceUser.ns,
        { sub: "bob-sub" },
      );
      const issue = await create(
        base,
        database,
        admin,
        ConformanceIssue.ns,
        {
          key: "receipt-revocation",
          title: "Before invocation",
          owner: alice,
          org: "acme",
        },
      );
      const invocationId = "revoked-target-invocation-01";
      const operation = {
        owner: { kind: "entity" as const, name: ConformanceIssue.ns },
        localName: "rename",
      };
      const input = { title: "Original invocation" };
      const completed = await invoke(
        base,
        database,
        member,
        operation,
        input,
        issue,
        invocationId,
      );
      expect(completed.status).toBe(200);
      expect(completed.body).toEqual({
        result: { id: issue, title: "Original invocation" },
        receipt: { version: 2, invocationId, status: "completed" },
      });

      const transferred = await invoke(base, database, admin, {
        owner: { kind: "entity", name: ConformanceIssue.ns },
        localName: "transfer",
      }, { owner: bob, org: "other" }, issue);
      expect(transferred.status).toBe(200);
      const renamed = await invoke(base, database, admin, operation, {
        title: "After revocation",
      }, issue);
      expect(renamed.status).toBe(200);
      const beforeReplay = await currentBasis(base, database);

      const replayed = await invoke(
        base,
        database,
        member,
        operation,
        input,
        issue,
        invocationId,
      );
      expect(replayed.status).toBe(403);
      expect(replayed.body).toEqual({ error: "unauthorized" });
      expect(await currentBasis(base, database)).toBe(beforeReplay);
      const stored = await testAdmin(base, database, "/query", {
        entity: issue,
      });
      expect(stored.body.entity[":conformanceIssue/title"]).toBe(
        "After revocation",
      );
    });

    test("self-delete replay binds the pre-admission policy path while its target stays absent", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = CONFORMANCE_DATABASES[7]!;
      await install(base, database);
      const admin = await signToken(database, "admin", "admin-sub", {
        org: "admin-org",
      });
      const member = await signToken(database, "member", "alice-sub", {
        org: "acme",
      });
      const alice = await create(
        base,
        database,
        admin,
        ConformanceUser.ns,
        { sub: "alice-sub" },
      );
      const issue = await create(
        base,
        database,
        admin,
        ConformanceIssue.ns,
        {
          key: "self-delete-replay",
          title: "Original visible result",
          owner: alice,
          org: "acme",
        },
      );
      const invocationId = "self-delete-revoked-invocation-01";
      const operation = {
        owner: { kind: "entity" as const, name: ConformanceIssue.ns },
        localName: "deleteAndEchoTitle",
      };
      const target = [
        ":conformanceIssue/key",
        "self-delete-replay",
      ] as const;
      const completed = await invoke(
        base,
        database,
        member,
        operation,
        {},
        target,
        invocationId,
      );
      expect(completed.status).toBe(200);
      expect(completed.body).toEqual({
        result: { title: "Original visible result" },
        receipt: { version: 2, invocationId, status: "completed" },
      });
      const absentReplay = await invoke(
        base,
        database,
        member,
        operation,
        {},
        target,
        invocationId,
      );
      expect(absentReplay.status).toBe(200);
      expect(absentReplay.body).toEqual(completed.body);

      // An unrelated real commit and a new isolate do not invalidate the
      // durable lost-ack result.
      await create(
        base,
        database,
        admin,
        ConformanceUser.ns,
        { sub: "unrelated-sub" },
      );
      expect((await testAdmin(base, database, "/abort", {
        target: "transactor",
      })).status).toBe(200);
      const afterUnrelated = await invoke(
        base,
        database,
        member,
        operation,
        {},
        target,
        invocationId,
      );
      expect(afterUnrelated.status).toBe(200);
      expect(afterUnrelated.body).toEqual(completed.body);

      // The target is still absent, but a fact on the exact membership path
      // that admitted it has changed. The receipt must not cache access.
      const revoked = await invoke(base, database, admin, {
        owner: { kind: "entity", name: ConformanceUser.ns },
        localName: "setAccess",
      }, { access: "disabled" }, alice);
      expect(revoked.status).toBe(200);
      const beforeReplay = await currentBasis(base, database);

      const denied = await invoke(
        base,
        database,
        member,
        operation,
        {},
        target,
        invocationId,
      );
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: "unauthorized" });
      expect(await currentBasis(base, database)).toBe(beforeReplay);
      const stored = await testAdmin(base, database, "/query", {
        entity: issue,
      });
      expect(stored.body.entity).toBeNull();
    });

    test("self-hidden lookup replay binds referenced policy facts without binding unrelated data", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = CONFORMANCE_DATABASES[8]!;
      await install(base, database);
      const admin = await signToken(database, "admin", "admin-sub", {
        org: "admin-org",
      });
      const member = await signToken(database, "member", "alice-sub", {
        org: "acme",
      });
      const alice = await create(
        base,
        database,
        admin,
        ConformanceUser.ns,
        { sub: "alice-sub" },
      );
      const bob = await create(
        base,
        database,
        admin,
        ConformanceUser.ns,
        { sub: "bob-sub" },
      );
      const issue = await create(
        base,
        database,
        admin,
        ConformanceIssue.ns,
        {
          key: "self-hidden-original",
          title: "Durable private result",
          owner: alice,
          org: "acme",
        },
      );
      const invocationId = "self-hidden-lookup-invocation-01";
      const operation = {
        owner: { kind: "entity" as const, name: ConformanceIssue.ns },
        localName: "archive",
      };
      const target = [
        ":conformanceIssue/key",
        "self-hidden-original",
      ] as const;
      const input = {
        key: "self-hidden-archived",
        owner: bob,
        org: "other",
      };
      const completed = await invoke(
        base,
        database,
        member,
        operation,
        input,
        target,
        invocationId,
      );
      expect(completed.status).toBe(200);
      expect(completed.body).toEqual({
        result: { id: issue },
        receipt: { version: 2, invocationId, status: "completed" },
      });

      const exactRetry = await invoke(
        base,
        database,
        member,
        operation,
        input,
        target,
        invocationId,
      );
      expect(exactRetry.status).toBe(200);
      expect(exactRetry.body).toEqual(completed.body);

      await create(
        base,
        database,
        admin,
        ConformanceUser.ns,
        { sub: "unrelated-self-hidden-sub" },
      );
      const afterUnrelated = await invoke(
        base,
        database,
        member,
        operation,
        input,
        target,
        invocationId,
      );
      expect(afterUnrelated.status).toBe(200);
      expect(afterUnrelated.body).toEqual(completed.body);

      const targetBeforeRevocation = await testAdmin(base, database, "/query", {
        entity: issue,
      });
      const revoked = await invoke(base, database, admin, {
        owner: { kind: "entity", name: ConformanceUser.ns },
        localName: "setAccess",
      }, { access: "disabled" }, bob);
      expect(revoked.status).toBe(200);
      const targetAfterRevocation = await testAdmin(base, database, "/query", {
        entity: issue,
      });
      expect(targetAfterRevocation.body.entity).toEqual(
        targetBeforeRevocation.body.entity,
      );
      const beforeReplay = await currentBasis(base, database);

      const denied = await invoke(
        base,
        database,
        member,
        operation,
        input,
        target,
        invocationId,
      );
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: "unauthorized" });
      expect(await currentBasis(base, database)).toBe(beforeReplay);
    });

    test("lookup replay accepts its exact post-commit rebind but never a later replacement", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = CONFORMANCE_DATABASES[9]!;
      await install(base, database);
      const admin = await signToken(database, "admin", "admin-sub", {
        org: "admin-org",
      });
      const member = await signToken(database, "member", "alice-sub", {
        org: "acme",
      });
      const alice = await create(
        base,
        database,
        admin,
        ConformanceUser.ns,
        { sub: "alice-sub" },
      );
      const bob = await create(
        base,
        database,
        admin,
        ConformanceUser.ns,
        { sub: "bob-lookup-rebind-sub" },
      );
      const original = await create(
        base,
        database,
        admin,
        ConformanceIssue.ns,
        {
          key: "lookup-rebind-original",
          title: "Original operation subject",
          owner: alice,
          org: "acme",
        },
      );
      const replacement = await create(
        base,
        database,
        admin,
        ConformanceIssue.ns,
        {
          key: "lookup-rebind-second",
          title: "Post-commit lookup owner",
          owner: bob,
          org: "other",
        },
      );
      const third = await create(
        base,
        database,
        admin,
        ConformanceIssue.ns,
        {
          key: "lookup-rebind-third",
          title: "Later lookup owner",
          owner: alice,
          org: "acme",
        },
      );
      const operation = {
        owner: { kind: "entity" as const, name: ConformanceIssue.ns },
        localName: "moveLookup",
      };
      const target = [
        ":conformanceIssue/key",
        "lookup-rebind-original",
      ] as const;
      const input = {
        replacement,
        archivedKey: "lookup-rebind-archived",
        lookupKey: "lookup-rebind-original",
      };
      const invocationId = "lookup-rebind-invocation-01";
      const completed = await invoke(
        base,
        database,
        member,
        operation,
        input,
        target,
        invocationId,
      );
      expect(completed.status).toBe(200);
      expect(completed.body).toEqual({
        result: { id: original },
        receipt: { version: 2, invocationId, status: "completed" },
      });
      expect((await entity(
        base,
        database,
        member,
        replacement,
      )).body).toEqual({ result: null });
      expect((await entity(
        base,
        database,
        member,
        original,
      )).body.result).not.toBeNull();
      expect((await lookup(base, database, member, target)).body).toEqual({
        result: null,
      });
      expect((await lookup(base, database, admin, target)).body.result).toBe(
        replacement,
      );
      const exactRetry = await invoke(
        base,
        database,
        member,
        operation,
        input,
        target,
        invocationId,
      );
      expect(exactRetry.status).toBe(200);
      expect(exactRetry.body).toEqual(completed.body);

      const movedAgain = await invoke(
        base,
        database,
        admin,
        operation,
        {
          replacement: third,
          archivedKey: "lookup-rebind-second-after",
          lookupKey: "lookup-rebind-original",
        },
        replacement,
      );
      expect(movedAgain.status).toBe(200);
      expect((await lookup(base, database, admin, target)).body.result).toBe(
        third,
      );
      const beforeThirdDenial = await currentBasis(base, database);
      const deniedThird = await invoke(
        base,
        database,
        member,
        operation,
        input,
        target,
        invocationId,
      );
      expect(deniedThird.status).toBe(403);
      expect(deniedThird.body).toEqual({ error: "unauthorized" });
      expect(await currentBasis(base, database)).toBe(beforeThirdDenial);

      const cleared = await invoke(base, database, admin, {
        owner: { kind: "entity", name: ConformanceIssue.ns },
        localName: "archive",
      }, {
        key: "lookup-rebind-third-after",
        owner: alice,
        org: "acme",
      }, third);
      expect(cleared.status).toBe(200);
      expect((await lookup(base, database, admin, target)).body.result).toBeNull();
      const beforeNullDenial = await currentBasis(base, database);
      const deniedNull = await invoke(
        base,
        database,
        member,
        operation,
        input,
        target,
        invocationId,
      );
      expect(deniedNull.status).toBe(403);
      expect(deniedNull.body).toEqual({ error: "unauthorized" });
      expect(await currentBasis(base, database)).toBe(beforeNullDenial);
    });

    test("JWT, catalog proof, metadata, and errors fail closed opaquely", async () => {
      const base = ctx.urls().conformanceUrl;
      const database = CONFORMANCE_DATABASES[0]!;
      const member = await signToken(database, "member", "alice-sub", {
        org: "acme",
      });
      const noToken = await query(base, database, undefined, TITLES);
      const badToken = await query(base, database, "not.a.jwt", TITLES);
      expect(responseObservation(badToken)).toEqual(responseObservation(noToken));
      expect(noToken.status).toBe(401);
      expect(noToken.body).toEqual({ error: "unauthorized" });

      const missingClaim = await signToken(database, "member", "alice-sub");
      const missingClaimResponse = await query(
        base,
        database,
        missingClaim,
        TITLES,
      );
      expect(missingClaimResponse.status).toBe(401);
      expect(missingClaimResponse.body).toEqual({ error: "unauthorized" });

      const stale = await query(base, database, member, TITLES, {
        proof: {
          catalog: conformanceProof.catalog,
          unitHash: "0".repeat(64),
        },
      });
      const wrongCatalog = await query(base, database, member, TITLES, {
        proof: {
          catalog: "not-the-deployed-catalog",
          unitHash: conformanceProof.unitHash,
        },
      });
      expect(stale.status).toBe(401);
      expect(responseObservation(stale)).toEqual(responseObservation(wrongCatalog));
      expect(stale.body).toEqual({ error: "unauthorized" });

      const malformed = await query(
        base,
        database,
        member,
        "[:find ?secret :where [?e :private/password ?secret]]",
      );
      expect(malformed.status).toBe(400);
      expect(malformed.body).toEqual({ error: "invalid request" });
      const publicText = JSON.stringify([
        responseObservation(stale),
        responseObservation(malformed),
      ]);
      expect(publicText).not.toContain(conformanceProof.catalog);
      expect(publicText).not.toContain(conformanceProof.unitHash);
      expect(publicText).not.toContain("private/password");
      for (const name of [
        "x-ramose-basis-t",
        "x-ramose-replica-hint",
        "x-ramose-cache-hits",
        "x-ramose-r2-gets",
        "x-ramose-deployment",
        "server-timing",
      ]) {
        expect(malformed.res.headers.get(name)).toBeNull();
        expect(stale.res.headers.get(name)).toBeNull();
      }
    });

    test("live output ignores hidden changes and retracts revoked rows", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, CONFORMANCE_DATABASES[4]!, false);
      await waitForTitles(base, world, ["Beta", "Gamma", "Omega"]);
      const response = await openLive(base, world.database, world.member);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/x-ndjson",
      );
      expect(response.headers.get("x-ramose-basis-t")).toBeNull();
      const iterator = readLiveNdjson(response)[Symbol.asyncIterator]();
      try {
        const first = await withTimeout(iterator.next(), 5_000, "initial live diff");
        expect(first.done).toBe(false);
        expect((applyLiveDiffs([first.value!]) as string[]).sort()).toEqual([
          "Beta",
          "Gamma",
          "Omega",
        ]);

        const armed = await testAdmin(base, world.database, "/checkpoint", {
          scope: "worker",
          action: "arm-wait",
          name: "live.recompute",
        });
        expect(armed.status).toBe(200);
        let settled = false;
        const next = iterator.next().then((value) => {
          settled = true;
          return value;
        });
        await create(base, world.database, world.admin, ConformanceIssue.ns, {
          key: "hidden-live",
          title: "Hidden-live-secret",
          owner: world.ids.bob,
          org: "other",
        });
        await waitForCheckpoint(base, world.database, "live.recompute");
        const released = await testAdmin(base, world.database, "/checkpoint", {
          scope: "worker",
          action: "release",
          name: "live.recompute",
        });
        expect(released.status).toBe(200);
        await Bun.sleep(100);
        expect(settled).toBe(false);

        const renamed = await invoke(base, world.database, world.member, {
          owner: { kind: "entity", name: ConformanceIssue.ns },
          localName: "rename",
        }, { title: "Beta-renamed" }, world.ids.parent);
        expect(renamed.status).toBe(200);
        const renameDiff = await withTimeout(next, 5_000, "visible live diff");
        expect(renameDiff.done).toBe(false);
        expect((applyLiveDiffs([
          first.value!,
          renameDiff.value!,
        ]) as string[]).sort()).toEqual([
          "Beta-renamed",
          "Gamma",
          "Omega",
        ]);
        expect(JSON.stringify(renameDiff.value)).not.toContain(
          "Hidden-live-secret",
        );

        const revoked = iterator.next();
        const transfer = await invoke(base, world.database, world.member, {
          owner: { kind: "entity", name: ConformanceIssue.ns },
          localName: "transfer",
        }, { owner: world.ids.bob, org: "other" }, world.ids.parent);
        expect(transfer.status).toBe(200);
        const revokeDiff = await withTimeout(
          revoked,
          5_000,
          "revocation live diff",
        );
        expect(revokeDiff.done).toBe(false);
        expect(revokeDiff.value).toEqual({
          added: [],
          retracted: ["Beta-renamed"],
        });
        expect(JSON.stringify([first.value, renameDiff.value, revokeDiff.value]))
          .not.toMatch(/Hidden-live-secret|basis|catalog|txEid|grant|rule/);
      } finally {
        await iterator.return?.(undefined);
      }
    });

    test("live authorization lease expires by closing without diagnostics", async () => {
      const base = ctx.urls().conformanceUrl;
      const world = await seedWorld(base, CONFORMANCE_DATABASES[5]!, false);
      const now = Math.floor(Date.now() / 1_000);
      const expiring = await signToken(
        world.database,
        "member",
        "alice-sub",
        { org: "acme" },
        { iat: now, exp: now + 4 },
      );
      const response = await openLive(base, world.database, expiring);
      expect(response.status).toBe(200);
      const iterator = readLiveNdjson(response)[Symbol.asyncIterator]();
      const frames: LiveQueryDiff[] = [];
      try {
        const first = await withTimeout(iterator.next(), 5_000, "expiring first diff");
        expect(first.done).toBe(false);
        frames.push(first.value!);
        const closed = await withTimeout(iterator.next(), 7_000, "lease close");
        expect(closed.done).toBe(true);
        expect(JSON.stringify(frames)).not.toMatch(/exp|lease|jwt|basis|catalog|rule/);
      } finally {
        await iterator.return?.(undefined);
      }
    });
  });
};
