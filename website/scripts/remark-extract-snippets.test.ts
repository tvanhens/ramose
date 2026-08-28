import { describe, expect, test } from "bun:test";
import remarkExtractSnippets from "./remark-extract-snippets.mjs";

const run = (nodes: object[]) => {
  const plugin = remarkExtractSnippets();
  const tree = { type: "root", children: nodes };
  plugin(tree, { path: "index.mdx" });
  return tree;
};

describe("remarkExtractSnippets", () => {
  test("allowlisted missing citation leaves the fence and does not throw", () => {
    const fence = {
      type: "code",
      lang: "ts",
      meta: 'title="examples/todos/src/App.tsx#todo-list"',
      value: "const tasks = useQuery(taskQuery);",
    };
    const tree = run([fence]);
    expect((tree.children[0] as { value: string }).value).toBe(
      "const tasks = useQuery(taskQuery);",
    );
  });

  test("non-allowlisted missing citation fails the build", () => {
    const fence = {
      type: "code",
      lang: "ts",
      meta: 'title="examples/does-not-exist/Nope.tsx#x"',
      value: "export const boxed = 1;",
    };
    expect(() => run([fence])).toThrow("cited file does not exist");
  });
});
