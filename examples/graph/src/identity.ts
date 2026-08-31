export const ISSUER = "https://identity.example.test";
export const AUDIENCE = "ramose:example-graph";

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
