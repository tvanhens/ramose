import { SignJWT, importJWK } from "jose";
import {
  AUDIENCE,
  ISSUER,
  JWKS,
  PRIVATE_JWK,
  PUBLIC_JWK,
  TOKEN_TTL_SECONDS,
} from "./src/identity.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
} as const;

let signing: Promise<CryptoKey> | undefined;

const key = (): Promise<CryptoKey> => {
  signing ??= importJWK({ ...PRIVATE_JWK }, "ES256") as Promise<CryptoKey>;
  return signing;
};

const mint = async (subject: string): Promise<string> =>
  new SignJWT({ ramose: { class: "member" } })
    .setProtectedHeader({ alg: "ES256", kid: PUBLIC_JWK.kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(await key());

/**
 * The example's identity plane: it publishes a JWKS the peer verifies against,
 * and mints a short-lived bearer for whoever asks.
 *
 * Asking is enough because this is a development identity. The shape is the
 * real one — the peer only ever sees a signed ES256 bearer it verifies against
 * a published key — and swapping this Worker for Better Auth, as Reef does,
 * changes nothing on the peer or in the client.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === "/jwks") {
      return new Response(JWKS, {
        headers: { "content-type": "application/json", ...CORS },
      });
    }
    if (url.pathname === "/token") {
      const subject = url.searchParams.get("sub") ?? "user_ada";
      return new Response(
        JSON.stringify({
          token: await mint(subject),
          account: subject,
          expiresIn: TOKEN_TTL_SECONDS,
        }),
        { headers: { "content-type": "application/json", ...CORS } },
      );
    }
    return new Response("not found", { status: 404, headers: CORS });
  },
};
