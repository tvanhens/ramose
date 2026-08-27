/**
 * Signs JWTs for the local auth contract. Kept in this package so `jose`
 * resolves. The public JWK / policy JSON live in `test/local/auth-keys.ts`.
 */

import { SignJWT, importJWK } from "jose";
import { AUD, ISS } from "../../../test/local/auth-keys.ts";

const PRIVATE_JWK = {
  crv: "P-256",
  d: "xk5NbhnHlzVVGobZ9WSJUXTw3jWrTQG2BNo4x6yHlm4",
  kty: "EC",
  x: "hUkk11Woi4F2fQrScAGDMSFolDcb_urvdvYyoQBct_g",
  y: "yoxcOGNxbe6kW0CLfOmXUCEJhzfqGEyA-WCCTtqIGsI",
} as const;

let privateKey: CryptoKey | undefined;

const key = async () => {
  privateKey ??= (await importJWK({ ...PRIVATE_JWK }, "ES256")) as CryptoKey;
  return privateKey;
};

export type SignOver = {
  readonly iss?: string;
  readonly aud?: string;
  readonly sub?: string | null;
  readonly iat?: number | null;
  readonly exp?: string | number;
  readonly nbf?: number;
  readonly alg?: string;
  readonly kid?: string | null;
  readonly secret?: string;
  readonly jwk?: {
    readonly crv: string;
    readonly d: string;
    readonly kty: string;
    readonly x: string;
    readonly y: string;
  };
  readonly ramose?: unknown;
};

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** Sign a `ramose.db` / `ramose.class` token for `db`. */
export const signToken = async (
  db: string,
  cls: string,
  sub = "user_ada",
  attrs?: Record<string, unknown>,
  over: SignOver = {},
): Promise<string> => {
  const alg = over.alg ?? "ES256";
  const kid = over.kid === null ? undefined : (over.kid ?? "test");
  const ramose =
    over.ramose !== undefined
      ? over.ramose
      : { db, class: cls, ...(attrs === undefined ? {} : { attrs }) };
  const header = kid === undefined ? { alg } : { alg, kid };
  if (alg === "none") {
    const now = Math.floor(Date.now() / 1000);
    const exp = typeof over.exp === "number" ? over.exp : (over.iat ?? now) + 300;
    const payload: Record<string, unknown> = {
      ramose,
      iss: over.iss ?? ISS,
      aud: over.aud ?? AUD,
      exp,
    };
    if (over.iat !== null) payload.iat = over.iat ?? now;
    if (over.sub !== null) payload.sub = over.sub ?? sub;
    if (over.nbf !== undefined) payload.nbf = over.nbf;
    return `${b64url(header)}.${b64url(payload)}.`;
  }
  let jwt = new SignJWT({ ramose }).setProtectedHeader(header);
  jwt = jwt.setIssuer(over.iss ?? ISS);
  jwt = jwt.setAudience(over.aud ?? AUD);
  if (over.sub !== null) jwt = jwt.setSubject(over.sub ?? sub);
  if (over.iat !== null) jwt = jwt.setIssuedAt(over.iat ?? undefined);
  jwt = jwt.setExpirationTime(over.exp ?? "5m");
  if (over.nbf !== undefined) jwt = jwt.setNotBefore(over.nbf);
  if (alg === "HS256") {
    return jwt.sign(new TextEncoder().encode(over.secret ?? "hs256-test-secret"));
  }
  if (over.jwk !== undefined) {
    return jwt.sign((await importJWK({ ...over.jwk }, alg)) as CryptoKey);
  }
  return jwt.sign(await key());
};
