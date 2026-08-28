import { describe, expect, test } from "bun:test";
import { basisCacheEnabled, effectiveBasisMinT } from "../../src/worker/peer.ts";

const request = (headers: Record<string, string> = {}): Request =>
  new Request("https://ramose.example/db/demo/live", { method: "POST", headers });

describe("basis cache policy", () => {
  test("live authorization can force an authoritative basis", () => {
    const peerCache = request({
      "x-ramose-cache-basis": "1",
      "x-ramose-cache-mode": "peer",
    });
    expect(basisCacheEnabled(peerCache)).toBe(true);
    expect(basisCacheEnabled(peerCache, undefined, { bypassCache: true })).toBe(false);
    expect(
      basisCacheEnabled(request(), { RAMOSE_CACHE_BASIS: "1" }, { bypassCache: true }),
    ).toBe(false);
  });

  test("the authoritative writer t strengthens a caller fence", () => {
    expect(effectiveBasisMinT(undefined, undefined)).toBeUndefined();
    expect(effectiveBasisMinT(7, undefined)).toBe(7);
    expect(effectiveBasisMinT(undefined, 9)).toBe(9);
    expect(effectiveBasisMinT(11, 9)).toBe(11);
    expect(effectiveBasisMinT(7, 9)).toBe(9);
  });
});
