/**
 * Pure basis-cache policy. Replica fetches, invalidation, min-T retries, and
 * hint-selected Durable Object behavior are exercised by `test/local`.
 */
import { describe, expect, test } from "bun:test";
import {
  BASIS_SAFETY_TTL_MS,
  BASIS_TTL_MS,
  basisCacheDecision,
  basisCacheEnabled,
  cacheModeOf,
  coloHint,
  effectiveBasisMinT,
  hintOf,
  shouldReplaceCachedBasis,
  wantsBasisCache,
} from "../../src/worker/peer.ts";

const req = (
  headers: Record<string, string> = {},
  cf: Record<string, string> = { continent: "NA", colo: "IAD" },
): Request => {
  const request = new Request("https://ramose.example/db/demo/query", {
    method: "POST",
    headers,
  });
  (request as Request & { cf: Record<string, string> }).cf = cf;
  return request;
};

describe("basis-cache request policy", () => {
  test("cache enablement is deployment-owned and public headers are ignored", () => {
    expect(wantsBasisCache(req())).toBe(true);
    expect(wantsBasisCache(req({ "x-ramose-cache-basis": "0" }))).toBe(true);
    expect(wantsBasisCache(req(), { RAMOSE_CACHE_BASIS: "0" })).toBe(false);
    expect(wantsBasisCache(req({ "x-ramose-cache-basis": "1" }), {
      RAMOSE_CACHE_BASIS: "0",
    })).toBe(false);
    expect(basisCacheEnabled(req(), undefined, { bypassCache: true })).toBe(false);
  });

  test("cache mode selects ttl by default and ignores public headers", () => {
    expect(cacheModeOf(req())).toBe("ttl");
    expect(cacheModeOf(req(), { RAMOSE_CACHE_MODE: "peer" })).toBe("peer");
    expect(cacheModeOf(req({ "x-ramose-cache-mode": "ttl" }), {
      RAMOSE_CACHE_MODE: "peer",
    })).toBe("peer");
    expect(cacheModeOf(req({ "x-ramose-cache-mode": "peer" }))).toBe("ttl");
    expect(cacheModeOf(req({ "x-ramose-cache-mode": "unknown" }))).toBe("ttl");
  });

  test("trusted minimum-basis input composes with an authoritative fence", () => {
    expect(effectiveBasisMinT(undefined, undefined)).toBeUndefined();
    expect(effectiveBasisMinT(7, undefined)).toBe(7);
    expect(effectiveBasisMinT(undefined, 8)).toBe(8);
    expect(effectiveBasisMinT(9, 8)).toBe(9);
  });
});

describe("basis-cache state policy", () => {
  const now = 1_000_000;

  test("cache-off, miss, hit, and min-T decisions are deterministic", () => {
    const fresh = { t: 5, at: now - 1 };
    expect(basisCacheDecision(false, "ttl", now, fresh, undefined)).toBe("off");
    expect(basisCacheDecision(true, "ttl", now, undefined, undefined)).toBe("miss");
    expect(basisCacheDecision(true, "ttl", now, fresh, undefined)).toBe("hit");
    expect(basisCacheDecision(true, "ttl", now, fresh, 5)).toBe("hit");
    expect(basisCacheDecision(true, "ttl", now, fresh, 6)).toBe("min-t");
  });

  test("ttl and peer expiry use their respective boundaries", () => {
    expect(basisCacheDecision(
      true,
      "ttl",
      now,
      { t: 1, at: now - BASIS_TTL_MS + 1 },
      undefined,
    )).toBe("hit");
    expect(basisCacheDecision(
      true,
      "ttl",
      now,
      { t: 1, at: now - BASIS_TTL_MS },
      undefined,
    )).toBe("expired");
    expect(basisCacheDecision(
      true,
      "peer",
      now,
      { t: 1, at: now - BASIS_TTL_MS },
      undefined,
    )).toBe("hit");
    expect(basisCacheDecision(
      true,
      "peer",
      now,
      { t: 1, at: now - BASIS_SAFETY_TTL_MS },
      undefined,
    )).toBe("expired");
  });

  test("a late stale result cannot replace a newer cached basis", () => {
    expect(shouldReplaceCachedBasis(undefined, 5)).toBe(true);
    expect(shouldReplaceCachedBasis(5, 5)).toBe(true);
    expect(shouldReplaceCachedBasis(5, 6)).toBe(true);
    expect(shouldReplaceCachedBasis(6, 5)).toBe(false);
  });
});

describe("colo to replica hint policy", () => {
  test("known eastern and western colos map to their regional hints", () => {
    for (const colo of ["IAD", "EWR", "ATL", "ORD", "MIA", "YYZ"]) {
      expect(coloHint(colo)).toBe("enam");
    }
    for (const colo of ["SJC", "LAX", "SEA", "SFO", "DEN", "YVR"]) {
      expect(coloHint(colo)).toBe("wnam");
    }
    expect(coloHint("XYZ")).toBeUndefined();
    expect(coloHint(undefined)).toBeUndefined();
  });

  test("deployment config wins and public headers cannot select a replica", () => {
    expect(hintOf(req())).toBe("enam");
    expect(hintOf(req({}, { continent: "NA", colo: "SJC" }))).toBe("wnam");
    expect(hintOf(req({}, { continent: "NA" }))).toBe("wnam");
    expect(hintOf(req({ "x-ramose-replica-hint": "continent" }))).toBe("enam");
    expect(hintOf(req(), { RAMOSE_REPLICA_HINT: "continent" })).toBe("wnam");
    expect(hintOf(req({ "x-ramose-replica-hint": "enam" }))).toBe("enam");
    expect(hintOf(req({ "x-ramose-replica-hint": "auto" }))).toBe("enam");
    expect(hintOf(req({ "x-ramose-replica-hint": "bogus" }))).toBe("enam");
    expect(hintOf(req({ "x-ramose-replica-hint": "wnam" }), {
      RAMOSE_REPLICA_HINT: "auto",
    })).toBe("enam");
    expect(hintOf(req({}, { continent: "EU", colo: "LHR" }))).toBe("weur");
  });
});
