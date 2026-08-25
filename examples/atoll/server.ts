/**
 * The whole deploy (#312 §The root). Compare what is NOT here against
 * today's engine: no `children:` map, no `apiKeys:` declaration, no roles,
 * no per-workspace install step.
 *
 * At boot, `Server` walks `root` by reachability — entities → composed
 * traits → closed-over catalogs, recursing into each catalog's schema — and
 * assembles the registry: { org → orgCatalog, workspace → workspaceCatalog }.
 * A `:graph/catalog` stamp naming a key this deploy doesn't carry is a hard,
 * named error at entry; duplicate keys bound to different code are a boot
 * error.
 *
 * ergonomics: the registry being invisible is the point (no module-scope
 * globals, deterministic under bundling) — but "what catalogs does this
 * deploy actually serve?" now has no place to be read. A `Server(...).catalogs`
 * inspection surface, or a boot log line, is probably owed.
 */

import * as Ramose from "./future.ts";
import { orgCatalog } from "./org.ts";

export default Ramose.Server("Atoll", {
  // The root graph's catalog. The root is its own parent — the one graph
  // declared in config rather than as a row in some parent.
  root: orgCatalog,

  // The base case: these subs bypass every function. Recovery and bootstrap
  // only — this is the entire authority that comes from config.
  admins: ["operator:tyler"], // env.OPERATOR_SUB in a real deploy

  // Who attests claims. The engine verifies; functions decide what claims mean.
  auth: {
    issuer: "https://auth.atoll.example",
    audience: "atoll",
    jwks: "https://auth.atoll.example/.well-known/jwks.json",
  },
});
