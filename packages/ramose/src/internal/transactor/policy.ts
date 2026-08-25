/**
 * `RAMOSE_POLICY` → a `CompiledPolicy`, parsed once per isolate.
 *
 * Fail closed: a policy that is set but malformed leaves `policy` undefined
 * with `configured: true`, which every caller must read as "deny".
 */

import { type CompiledPolicy, type Principal, componentLogger, parsePolicy } from "../core/index.ts";
import type { RamoseEnv } from "./env.ts";

export interface PolicyState {
  /** `RAMOSE_POLICY` is set — enforcement is armed even if parsing failed */
  readonly configured: boolean;
  readonly policy?: CompiledPolicy;
  /** why the policy is unusable (parse failure) */
  readonly error?: string;
}

const OPEN: PolicyState = { configured: false };
const cache = new Map<string, PolicyState>();
const log = componentLogger("peer");

/** Parse (and memoize) the compiled policy in `env`. */
export function policyOf(env: Pick<RamoseEnv, "RAMOSE_POLICY">): PolicyState {
  const raw = env.RAMOSE_POLICY;
  if (!raw) return OPEN;
  const hit = cache.get(raw);
  if (hit) return hit;
  let state: PolicyState;
  try {
    state = { configured: true, policy: parsePolicy(JSON.parse(raw)) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("policy.malformed", { error });
    state = { configured: true, error };
  }
  if (cache.size > 8) cache.clear();
  cache.set(raw, state);
  return state;
}

/** No attribute has a rule and no superuser — every op is denied. */
const DENY_ALL: CompiledPolicy = { version: 1, principal: ":db/ident", classes: ["admin"], attrs: {} };

/**
 * The policy the writer enforces. A configured-but-malformed policy denies
 * every non-admin write rather than falling open.
 */
export function enforcedPolicy(env: Pick<RamoseEnv, "RAMOSE_POLICY">): CompiledPolicy | undefined {
  const st = policyOf(env);
  if (!st.configured) return undefined;
  return st.policy ?? DENY_ALL;
}

/** Test hook: forget every parsed policy. */
export function clearPolicyCache(): void {
  cache.clear();
}

/**
 * The Worker-verified `Principal` off the wire. Trusted metadata: the DO is
 * only reachable behind the internal secret, so this only re-shapes the JSON.
 */
export function asPrincipal(x: unknown): Principal | undefined {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return undefined;
  const o = x as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== "service" && kind !== "user" && kind !== "anonymous") return undefined;
  if (typeof o.class !== "string" || typeof o.db !== "string") return undefined;
  const claims = typeof o.claims === "object" && o.claims !== null ? (o.claims as Principal["claims"]) : {};
  const classes = Array.isArray(o.classes)
    ? o.classes.filter((c): c is string => typeof c === "string")
    : undefined;
  return {
    kind,
    class: o.class,
    db: o.db,
    claims,
    ...(typeof o.sub === "string" ? { sub: o.sub } : {}),
    ...(typeof o.eid === "number" ? { eid: o.eid } : {}),
    ...(classes !== undefined && classes.length > 0 ? { classes } : {}),
  };
}
