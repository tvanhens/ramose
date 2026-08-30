import { describe, expect, test } from "bun:test";
import type { AuthConfig } from "../../src/index.ts";
import { classOfRole, ramoseToken } from "../../src/better-auth/index.ts";

const AUTH: AuthConfig = {
  issuer: "test-auth",
  audience: "ramose:test",
  ttl: 900,
};

const POLICY = { classes: ["authenticated", "member", "viewer"] as const };

describe("ramoseToken", () => {
  test("requires the jwt plugin at initialization", () => {
    const plugin = ramoseToken({
      auth: AUTH,
      policy: POLICY,
      classOf: () => "authenticated",
    });

    expect(() =>
      plugin.init?.({ options: { plugins: [] } } as never),
    ).toThrow(/requires Better Auth's jwt plugin/);
  });
});

describe("classOfRole", () => {
  test("owner and admin map to owner; member to member; the rest to viewer", () => {
    expect(classOfRole("owner")).toBe("owner");
    expect(classOfRole("admin")).toBe("owner");
    expect(classOfRole("owner,member")).toBe("owner");
    expect(classOfRole("member")).toBe("member");
    expect(classOfRole("viewer")).toBe("viewer");
    expect(classOfRole("mystery-role")).toBe("viewer");
    expect(classOfRole("")).toBe("viewer");
  });
});
