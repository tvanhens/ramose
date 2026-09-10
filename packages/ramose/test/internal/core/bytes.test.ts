import { describe, expect, test } from "bun:test";
import { ByteReader, ByteWriter, fromHex, toHex } from "../../../src/internal/core/bytes.ts";

describe("binary boundaries", () => {
  test("a zero-capacity writer grows and preserves bytes", () => {
    const writer = new ByteWriter(0);
    writer.u8(42);
    writer.str("héllo 😀");
    const reader = new ByteReader(writer.finish());
    expect(reader.u8()).toBe(42);
    expect(reader.str()).toBe("héllo 😀");
    expect(reader.remaining).toBe(0);
  });

  test.each([-1, 0.5, NaN, Infinity])("rejects invalid capacity, position, and length %s", (value) => {
    expect(() => new ByteWriter(value)).toThrow(RangeError);
    expect(() => new ByteReader(new Uint8Array(8), value)).toThrow(RangeError);
    const writer = new ByteWriter();
    expect(() => writer.reserve(value)).toThrow(RangeError);
    expect(writer.pos).toBe(0);
    const reader = new ByteReader(new Uint8Array(8));
    expect(() => reader.bytes(value)).toThrow(RangeError);
    expect(reader.pos).toBe(0);
  });

  test("rejects overflowing and truncated varints", () => {
    const overflow = Uint8Array.of(128, 128, 128, 128, 128, 128, 128, 16);
    expect(() => new ByteReader(overflow).uvar()).toThrow(/safe integer/);
    const writer = new ByteWriter();
    writer.u8(128);
    writer.uvar(2 ** 47);
    expect(() => new ByteReader(writer.finish()).svar()).toThrow(/safe integer/);
    expect(() => new ByteReader(Uint8Array.of(128)).uvar()).toThrow(/EOF/);
  });

  test("rejects malformed UTF-8 and truncated byte strings", () => {
    expect(() => new ByteReader(Uint8Array.of(1, 255)).str()).toThrow();
    expect(() => new ByteReader(Uint8Array.of(2, 65)).str()).toThrow(/EOF/);
  });

  test.each(["0", "abc", "gg", "0g", " 0", "-1"])("rejects malformed hex %s", (value) => {
    expect(() => fromHex(value)).toThrow(TypeError);
  });

  test("hex round-trips every byte and accepts either case", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(fromHex(toHex(bytes).toUpperCase())).toEqual(bytes);
    expect(fromHex("")).toEqual(new Uint8Array());
  });
});
