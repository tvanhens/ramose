import {
  databaseRuntimeBoundaries,
  handleIsolateTestAdmin,
  resetTestHooks,
  testHooksEnabled,
} from "../internal/test-hooks.ts";
import {
  createTestingQueryReplicaDO,
  type ReplicaTesting,
} from "../internal/replica/replica-do-testing.ts";
import {
  createTestingTransactorDO,
  type TransactorTesting,
} from "../internal/transactor/transactor-do.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";
import {
  respond,
  runFetch,
  type ServerOptions,
} from "./handle.ts";
import {
  deployedDatabaseCatalogBindings,
  deployedOperationCatalogs,
  type OperationCatalogs,
} from "./operation-catalogs.ts";
import { asTestAdminError, handleTestAdmin } from "./test-admin.ts";

const TEST_CAPABILITY_HEADER = "x-ramose-test-capability";
const TEST_CAPABILITY_QUERY = "__ramose_test_capability";

const same = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const configured = (env: RamoseEnv): string | undefined => {
  const capability = env.RAMOSE_TEST_CAPABILITY;
  return typeof capability === "string" && capability.length >= 32
    ? capability
    : undefined;
};

const serverEnabled = (request: Request, env: RamoseEnv): boolean => {
  const capability = configured(env);
  if (!testHooksEnabled(env) || capability === undefined) return false;
  const supplied = request.headers.get(TEST_CAPABILITY_HEADER) ??
    new URL(request.url).searchParams.get(TEST_CAPABILITY_QUERY) ?? "";
  return same(supplied, capability);
};

const durableObjectEnabled = (env: RamoseEnv): boolean =>
  testHooksEnabled(env) && configured(env) !== undefined;

const durableObjectTesting: ReplicaTesting & TransactorTesting = Object.freeze({
  boundariesOf: databaseRuntimeBoundaries,
  enabled: durableObjectEnabled,
  reset: resetTestHooks,
  handleAdmin: handleIsolateTestAdmin,
});

export const createServer = (options: ServerOptions = {}) => ({
  async fetch(
    request: Request,
    env: unknown,
    _ctx?: ExecutionContext,
  ): Promise<Response> {
    const runtimeEnv = env as RamoseEnv;
    const enabled = serverEnabled(request, runtimeEnv);
    if (
      new URL(request.url).pathname.startsWith("/__test__/") &&
      enabled
    ) {
      try {
        const proofMatch = /^\/__test__\/db\/([^/]+)\/catalog-proof$/.exec(
          new URL(request.url).pathname,
        );
        if (proofMatch !== null && request.method === "GET") {
          const proof = options.operationCatalogs?.proof(
            decodeURIComponent(proofMatch[1]!),
          );
          return proof === undefined
            ? new Response(JSON.stringify({ error: "not found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            })
            : new Response(JSON.stringify(proof), {
              headers: { "content-type": "application/json" },
            });
        }
        return await handleTestAdmin(request, runtimeEnv, new URL(request.url));
      } catch (cause) {
        return respond(asTestAdminError(cause), request, runtimeEnv);
      }
    }
    return runFetch(
      request,
      runtimeEnv,
      options,
      databaseRuntimeBoundaries,
    );
  },
});

export const createTransactorDO = (operationCatalogs: OperationCatalogs) =>
  createTestingTransactorDO(
    durableObjectTesting,
    deployedOperationCatalogs(operationCatalogs),
    deployedDatabaseCatalogBindings(operationCatalogs),
  );

export const TransactorDO = createTestingTransactorDO(durableObjectTesting);
export const QueryReplicaDO = createTestingQueryReplicaDO(durableObjectTesting);

export default createServer();
