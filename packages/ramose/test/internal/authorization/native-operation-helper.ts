class NativeOperationFormatter {
  readonly #prefix: string;

  constructor(prefix: string) {
    this.#prefix = prefix;
  }

  format(values: readonly string[]): string {
    const unique = [
      ...new Set(values.map((value) => value.trim()).filter(Boolean)),
    ];
    return [this.#prefix, ...unique]
      .map((value) => value.toUpperCase())
      .join(":");
  }
}

const formatter = new NativeOperationFormatter("native");

export const formatNativeOperation = (values: readonly string[]): string =>
  formatter.format(values);
