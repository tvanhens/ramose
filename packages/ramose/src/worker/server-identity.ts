/**
 * Worker access to the durable server identity/sealing root.
 *
 * The root is obtained through the existing authenticated internal boundary
 * (`x-ramose-internal` on a Worker→DO fetch) from one fixed-name instance of
 * the already-required `REPLICA` Durable Object namespace, then cached for the
 * lifetime of the isolate. A fresh isolate — the ordinary consequence of a
 * redeploy — re-reads the same durable record and derives the same identities.
 *
 * Why the Replica namespace and a fixed name:
 *   - it needs no new Durable Object class and therefore no new migration;
 *   - `REPLICA` is already a required, deploy-time-validated binding for both
 *     the owned peer and a user-supplied escape-hatch Worker
 *     (`validatePeerWiring`), so the escape hatch inherits the same stable
 *     binding path with nothing extra to configure;
 *   - the name is a constant, never a function of a deployment id, database,
 *     region, or location hint, so every isolate of every deployment resolves
 *     the same object.
 */

import {
  decodeServerIdentityRoot,
  sealingKeyOf,
  ServerIdentityUnavailable,
  type ServerIdentityRoot,
  type ServerSealingKey,
} from "../internal/replication/server-identity.ts";
import { internalHeaders } from "../internal/transactor/internal.ts";
import type { RamoseEnv } from "../RamoseEnv.ts";

/** Fixed Durable Object name. Changing it would orphan every identity. */
export const SERVER_IDENTITY_ROOT_NAME = "ramose-server-identity-root-v1";

type IdentityEnv = Pick<RamoseEnv, "REPLICA" | "RAMOSE_INTERNAL_SECRET">;

let cached: Promise<ServerIdentityRoot> | undefined;

export const serverIdentityRootId = (
  env: Pick<RamoseEnv, "REPLICA">,
): DurableObjectId => env.REPLICA.idFromName(SERVER_IDENTITY_ROOT_NAME);

const load = async (env: IdentityEnv): Promise<ServerIdentityRoot> => {
  let response: Response;
  try {
    response = await env.REPLICA.get(serverIdentityRootId(env)).fetch(
      "https://replica/server-identity",
      { method: "POST", headers: internalHeaders(env) },
    );
  } catch (cause) {
    throw new ServerIdentityUnavailable({
      reason: "server identity root is unreachable",
      cause,
    });
  }
  if (!response.ok) {
    throw new ServerIdentityUnavailable({
      reason: `server identity root refused the internal capability (${response.status})`,
    });
  }
  const body = (await response.json()) as { readonly root?: unknown };
  const root = decodeServerIdentityRoot(body.root);
  if (root === undefined) {
    throw new ServerIdentityUnavailable({
      reason: "server identity root record is unreadable",
    });
  }
  return root;
};

/**
 * The isolate-cached durable root. A failure is never cached, so a transient
 * Durable Object error does not poison the isolate.
 */
export const serverIdentityRoot = (
  env: IdentityEnv,
): Promise<ServerIdentityRoot> => {
  const existing = cached;
  if (existing !== undefined) return existing;
  const pending: Promise<ServerIdentityRoot> = load(env).catch(
    (cause): never => {
      if (cached === pending) cached = undefined;
      throw cause;
    },
  );
  cached = pending;
  return pending;
};

export const serverSealingKey = async (
  env: IdentityEnv,
): Promise<ServerSealingKey> => sealingKeyOf(await serverIdentityRoot(env));

/** Test hook: make the next derivation behave like a cold Worker isolate. */
export const clearServerIdentityRootCache = (): void => {
  cached = undefined;
};
