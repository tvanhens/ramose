import { describe, expect, test } from "bun:test";
import { applyLocalDev, LOCAL_DEV, LOCAL_DEV_ACCOUNT_ID } from "../src/localDev.ts";

describe("applyLocalDev", () => {
  test("fills missing keys and leaves real credentials alone", () => {
    const empty: NodeJS.ProcessEnv = {};
    applyLocalDev(empty);
    expect(empty).toEqual({ ...LOCAL_DEV });
    expect(LOCAL_DEV.CLOUDFLARE_ACCOUNT_ID).toBe(LOCAL_DEV_ACCOUNT_ID);
    expect(LOCAL_DEV_ACCOUNT_ID).toMatch(/^[0-9a-f]{32}$/);

    const pinned: NodeJS.ProcessEnv = {
      CI: "1",
      CLOUDFLARE_ACCOUNT_ID: "ffffffffffffffffffffffffffffffff",
      CLOUDFLARE_API_TOKEN: "real-token",
    };
    applyLocalDev(pinned);
    expect(pinned.CLOUDFLARE_ACCOUNT_ID).toBe("ffffffffffffffffffffffffffffffff");
    expect(pinned.CLOUDFLARE_API_TOKEN).toBe("real-token");
    expect(pinned.ALCHEMY_STATE).toBe("local");
  });
});
