/**
 * Sibling issuer Worker for the JWKS service-binding case.
 *
 * Serves the static test key set on every path so `RAMOSE_JWKS_URL`
 * can point here (or at a dummy URL that this binding is asked to fetch).
 */

import { JWKS } from "./auth-keys.ts";

export default {
  fetch(): Response {
    return new Response(JWKS, {
      headers: { "content-type": "application/json" },
    });
  },
};
