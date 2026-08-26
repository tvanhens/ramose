/**
 * JSON-only values admitted in IR literals and claim maps.
 * Non-JSON values (functions, symbols, bigint, `NaN`, infinities) are
 * rejected by the structural decoder (#357).
 */

export type JsonScalar = string | number | boolean | null;

export type JsonValue =
  | JsonScalar
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
