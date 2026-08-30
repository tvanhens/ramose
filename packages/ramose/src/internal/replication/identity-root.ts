import { internalHeaders } from "../transactor/internal.ts";
import {
  decodeServerIdentityRoot,
  sealingKeyOf,
  ServerIdentityUnavailable,
  type ServerIdentityRoot,
  type ServerSealingKey,
} from "./server-identity.ts";

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

export const clearServerIdentityRootCache = (): void => {
  cached = undefined;
};
