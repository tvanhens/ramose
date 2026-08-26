/** Deterministic JSON for IR identity and wire form. */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const next = value[key];
      if (next !== undefined) out[key] = canonicalize(next);
    }
    return out;
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

/** FNV-1a 32-bit, hex. Stable across runtimes we ship. */
export const fnv1a = (text: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const ruleIdOf = (
  focus: { readonly kind: string; readonly ns: string },
  expr: unknown,
): string => `r:${focus.kind}:${focus.ns}:${fnv1a(canonicalJson(expr))}`;
