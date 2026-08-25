/**
 * An app trait (#313): a reusable bundle of fields + operations, defined once
 * and composed by entities in *different catalogs* — `Issue` in the workspace
 * catalog and `Ws` in the org catalog both carry `:taggable/tags`, the same
 * attribute ident everywhere.
 *
 * Cross-catalog note: the shared ident buys polymorphic queries *within* one
 * graph (`Query.from(Taggable)` sees issues and anything else taggable in
 * that graph). Across graphs it buys portability — the same UI facet and the
 * same operations work in both — but nothing is shared at runtime; each graph
 * is its own database.
 */

import { Schema } from "ramose/effect";
import * as Ramose from "./future.ts";

export const Taggable = Ramose.Trait("taggable", {
  tags: Ramose.string().many(),
});

/**
 * Trait-scoped operations: `on: Taggable` makes these callable on any
 * composer's rows — one operation, not one per entity kind.
 *
 * ergonomics: #313's open question, still open here. These live beside the
 * trait and every catalog must (a) register them in `defineOperations` and
 * (b) arm them in its policy. Rule 7 says the trait value could carry its
 * operations (and a default policy arm) itself, harvested at assembly:
 *
 *   Ramose.Trait("taggable", { tags: ... }, { operations: { addTagOp, ... } })
 *
 * That would delete two lines from every composing catalog — at the cost of a
 * trait author deciding policy defaults for graphs they've never seen. Try
 * both spellings.
 */
export const addTagOp = Ramose.Operation(
  "taggable/add-tag",
  {
    on: Taggable,
    input: Schema.Struct({ tag: Schema.String }),
    doc: "Add a tag to any taggable row",
  },
  (op, input) => {
    op.set(op.self, Taggable.tags, input.tag);
  },
);

export const removeTagOp = Ramose.Operation(
  "taggable/remove-tag",
  {
    on: Taggable,
    input: Schema.Struct({ tag: Schema.String }),
    doc: "Remove a tag from any taggable row",
  },
  (op, input) => {
    op.remove(op.self, Taggable.tags, input.tag);
  },
);
