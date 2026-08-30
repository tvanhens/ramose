/**
 * The catalog seam a document resolves names through.
 *
 * A compile never reaches for an ambient registry: it asks the supplied
 * catalog for a root, a field, or a reference target, and the catalog
 * answers `undefined` for "no such definition" and for "not visible to
 * this caller" alike. That is the whole of the metadata seal at this
 * layer — the compiler has nothing to leak because it never learns the
 * difference. An authorization-filtered catalog (the capability
 * projection) and {@link catalogFromSchema} are interchangeable here.
 */

import type { AnyComposer } from "../../Composer.ts";
import type { AnySchema } from "../../Schema.ts";
import { schemaTraits } from "../../Schema.ts";
import type { PathCarrier } from "../../shapes.ts";
import type { FieldRefV1 } from "./registry.ts";
import type { QueryRootV1, ValueTypeV1 } from "./types.ts";

export interface QueryCatalogV1 {
  /** Resolve `{ entity }` / `{ trait }` to a scan root. */
  readonly root: (root: QueryRootV1) => AnyComposer | undefined;
  /** Resolve one public field key on a visible owner. */
  readonly field: (owner: AnyComposer, key: string) => FieldRefV1 | undefined;
  /** The entity a reference field points at, when it is visible. */
  readonly target: (owner: AnyComposer, field: FieldRefV1) => AnyComposer | undefined;
}

const VALUE_TYPES: Readonly<Record<string, ValueTypeV1>> = {
  string: "string",
  long: "number",
  double: "number",
  boolean: "boolean",
  instant: "instant",
  uuid: "uuid",
  bytes: "bytes",
  ref: "ref",
  keyword: "string",
};

/** The document's value vocabulary for one stored field type. */
export const valueTypeOf = (valueType: unknown): ValueTypeV1 =>
  typeof valueType === "string" ? (VALUE_TYPES[valueType] ?? "json") : "json";

type StampedField = PathCarrier & {
  readonly valueType?: string | undefined;
  readonly cardinality?: string | undefined;
  readonly isOptional?: boolean | undefined;
  readonly schema?: unknown;
};

/**
 * Describe one field of a composer. `id` is the pseudo-field every entity
 * and trait carries; it is never missing and never many.
 */
export const describeField = (
  owner: AnyComposer,
  key: string,
): FieldRefV1 | undefined => {
  if (key === "id") {
    return {
      attr: owner.id as unknown as FieldRefV1["attr"],
      key,
      type: "ref",
      many: false,
      optional: false,
    };
  }
  const fields = owner.fields as unknown as Record<string, StampedField | undefined>;
  if (!Object.hasOwn(fields, key)) return undefined;
  const attr = fields[key];
  if (attr === undefined || typeof attr.ident !== "string") return undefined;
  return {
    attr: attr as FieldRefV1["attr"],
    key,
    type: valueTypeOf(attr.valueType),
    many: attr.cardinality === "many",
    optional: attr.isOptional === true,
  };
};

/**
 * The entity a `Ref(Issue)` field points at. Self-refs resolve to the
 * enclosing composer; an untargeted ref has no visible target.
 */
export const referenceTarget = (
  owner: AnyComposer,
  field: FieldRefV1,
): AnyComposer | undefined => {
  if (field.type !== "ref") return undefined;
  if (field.key === "id") return owner;
  const schema = (field.attr as { readonly schema?: unknown }).schema as
    | { readonly _resolve?: () => unknown; readonly _self?: boolean }
    | undefined;
  if (schema?._self === true) return owner;
  const resolve = schema?._resolve;
  if (typeof resolve !== "function") return undefined;
  const target = resolve() as { readonly _tag?: unknown } | undefined;
  if (
    typeof target === "object" &&
    target !== null &&
    (target._tag === "Entity" || target._tag === "Trait")
  ) {
    return target as AnyComposer;
  }
  return undefined;
};

/**
 * Every entity and reachable trait of one schema, all fields visible. The
 * unfiltered catalog — the shape an authorization-filtered projection
 * narrows.
 */
export const catalogFromSchema = (schema: AnySchema): QueryCatalogV1 => {
  const traits = schemaTraits(schema);
  return {
    root: (root) => {
      if ("entity" in root) {
        const entities = schema.entities as Record<string, AnyComposer | undefined>;
        return Object.hasOwn(entities, root.entity) ? entities[root.entity] : undefined;
      }
      return traits.get(root.trait) as AnyComposer | undefined;
    },
    field: describeField,
    target: referenceTarget,
  };
};
