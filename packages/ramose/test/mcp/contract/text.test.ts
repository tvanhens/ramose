/**
 * The derived text representation (#485).
 *
 * The claim under test is narrow and load-bearing: the text `content` cannot
 * carry semantics the structured result does not. These tests hold it to that
 * three ways — every token in the text comes from the structured result, the
 * rendering is a total function of that result alone, and changing the result
 * changes the text.
 */

import { describe, expect, test } from "bun:test";
import {
  MAX_TEXT_LINES,
  renderResultText,
  toolResult,
} from "../../../src/mcp/contract/index.ts";
import {
  describeCard,
  describeListing,
  mutateResult,
  queryResult,
} from "./examples.ts";

const scalars = (value: unknown, found: string[] = []): readonly string[] => {
  if (Array.isArray(value)) {
    for (const child of value) scalars(child, found);
    return found;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      scalars(child, found);
    }
    return found;
  }
  found.push(String(value));
  return found;
};

describe("renderResultText", () => {
  test("renders the describe listing as an indented outline", () => {
    expect(renderResultText(describeListing as never)).toBe(
      [
        "at:",
        "  - acme",
        "  - support",
        "catalogToken: cat_9dQwErTyUiOp-1",
        "items:",
        "  -",
        "    at:",
        "      - acme",
        "      - support",
        "    description: Close an open issue with a stated reason.",
        "    kind: operation",
        "    ref:",
        "      name: close",
        "      owner:",
        "        kind: entity",
        "        name: issue",
        "      version: ov_Hx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8",
        "    title: Close issue",
        "  -",
        "    at:",
        "      - acme",
        "      - support",
        "    kind: entity",
        "    ref:",
        "      kind: entity",
        "      name: issue",
        "    title: Issue",
        "ok: true",
        "page:",
        "  cursor: cur_Zm9vYmFy-2",
        "  hasMore: true",
        "  limit: 25",
        "  returned: 2",
        "result: listing",
      ].join("\n"),
    );
  });

  test("renders the mutate result", () => {
    expect(renderResultText(mutateResult as never)).toBe(
      [
        "at:",
        "  - acme",
        "  - support",
        "ok: true",
        "output:",
        "  closed: true",
        "receipt:",
        "  invocationId: 01K5Q0R7VYX3S6ZB2A9C4D8E1F",
        "  status: completed",
      ].join("\n"),
    );
  });

  test("every scalar and member name in the text comes from the result", () => {
    for (const result of [describeListing, describeCard, queryResult, mutateResult]) {
      const text = renderResultText(result as never);
      const available = new Set(scalars(result));
      for (const line of text.split("\n")) {
        const trimmed = line.replace(/^[\s-]+/, "");
        if (trimmed === "" || trimmed === "[]" || trimmed === "{}") continue;
        const separator = trimmed.indexOf(": ");
        const tokens = separator === -1
          ? [trimmed.replace(/:$/, "")]
          : [trimmed.slice(0, separator), trimmed.slice(separator + 2)];
        for (const token of tokens) {
          expect({ token, known: available.has(token) })
            .toEqual({ token, known: true });
        }
      }
    }
  });

  test("is a pure function of the structured result", () => {
    for (const result of [describeListing, describeCard, queryResult, mutateResult]) {
      const copy = JSON.parse(JSON.stringify(result)) as never;
      expect(renderResultText(copy)).toBe(renderResultText(result as never));
    }
  });

  test("does not depend on the order members were built in", () => {
    const built = { ok: true, at: [], catalogToken: "cat_a", rows: [] };
    const shuffled = { rows: [], catalogToken: "cat_a", at: [], ok: true };
    expect(renderResultText(shuffled as never))
      .toBe(renderResultText(built as never));
  });

  test("changing the structured result changes the text", () => {
    const changed = {
      ...(mutateResult as { readonly [key: string]: unknown }),
      receipt: { invocationId: "01K5Q0R7VYX3S6ZB2A9C4D8E1F", status: "rejected" },
    };
    expect(renderResultText(changed as never))
      .not.toBe(renderResultText(mutateResult as never));
  });

  test("renders empty collections rather than dropping them", () => {
    expect(renderResultText({ items: [], page: {} } as never))
      .toBe("items: []\npage: {}");
  });

  test("says so when it stops early: the text never truncates silently", () => {
    const long = Object.fromEntries(
      Array.from({ length: MAX_TEXT_LINES + 10 }, (_, i) => [`k${i}`, i]),
    );
    const text = renderResultText(long as never);
    expect(text.split("\n").length).toBe(MAX_TEXT_LINES + 1);
    expect(text.split("\n").at(-1)).toContain(
      "more lines omitted; structuredContent is complete",
    );
  });
});

describe("toolResult", () => {
  test("derives the text block from the structured result it carries", () => {
    const result = toolResult(queryResult as never);
    expect(result.structuredContent).toBe(queryResult as never);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(renderResultText(queryResult as never));
    expect(result.isError).toBe(false);
  });

  test("offers no way to supply text that could disagree", () => {
    // The only argument is the structured result. Two calls with the same
    // result always produce the same text.
    expect(toolResult(queryResult as never).content[0].text)
      .toBe(toolResult(queryResult as never).content[0].text);
  });
});
