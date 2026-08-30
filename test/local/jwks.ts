import { JWKS } from "./auth-keys.ts";

export default {
  fetch(): Response {
    return new Response(JWKS, {
      headers: { "content-type": "application/json" },
    });
  },
};
