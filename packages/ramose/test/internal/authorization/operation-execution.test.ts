import { describe, expect, test } from "bun:test";
import { immutableOperationClaims } from "../../../src/internal/authorization/operation-execution.ts";

describe("operation principal isolation", () => {
  test("body-visible claims are a deeply frozen copy", () => {
    const source = { teams: ["member"] };
    const claims = immutableOperationClaims(source);
    const teams = claims.teams as readonly string[];

    expect(claims).not.toBe(source);
    expect(teams).not.toBe(source.teams);
    expect(Object.isFrozen(claims)).toBe(true);
    expect(Object.isFrozen(teams)).toBe(true);
    expect(() => (teams as string[]).push("admin")).toThrow();

    source.teams.push("owner");
    expect(teams).toEqual(["member"]);
  });
});
