/**
 * Owned Ramose peers for the local integration stack.
 *
 * Each Server has its own storage and Worker logical ids so they do not
 * collide. Auth peers share the checked-in JWKS; the open peer is the
 * default target for the behavioral contract.
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Ramose from "ramose";
import {
  AUD,
  ISS,
  JWKS,
  POLICY_CLOSED_JSON,
  POLICY_JSON,
  POLICY_SCHEMA_JSON,
  SHARED_TOKEN,
} from "./auth-keys.ts";
import { Open } from "./open.ts";
import { Movies, operations } from "./ops.ts";

export { Open };

const worker = import.meta.resolve("./worker.ts");
const empty = import.meta.resolve("./empty-worker.ts");

const jwtAuth = (policy: string) =>
  ({
    policy,
    jwksJson: JWKS,
    issuers: ISS,
    aud: AUD,
  }) satisfies Ramose.ServerAuth;

/** Empty registry — `GET /health` lists `[]`. */
export const Empty = Ramose.Server("Empty", {
  peer: "EmptyPeer",
  storage: "EmptyStore",
  main: empty,
});

/** Shared-token peer (`RAMOSE_TOKEN`). */
export const Token = Ramose.Server("Token", {
  peer: "TokenPeer",
  storage: "TokenStore",
  main: empty,
  token: SHARED_TOKEN,
});

/** JWT + policy (anonymous class, CORS, shared token is not a principal). */
export const Policy = Ramose.Server("Policy", {
  peer: "PolicyPeer",
  storage: "PolicyStore",
  main: worker,
  operations,
  token: SHARED_TOKEN,
  auth: {
    ...jwtAuth(POLICY_JSON),
    allowedOrigins: ["https://app.acme.test"],
  },
});

/** Policy with no anonymous class — a missing token is 401. */
export const PolicyClosed = Ramose.Server("PolicyClosed", {
  peer: "PolicyClosedPeer",
  storage: "PolicyClosedStore",
  main: empty,
  auth: jwtAuth(POLICY_CLOSED_JSON),
});

/** Policy that lets `member` install schema (smuggled-write regression). */
export const PolicySchema = Ramose.Server("PolicySchema", {
  peer: "PolicySchemaPeer",
  storage: "PolicySchemaStore",
  main: empty,
  auth: jwtAuth(POLICY_SCHEMA_JSON),
});

/** Catalog seeded at deploy (`databases:`). */
export const Seeded = Ramose.Server("Seeded", {
  peer: "SeededPeer",
  storage: "SeededStore",
  main: empty,
  databases: { movies: Movies },
});

/** Issuer Worker the JWKS service binding dispatches through. */
export const Jwks = Cloudflare.Worker("Jwks", {
  main: import.meta.resolve("./jwks.ts"),
});

/**
 * Policy peer whose keys come from a sibling Worker. `jwksUrl` is a dummy
 * host — without the binding a local `fetch` of it 401s.
 */
export const JwksBound = Ramose.Server("JwksBound", {
  peer: "JwksBoundPeer",
  storage: "JwksBoundStore",
  main: empty,
  auth: {
    policy: POLICY_JSON,
    jwksUrl: "https://jwks.invalid/jwks",
    jwksService: "JWKS",
    issuers: ISS,
    aud: AUD,
  },
  env: { JWKS: Jwks },
});

/** Same dummy JWKS URL, no service binding — tokens 401. */
export const JwksUrlOnly = Ramose.Server("JwksUrlOnly", {
  peer: "JwksUrlOnlyPeer",
  storage: "JwksUrlOnlyStore",
  main: empty,
  auth: {
    policy: POLICY_JSON,
    jwksUrl: "https://jwks.invalid/jwks",
    issuers: ISS,
    aud: AUD,
  },
});
