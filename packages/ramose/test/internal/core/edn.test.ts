import { describe, expect, test } from "bun:test";
import { EdnConst, EdnList, printEdn, readEdn } from "../../../src/internal/core/query/edn.ts";
import { parseQuery, parsePullPattern } from "../../../src/internal/core/query/parse.ts";
import { type PullPattern } from "../../../src/internal/core/query/ast.ts";
import { ValueTag } from "../../../src/internal/core/datom.ts";

describe("edn reader", () => {
  test("atoms and collections", () => {
    expect(readEdn("42")).toBe(42);
    expect(readEdn("-1.5e3")).toBe(-1500);
    expect(readEdn("true")).toBe(true);
    expect(readEdn("nil")).toBeNull();
    expect(readEdn(":foo/bar")).toBe(":foo/bar");
    expect(readEdn("?x")).toBe("?x");
    expect(readEdn('"hi \\"there\\"\\n"')).toBe('hi "there"\n');
    expect(readEdn("[1 2, 3]")).toEqual([1, 2, 3]);
    expect(readEdn("(a b)")).toBeInstanceOf(EdnList);
    expect((readEdn("(a b)") as EdnList).items).toEqual(["a", "b"]);
    expect(readEdn("#{1 2}")).toEqual(new Set([1, 2]));
    expect(readEdn("{:a 1 :b [2]}")).toEqual({ ":a": 1, ":b": [2] });
    expect((readEdn('#inst "2020-01-01T00:00:00Z"') as Date).getTime()).toBe(Date.UTC(2020, 0, 1));
    expect(readEdn('#uuid "123E4567-E89B-12D3-A456-426614174000"')).toEqual({ vt: ValueTag.Uuid, v: "123e4567-e89b-12d3-a456-426614174000" });
    expect(readEdn("[1 ; comment\n 2]")).toEqual([1, 2]);
    expect(readEdn("[#_ 1 2]")).toEqual([2]);

    const c = readEdn('"?notavar"');
    expect(c).toBeInstanceOf(EdnConst);
    expect((c as EdnConst).value).toBe("?notavar");
    expect(() => readEdn("[1 2")).toThrow();
    expect(() => readEdn("1 2")).toThrow();
  });

  test("printEdn round trips simple forms", () => {
    const src = `[:find ?e (count ?x) :where [?e :a/b "str"] [(> ?x 5)]]`;
    expect(readEdn(printEdn(readEdn(src)))).toEqual(readEdn(src));
  });
});

describe("query parser", () => {
  test("map and vector forms, all clause kinds", () => {
    const q = parseQuery(`{:find [?e (pull ?e [*]) (count ?x)] :in [$ ?a [?b ...] [[?c ?d]] [?t1 ?t2]] :with [?w] :where [[?e :a/b ?a] [(> ?x 5)] [(+ ?x 1) ?y] (not [?e :x/y _]) (or-join [?e] [?e :p 1] (and [?e :q ?z] [?z :r 2]))]}`);
    expect(q.find.kind).toBe("rel");
    expect(q.in.map((i) => i.kind)).toEqual(["src", "scalar", "coll", "rel", "tuple"]);
    expect(q.with).toEqual(["?w"]);
    expect(q.where.map((c) => c.kind)).toEqual(["pattern", "pred", "fn", "not", "or"]);
    const v = parseQuery(`[:find ?e . :where [?e :a/b]]`);
    expect(v.find.kind).toBe("scalar");
    expect(parseQuery(`[:find [?e ...] :where [?e :a/b]]`).find.kind).toBe("coll");
    expect(parseQuery(`[:find [?e ?f] :where [?e :a/b ?f]]`).find.kind).toBe("tuple");
    expect(parseQuery({ find: ["?e"], where: [["?e", ":a/b", { const: "?literal" }]] }).where[0]).toMatchObject({ kind: "pattern", v: { kind: "const", value: "?literal" } });
    expect(() => parseQuery(`[:where [?e :a]]`)).toThrow();
    expect(() => parseQuery(`[:find ?e :keys a b :where [?e :a]]`)).toThrow();
  });

  test("pull patterns", () => {
    const p = parsePullPattern(`[* :a/b (:a/c :as "c" :limit 2) {:a/d [:x]} {:a/e ...} {:a/f 3} :a/_g (limit :a/h nil) (default :a/i 0)]`);
    expect(p[0].kind).toBe("wildcard");
    expect(p[2]).toMatchObject({ attr: ":a/c", as: "c", limit: 2 });
    expect(p[3]).toMatchObject({ attr: ":a/d", sub: [{ kind: "attr", attr: ":x", reverse: false }] });
    expect(p[4]).toMatchObject({ attr: ":a/e", recursion: "..." });
    expect(p[5]).toMatchObject({ attr: ":a/f", recursion: 3 });
    expect(p[6]).toMatchObject({ attr: ":a/g", reverse: true });
    expect(p[7]).toMatchObject({ attr: ":a/h", limit: null });
    expect(p[8]).toMatchObject({ attr: ":a/i", default: 0 });
  });

  test("already-lowered pull specs pass through without mutating the caller's", () => {
    const spec = { kind: "attr" as const, attr: ":a/b", reverse: false, sub: [":a/c"] as unknown as PullPattern };
    const [out] = parsePullPattern([spec]);
    expect(out).not.toBe(spec);
    expect(out).toMatchObject({ attr: ":a/b", sub: [{ kind: "attr", attr: ":a/c", reverse: false }] });
    expect(spec.sub).toEqual([":a/c"] as unknown as PullPattern);
  });
});
