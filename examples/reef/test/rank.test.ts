import { describe, expect, test } from "bun:test";
import { RANK_GAP, rankAfter, rankAt, rankBetween } from "../src/domain/rank.ts";
import { isWorkspaceSlug, slugify } from "../src/domain/shared.ts";

describe("fractional ranks", () => {
  test("appending walks forward in fixed gaps", () => {
    expect(rankAfter(undefined)).toBe(RANK_GAP);
    expect(rankAfter(RANK_GAP)).toBe(2 * RANK_GAP);
  });

  test("between two neighbours is their midpoint", () => {
    expect(rankBetween(1024, 2048)).toBe(1536);
    expect(rankBetween(undefined, 1024)).toBe(0);
    expect(rankBetween(3072, undefined)).toBe(4096);
    expect(rankBetween(undefined, undefined)).toBe(RANK_GAP);
  });

  test("dropping at an index lands strictly inside the gap", () => {
    const ranks = [1024, 2048, 3072];
    expect(rankAt(ranks, 0)).toBeLessThan(ranks[0]!);
    expect(rankAt(ranks, 1)).toBe(1536);
    expect(rankAt(ranks, 2)).toBe(2560);
    expect(rankAt(ranks, 3)).toBeGreaterThan(ranks[2]!);
  });

  test("halving stays ordered over many midpoint insertions", () => {
    let low = 1024;
    let high = 2048;
    for (let i = 0; i < 40; i++) {
      const mid = rankBetween(low, high);
      expect(mid).toBeGreaterThan(low);
      expect(mid).toBeLessThan(high);
      high = mid;
    }
  });
});

const SLUG_RE_SHAPE = /^[a-z0-9][a-z0-9-]{1,39}$/;

describe("workspace slugs", () => {
  test("slugify produces valid Ramose database names", () => {
    for (const name of ["Coral Team", "  Deep  Sea!  ", "Ops/2026", "élan vital"]) {
      const slug = slugify(name);
      expect(isWorkspaceSlug(slug)).toBe(true);
    }
  });

  test("degenerate names fail the check instead of reaching the peer", () => {
    expect(isWorkspaceSlug(slugify("!!!"))).toBe(false);
    expect(isWorkspaceSlug(slugify("a"))).toBe(false);
  });

  test("slugs that would shadow a deployed path are reserved", () => {

    for (const reserved of ["db", "api"]) {
      expect(SLUG_RE_SHAPE.test(reserved)).toBe(true);
      expect(isWorkspaceSlug(reserved)).toBe(false);
    }

    expect(isWorkspaceSlug("database")).toBe(true);
    expect(isWorkspaceSlug("api-team")).toBe(true);
  });
});
