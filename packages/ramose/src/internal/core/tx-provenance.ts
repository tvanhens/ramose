/** Internal provenance for the protected type assertion emitted by typed put. */

export const ENGINE_TYPE_ASSERTION = Symbol("ramose.engineTypeAssertion");

export type EngineTypeAssertion = {
  readonly [ENGINE_TYPE_ASSERTION]?: true;
};

/** Mark a typed-put map without changing its enumerable/wire-visible shape. */
export const markEngineTypeAssertion = <T extends object>(value: T): T => {
  Object.defineProperty(value, ENGINE_TYPE_ASSERTION, { value: true });
  return value;
};

/**
 * Restore typed-put provenance after Durable Object RPC structured cloning.
 * Call only at the trusted authoritative-operation boundary; raw HTTP tx data
 * must never pass through this function.
 */
export const restoreEngineTypeAssertions = (txData: readonly unknown[]): void => {
  for (const item of txData) {
    if (
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      Object.hasOwn(item, ":ramose/type")
    ) {
      markEngineTypeAssertion(item);
    }
  }
};
