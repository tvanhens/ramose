/**
 * Browser target of the root `ramose` entry.
 *
 * The deploy barrel (`src/index.ts`) value-exports `Server`, which pulls
 * Alchemy. Client bundlers that honor the `browser` export condition land
 * here instead: the portable `ramose/db` surface plus the alchemy-free
 * shared names (`claims`) so `import * as Ramose from "ramose"` in a
 * client module can mint claims without shipping the deploy engine.
 *
 * Types for the root specifier stay on `dist/index.d.ts` (the `types`
 * condition is not nested under `browser`) so an isomorphic type-only
 * import such as `import type { AuthConfig } from "ramose"` still
 * resolves. Runtime in the browser does not include `Server` / `Database`
 * / the Alchemy resources.
 *
 * @module
 */

export * from "./db/index.ts";

export { type AuthConfig, claims, type ClaimsInput, type ClaimsPolicy } from "./Auth.ts";
