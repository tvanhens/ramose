/**
 * Runtime access to the durable server identity/sealing root.
 *
 * The root is obtained through the existing authenticated internal boundary
 * (`x-ramose-internal` on a fetch into the Durable Object namespace) from one
 * fixed-name instance of the already-required `REPLICA` namespace, then cached
 * for the lifetime of the isolate. A fresh isolate — the ordinary consequence
 * of a redeploy — re-reads the same durable record and derives the same
 * identities.
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
 *
 * It lives here rather than under `worker/` because the authoritative
 * Transactor needs it too: #475 seals allocation mappings into the durable
 * receipt inside the writer, and opens sealed operation targets there, so the
 * accessor cannot be Worker-only. The environment is taken structurally, so
 * this module depends on no deployment type.
 */

import { internalHeaders } from "../transactor/internal.ts";
import {
  decodeServerIdentityRoot,
  sealingKeyOf,
  ServerIdentityUnavailable,
  type ServerIdentityRoot,
  type ServerSealingKey,
} from "./server-identity.ts";

/** Fixed Durable Object name. Changing it would orphan every identity. */
export const SERVER_IDENTITY_ROOT_NAME = "ramose-server-identity-root-v1";

export type IdentityRootEnv = {
  readonly REPLICA: DurableObjectNamespace;
  readonly RAMOSE_INTERNAL_SECRET: string;
};

let cached: Promise<ServerIdentityRoot> | undefined;

export const serverIdentityRootId = (
  env: Pick<IdentityRootEnv, "REPLICA">,
): DurableObjectId => env.REPLICA.idFromName(SERVER_IDENTITY_ROOT_NAME);

const load = async (env: IdentityRootEnv): Promise<ServerIdentityRoot> => {
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
    // A record this build cannot read fails closed here rather than being
    // replaced; derivations stop instead of producing identities under a
    // different key.
    const failure = await response.text().catch(() => "");
    throw new ServerIdentityUnavailable({
      reason: `server identity root is unusable (${response.status}) ${failure}`.trim(),
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
  env: IdentityRootEnv,
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
  env: IdentityRootEnv,
): Promise<ServerSealingKey> => sealingKeyOf(await serverIdentityRoot(env));

/** Test hook: make the next derivation behave like a cold isolate. */
export const clearServerIdentityRootCache = (): void => {
  cached = undefined;
};
