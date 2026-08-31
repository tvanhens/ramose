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
