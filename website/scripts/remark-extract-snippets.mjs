// Remark plugin: any fence whose title cites a repo file is replaced with
// the extract. A mismatch against a non-empty body fails the build.

import { extractTitle, bodyMatchesExtract } from "./lib/snippets.mjs";

const visit = (node, fn) => {
  fn(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) visit(child, fn);
  }
};

const titleOf = (node) => {
  const meta = node.meta ?? "";
  return meta.match(/title="([^"]+)"/)?.[1] ?? null;
};

export default function remarkExtractSnippets() {
  return (tree, file) => {
    const page = file?.history?.[0] ?? file?.path ?? "unknown";
    const errors = [];
    visit(tree, (node) => {
      if (node.type !== "code") return;
      const title = titleOf(node);
      if (!title) return;
      const got = extractTitle(title);
      // Known-deleted client files (shrink-only allowlist). Leave the
      // fence as written; do not fail the site build.
      if (got.skipped) return;
      if (!got.extracted) return;
      if (!got.ok) {
        errors.push(`${page}: ${got.error}`);
        return;
      }
      const match = bodyMatchesExtract(node.value ?? "", got.text);
      if (!match.ok) {
        errors.push(
          `${page}: block titled ${got.labels.join(" · ")} has ${match.missing.length} line(s) not in the extract: ${match.missing.slice(0, 3).join(" ⏎ ")}`,
        );
        return;
      }
      node.value = got.text;
    });
    if (errors.length) {
      const err = new Error(
        `docs snippet extract failed:\n  ${errors.join("\n  ")}`,
      );
      err.name = "DocsSnippetError";
      throw err;
    }
  };
}
