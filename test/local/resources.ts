/**
 * Owned Ramose peers for the local integration stack.
 *
 * Each Server has its own storage and Worker logical ids so they do not
 * collide. Auth peers share the checked-in JWKS; every data plane is
 * fail-closed until verified JWT (#412) + catalog + filtered `Db` (#421/#423).
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Ramose from "ramose";
import { AUD, ISS, JWKS } from "./auth-keys.ts";
import { Open } from "./open.ts";
import { operations } from "./ops.ts";
import { TEST_HOOKS_ENV } from "./test-hooks-env.ts";

export { Open };

const worker = import.meta.resolve("./worker.ts");
const empty = import.meta.resolve("./empty-worker.ts");

const jwtAuth = () =>
  ({
    jwksJson: JWKS,
    issuers: ISS,
    aud: AUD,
  }) satisfies Ramose.ServerAuth;

/** Empty registry — `GET /health` lists `[]`. */
export const Empty = Ramose.Server("Empty", {
  peer: "EmptyPeer",
  storage: "EmptyStore",
  main: empty,
  env: TEST_HOOKS_ENV,
});

/** Extra peer — no seed-token credential. */
export const Token = Ramose.Server("Token", {
  peer: "TokenPeer",
  storage: "TokenStore",
  main: empty,
  env: TEST_HOOKS_ENV,
});

/** JWT verifier bindings reserved for #412. Data plane is still 401. */
export const Policy = Ramose.Server("Policy", {
  peer: "PolicyPeer",
  storage: "PolicyStore",
  main: worker,
  operations,
  auth: {
    ...jwtAuth(),
    allowedOrigins: ["https://app.acme.test"],
  },
  env: TEST_HOOKS_ENV,
});

/** Same fail-closed data plane, no anonymous class leftover. */
export const PolicyClosed = Ramose.Server("PolicyClosed", {
  peer: "PolicyClosedPeer",
  storage: "PolicyClosedStore",
  main: empty,
  auth: jwtAuth(),
  env: TEST_HOOKS_ENV,
});

/** Same fail-closed data plane as Policy. */
export const PolicySchema = Ramose.Server("PolicySchema", {
  peer: "PolicySchemaPeer",
  storage: "PolicySchemaStore",
  main: empty,
  auth: jwtAuth(),
  env: TEST_HOOKS_ENV,
});

/** Catalog seed is closed until authorized catalog publication. */
export const Seeded = Ramose.Server("Seeded", {
  peer: "SeededPeer",
  storage: "SeededStore",
  main: empty,
  env: TEST_HOOKS_ENV,
});

/** Issuer Worker the JWKS service binding dispatches through. */
export const Jwks = Cloudflare.Worker("Jwks", {
  main: import.meta.resolve("./jwks.ts"),
});

/**
 * Peer whose keys come from a sibling Worker. `jwksUrl` is a dummy
 * host — without the binding a local `fetch` of it 401s.
 */
export const JwksBound = Ramose.Server("JwksBound", {
  peer: "JwksBoundPeer",
  storage: "JwksBoundStore",
  main: empty,
  auth: {
    jwksUrl: "https://jwks.invalid/jwks",
    jwksService: "JWKS",
    issuers: ISS,
    aud: AUD,
  },
  env: { JWKS: Jwks, ...TEST_HOOKS_ENV },
});

/** Same dummy JWKS URL, no service binding — tokens 401. */
export const JwksUrlOnly = Ramose.Server("JwksUrlOnly", {
  peer: "JwksUrlOnlyPeer",
  storage: "JwksUrlOnlyStore",
  main: empty,
  auth: {
    jwksUrl: "https://jwks.invalid/jwks",
    issuers: ISS,
    aud: AUD,
  },
  env: TEST_HOOKS_ENV,
});
