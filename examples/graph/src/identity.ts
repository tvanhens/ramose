/**
 * The development identity this example signs and verifies with.
 *
 * A real deployment publishes a JWKS from its own identity provider — Reef does
 * that with Better Auth — and never ships a private key. This example carries
 * one so that `bun run dev:graph` is a single command with no accounts to
 * create, and it is worth nothing: the key pair below is public, in this
 * repository, and must not be used anywhere a real principal exists.
 */
export const ISSUER = "https://identity.example.test";
export const AUDIENCE = "ramose:example-graph";

/** How long a minted bearer lives. Short, so renewal is the ordinary case. */
export const TOKEN_TTL_SECONDS = 60;

export const PUBLIC_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "hUkk11Woi4F2fQrScAGDMSFolDcb_urvdvYyoQBct_g",
  y: "yoxcOGNxbe6kW0CLfOmXUCEJhzfqGEyA-WCCTtqIGsI",
  alg: "ES256",
  kid: "example-graph-dev",
} as const;

export const PRIVATE_JWK = {
  ...PUBLIC_JWK,
  d: "xk5NbhnHlzVVGobZ9WSJUXTw3jWrTQG2BNo4x6yHlm4",
} as const;

export const JWKS = JSON.stringify({ keys: [PUBLIC_JWK] });
