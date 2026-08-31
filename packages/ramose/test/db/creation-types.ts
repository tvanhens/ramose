// @effect-diagnostics floatingEffect:off

import {
  Entity,
  Field,
  Schema,
  Trait,
  txBuilder,
  string,
  type CodeDefinition,
  type TraitBindingSpec,
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

const child = Schema("child", {});
const Node = Entity("typedNode", { title: string() }, { traits: [Bound(child)] });
const Catalog = Schema("typed-nodes", { typedNode: Node });
const tx = txBuilder(Catalog);

tx.put(Node, { title: "ok" });
tx.put(Node, { title: "ok", label: "explicit", compositionLabel: "explicit" });
tx.update(Node, 1, { title: "changed" });

// @ts-expect-error
tx.put(Node, { title: "no", catalog: "forged" });
// @ts-expect-error
tx.update(Node, 1, { catalog: "forged" });
// @ts-expect-error
tx.set(1, Node.catalog, "forged");
// @ts-expect-error
tx.set(1, ":typedBound/catalog", "forged");
// @ts-expect-error
string({ default: () => 42 });
Trait("badFixed", { value: string() }, {
  // @ts-expect-error
  bind: () => ({ values: { value: 42 } }),
});

const defaultedScalar = string({ default: () => "scalar" });
// @ts-expect-error
Field.many(defaultedScalar);
Field.many(defaultedScalar, { default: () => ["many"] });

const annotatedFields = { catalog: string(), label: string() };
const widenedBind: (
  definition: CodeDefinition,
) => TraitBindingSpec<typeof annotatedFields> = (definition) => ({
  values: { catalog: definition.key },
});
const Widened = Trait("widenedBinding", annotatedFields, { bind: widenedBind });
const WidenedEntity = Entity("widenedEntity", {}, { traits: [Widened(child)] });
const WidenedSchema = Schema("widened", { widenedEntity: WidenedEntity });
const widenedTx = txBuilder(WidenedSchema);

// @ts-expect-error
widenedTx.put(WidenedEntity, { catalog: "forged" });
// @ts-expect-error
widenedTx.update(WidenedEntity, 1, { label: "forged" });
