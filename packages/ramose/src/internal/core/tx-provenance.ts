export const ENGINE_TYPE_ASSERTION = Symbol("ramose.engineTypeAssertion");

export type EngineTypeAssertion = {
  readonly [ENGINE_TYPE_ASSERTION]?: true;
};

export const markEngineTypeAssertion = <T extends object>(value: T): T => {
  Object.defineProperty(value, ENGINE_TYPE_ASSERTION, { value: true });
  return value;
};

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
