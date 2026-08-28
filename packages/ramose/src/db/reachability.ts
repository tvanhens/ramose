/** Deterministic pure code-definition reachability for later catalog assembly. */

import {
  resolveCodeDefinition,
  type CodeDefinition,
  type CodeDefinitionRef,
  type ResolvedTraitBinding,
} from "./Binding.ts";
import { compositionValueMetadata } from "./creation.ts";

export class ReachabilityConflictError extends Error {
  override readonly name = "ReachabilityConflictError";
}

export interface ReachableCodeDefinition {
  readonly key: string;
  readonly definition: CodeDefinition;
  readonly path: readonly string[];
}

export interface ReachableBinding {
  readonly catalogKey: string;
  readonly entity: string;
  readonly binding: ResolvedTraitBinding;
  readonly path: readonly string[];
}

export interface CodeReachability {
  readonly root: CodeDefinition;
  readonly definitions: readonly ReachableCodeDefinition[];
  readonly bindings: readonly ReachableBinding[];
}

const formatPath = (path: readonly string[]): string => path.join(" → ");

/**
 * Walk root catalog → schema → entities → traits → bindings → dependencies.
 * Definitions are marked by permanent key before descending, so recursive
 * graphs terminate. The result is inert authoring metadata, not a registry.
 */
export const collectCodeReachability = (
  rootRef: CodeDefinitionRef,
): CodeReachability => {
  const root = resolveCodeDefinition(rootRef);
  const byKey = new Map<string, ReachableCodeDefinition>();
  const definitions: ReachableCodeDefinition[] = [];
  const bindings: ReachableBinding[] = [];

  const visit = (definition: CodeDefinition, path: readonly string[]): void => {
    const nextPath = [...path, `catalog:${definition.key}`];
    const previous = byKey.get(definition.key);
    if (previous !== undefined) {
      if (previous.definition !== definition) {
        throw new ReachabilityConflictError(
          `ramose/reachability: permanent key ${JSON.stringify(definition.key)} names different definitions (paths: ${formatPath(previous.path)}; ${formatPath(nextPath)})`,
        );
      }
      return;
    }

    const reachable = Object.freeze({
      key: definition.key,
      definition,
      path: Object.freeze(nextPath),
    });
    byKey.set(definition.key, reachable);
    definitions.push(reachable);

    const entityNames = Object.keys(definition.schema.entities).sort();
    for (const entityName of entityNames) {
      const entity = definition.schema.entities[entityName]!;
      const metadata = compositionValueMetadata(entity);
      for (const use of metadata.bindings) {
        const bindingPath = Object.freeze([
          ...nextPath,
          "schema",
          `entity:${entityName}`,
          ...use.path.slice(1),
        ]);
        bindings.push(Object.freeze({
          catalogKey: definition.key,
          entity: entityName,
          binding: use.binding,
          path: bindingPath,
        }));

        const dependencies = use.binding.dependencies.map(resolveCodeDefinition).sort(
          (left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
        );
        for (const dependency of dependencies) {
          visit(dependency, [...bindingPath, "dependencies"]);
        }
      }
    }
  };

  visit(root, []);
  const frozenDefinitions = Object.freeze([...definitions]);
  const frozenBindings = Object.freeze([...bindings]);
  return Object.freeze({
    root,
    definitions: frozenDefinitions,
    bindings: frozenBindings,
  });
};
