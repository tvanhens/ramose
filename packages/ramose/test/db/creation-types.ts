/** Compile-time contract for creation defaults and fixed binding values. */

// @effect-diagnostics floatingEffect:off

import {
  Entity,
  Schema,
  Trait,
  txBuilder,
  string,
} from "../../src/db/internal.ts";

const Bound = Trait("typedBound", {
  catalog: string(),
  label: string({ default: () => "field" }),
  compositionLabel: string(),
}, {
  bind: (catalog) => ({
    values: { catalog: catalog.key },
    defaults: { compositionLabel: () => "composition" },
    dependencies: [catalog],
  }),
});

const child = { key: "child", schema: Schema({}) };
const Node = Entity("typedNode", { title: string() }, { traits: [Bound(child)] });
const Catalog = Schema({ typedNode: Node });
const tx = txBuilder(Catalog);

tx.put(Node, { title: "ok" });
tx.put(Node, { title: "ok", label: "explicit", compositionLabel: "explicit" });
tx.update(Node, 1, { title: "changed" });

// @ts-expect-error fixed binding values are absent from create input
tx.put(Node, { title: "no", catalog: "forged" });
// @ts-expect-error fixed binding values are absent from update input
tx.update(Node, 1, { catalog: "forged" });
// @ts-expect-error fixed binding values cannot be mutated through field writes
tx.set(1, Node.catalog, "forged");
// @ts-expect-error raw fixed idents cannot bypass the field marker
tx.set(1, ":typedBound/catalog", "forged");
// @ts-expect-error field defaults must return the field value type
string({ default: () => 42 });
Trait("badFixed", { value: string() }, {
  // @ts-expect-error fixed binding values must match their field type
  bind: () => ({ values: { value: 42 } }),
});
