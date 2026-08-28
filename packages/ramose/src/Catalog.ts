/** Permanently keyed runnable catalog definitions. */

import type { CodeDefinition } from "./db/Binding.ts";
import type { AnySchema } from "./db/Schema.ts";
import type { PolicyTemplateIR } from "./internal/authorization/ir.ts";

export interface CatalogProps<S extends AnySchema = AnySchema> {
  readonly schema: S;
  /** Catalog-relative, data-only authorization policy. */
  readonly policy: PolicyTemplateIR;
}

/**
 * A reusable code definition. It is not a concrete database binding and is
 * never request-addressable on its own.
 */
export interface CatalogDefinition<
  Key extends string = string,
  S extends AnySchema = AnySchema,
> extends CodeDefinition {
  readonly _tag: "Catalog";
  readonly key: Key;
  readonly schema: S;
  readonly policy: PolicyTemplateIR;
}

export const isCatalogDefinition = (
  value: unknown,
): value is CatalogDefinition =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Catalog" &&
  typeof (value as { readonly key?: unknown }).key === "string" &&
  (value as { readonly key: string }).key.length > 0 &&
  (value as { readonly schema?: { readonly _tag?: unknown } }).schema?._tag ===
    "Schema" &&
  (value as { readonly policy?: { readonly _tag?: unknown } }).policy?._tag ===
    "PolicyTemplateIR";

/** Define one runnable catalog. Assembly starts from an explicit root value. */
export const Catalog = <const Key extends string, const S extends AnySchema>(
  key: Key,
  props: CatalogProps<S>,
): CatalogDefinition<Key, S> => {
  if (key.length === 0) {
    throw new Error("ramose/catalog: permanent key must not be empty");
  }
  if (props.schema?._tag !== "Schema") {
    throw new Error("ramose/catalog: schema must be a Ramose.Schema");
  }
  if (props.policy?._tag !== "PolicyTemplateIR") {
    throw new Error("ramose/catalog: policy must be compiled authorization data");
  }
  return Object.freeze({
    _tag: "Catalog" as const,
    key,
    schema: props.schema,
    policy: props.policy,
  });
};
