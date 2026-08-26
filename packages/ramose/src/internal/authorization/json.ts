/** JSON-only values and a fail-closed walker used before Effect Schema decode. */

export type JsonLiteral = string | number | boolean | null;

export type JsonValue =
  | JsonLiteral
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export class JsonOnlyError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.name = "JsonOnlyError";
    this.path = path;
  }
}

const protoOf = (value: object): object | null => Object.getPrototypeOf(value);

/** True for a finite JSON number. */
export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Reject functions, symbols, prototypes, cycles, bigint, NaN, infinities,
 * `undefined`, and any other non-JSON value. Arrays and plain objects only.
 */
export const assertJsonOnly = (
  value: unknown,
  path = "$",
  seen: WeakSet<object> = new WeakSet(),
): void => {
  if (value === null) return;
  const t = typeof value;
  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new JsonOnlyError(path, `non-finite number at ${path}`);
    }
    return;
  }
  if (t === "bigint") throw new JsonOnlyError(path, `bigint at ${path}`);
  if (t === "function") throw new JsonOnlyError(path, `function at ${path}`);
  if (t === "symbol") throw new JsonOnlyError(path, `symbol at ${path}`);
  if (t === "undefined") throw new JsonOnlyError(path, `undefined at ${path}`);
  if (t !== "object") throw new JsonOnlyError(path, `non-JSON value at ${path}`);

  const obj = value as object;
  if (seen.has(obj)) throw new JsonOnlyError(path, `cycle at ${path}`);
  seen.add(obj);

  try {
    if (Array.isArray(value)) {
      const proto = protoOf(value);
      if (proto !== Array.prototype && proto !== null) {
        throw new JsonOnlyError(path, `array with unexpected prototype at ${path}`);
      }
      for (let i = 0; i < value.length; i++) {
        assertJsonOnly(value[i], `${path}[${i}]`, seen);
      }
      return;
    }

    const proto = protoOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new JsonOnlyError(path, `object with unexpected prototype at ${path}`);
    }
    if (Object.getOwnPropertySymbols(obj).length > 0) {
      throw new JsonOnlyError(path, `symbol key at ${path}`);
    }
    for (const key of Object.keys(obj)) {
      assertJsonOnly((obj as Record<string, unknown>)[key], `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(obj);
  }
};

export const isJsonLiteral = (value: unknown): value is JsonLiteral =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  isFiniteNumber(value);
