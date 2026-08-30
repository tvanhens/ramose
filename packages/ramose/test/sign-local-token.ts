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

export const signToken = async (
  _db: string,
  cls: string,
  sub = "user_ada",
  attrs?: Record<string, unknown>,
  over: Record<string, unknown> = {},
): Promise<string> => {
  let jwt = new SignJWT({
    ramose: { class: cls, ...(attrs === undefined ? {} : { attrs }) },
  }).setProtectedHeader({ alg: "ES256", kid: "test" });
  jwt = jwt.setIssuer((over.iss as string) ?? ISS);
  jwt = jwt.setAudience((over.aud as string) ?? AUD);
  jwt = jwt.setSubject((over.sub as string) ?? sub);
  jwt = jwt.setIssuedAt((over.iat as number) ?? undefined);
  jwt = jwt.setExpirationTime((over.exp as string | number) ?? "5m");
  return jwt.sign(await key());
};
