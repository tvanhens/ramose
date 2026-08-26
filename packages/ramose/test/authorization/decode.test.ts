import { describe, expect, test } from "bun:test";
import { tryDecodeInstalledDocument, tryDecodeTemplateDocument } from "../../src/internal/authorization/schema.ts";
import { compileTaggablePolicy, installTaggablePolicy } from "./fixtures.ts";

const template = () => structuredClone(compileTaggablePolicy());

describe("structural decoder", () => {
  test("accepts a valid template", () => {
    const result = tryDecodeTemplateDocument(template());
    expect(result._tag).toBe("Right");
  });

  test("rejects functions", () => {
    const doc = template() as unknown as Record<string, unknown>;
    (doc as { extra?: unknown }).extra = () => true;
    const result = tryDecodeTemplateDocument(doc);
    expect(result._tag).toBe("Left");
  });

  test("rejects symbols", () => {
    const doc = template() as unknown as Record<string, unknown>;
    (doc as { extra?: unknown }).extra = Symbol("x");
    expect(tryDecodeTemplateDocument(doc)._tag).toBe("Left");
  });

  test("rejects bigint", () => {
    const doc = template() as unknown as Record<string, unknown>;
    (doc as { extra?: unknown }).extra = 1n;
    expect(tryDecodeTemplateDocument(doc)._tag).toBe("Left");
  });

  test("rejects NaN and infinities", () => {
    const doc = template() as unknown as Record<string, unknown>;
    (doc as { extra?: unknown }).extra = Number.NaN;
    expect(tryDecodeTemplateDocument(doc)._tag).toBe("Left");
    (doc as { extra?: unknown }).extra = Number.POSITIVE_INFINITY;
    expect(tryDecodeTemplateDocument(doc)._tag).toBe("Left");
  });

  test("rejects cycles", () => {
    const doc = template() as unknown as Record<string, unknown>;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    (doc as { extra?: unknown }).extra = cycle;
    expect(tryDecodeTemplateDocument(doc)._tag).toBe("Left");
  });

  test("rejects prototypes", () => {
    const doc = Object.assign(Object.create({ hidden: true }), template());
    expect(tryDecodeTemplateDocument(doc)._tag).toBe("Left");
  });

  test("rejects unknown keys", () => {
    const doc = template() as unknown as Record<string, unknown>;
    doc.unexpected = "x";
    expect(tryDecodeTemplateDocument(doc)._tag).toBe("Left");
  });

  test("rejects the wrong version discriminator", () => {
    const doc = template();
    (doc as { version: string }).version = "ramose.policy.template.0";
    expect(tryDecodeTemplateDocument(doc)._tag).toBe("Left");
  });

  test("rejects a template as installed IR", () => {
    expect(tryDecodeInstalledDocument(template())._tag).toBe("Left");
  });

  test("rejects malformed decision maps", () => {
    const doc = template();
    (doc.decisions.rows as Record<string, unknown>).issue = { allow: "owns" };
    expect(tryDecodeTemplateDocument(doc)._tag).toBe("Left");
  });

  test("accepts a valid installed document structurally", () => {
    const installed = JSON.parse(JSON.stringify(installTaggablePolicy()));
    expect(tryDecodeInstalledDocument(installed)._tag).toBe("Right");
  });
});
