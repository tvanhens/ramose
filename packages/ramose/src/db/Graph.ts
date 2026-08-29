/** The built-in trait implemented by every dynamic child-graph row. */

import type { BindableTrait, CodeDefinition } from "./Binding.ts";
import { Field, string } from "./Field.ts";
import { Trait, type Trait as TraitType } from "./Trait.ts";

const graphFields = {
  catalog: string(),
  name: Field.unique(string(), "strict"),
  doc: string({ optional: true }),
};

const bindGraph = (catalog: CodeDefinition) => ({
  values: { catalog: catalog.key },
  dependencies: [catalog],
});

type BuiltInGraph = BindableTrait<
  TraitType<"graph", typeof graphFields>,
  typeof bindGraph
>;

/**
 * Bind a concrete entity to a runnable child catalog while retaining one
 * stable `:graph/*` trait identity across every graph composer.
 *
 * The catalog key is supplied by deployed code reachability and is therefore
 * absent from public create and mutation inputs. Graph rows remain ordinary
 * canonically typed entities; creation, policy, querying, refs, uniqueness,
 * and atomic writes all use the existing entity/trait machinery.
 */
export const Graph: BuiltInGraph = Trait("graph", graphFields, {
  bind: bindGraph,
});
