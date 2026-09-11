import { expect, test } from "bun:test";
import { fromJson, parseJson, stringifyJson, toJson } from "../../../src/internal/core/json.ts";

test("JSON preserves own prototype-named fields alongside tagged values", () => {
  const input = JSON.parse('{"__proto__":{"visible":true},"constructor":"data","nested":{"__proto__":42}}');
  input.date = new Date("2026-01-01T00:00:00Z");
  input.bytes = Uint8Array.of(0, 128, 255);
  for (const output of [fromJson(toJson(input)), parseJson(stringifyJson(input))]) {
    expect(output).toEqual(input);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.hasOwn(output as object, "__proto__")).toBe(true);
  }
});
