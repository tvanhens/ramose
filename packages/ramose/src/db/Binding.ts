/** Trait binding metadata: fixed values, composition defaults, dependencies. */

import type { AnyField, CreationDefault, ValueOf } from "./Field.ts";
import type { AnySchema } from "./Schema.ts";

/** Minimal permanently-keyed code definition understood by reachability. */
export interface CodeDefinition {
  readonly key: string;
  readonly schema: AnySchema;
}

/** Lazy form permits self-similar and mutually recursive catalog graphs. */
export type CodeDefinitionRef = CodeDefinition | (() => CodeDefinition);

type BoundFieldValue<F extends AnyField> = F["cardinality"] extends "many"
  ? readonly ValueOf<F>[]
  : ValueOf<F>;

export type BindingValues<Fields extends Record<string, AnyField>> = {
  readonly [K in keyof Fields]?: BoundFieldValue<Fields[K]>;
};

export type BindingDefaults<Fields extends Record<string, AnyField>> = {
  readonly [K in keyof Fields]?: CreationDefault<BoundFieldValue<Fields[K]>>;
};

/** Inert result of a trait's `bind` function. */
export interface TraitBindingSpec<
  Fields extends Record<string, AnyField> = Record<string, AnyField>,
> {
  /** Engine-owned values. Callers can never supply or mutate these fields. */
  readonly values?: BindingValues<Fields>;
  /** Defaults with precedence over field defaults, used only on creation. */
  readonly defaults?: BindingDefaults<Fields>;
  /** Code definitions needed by deployment assembly. Never database facts. */
  readonly dependencies?: readonly CodeDefinitionRef[];
}

export type TraitBind<
  Fields extends Record<string, AnyField> = Record<string, AnyField>,
> = (definition: CodeDefinition) => TraitBindingSpec<Fields>;

export const TRAIT_BINDING: unique symbol = Symbol.for("ramose.trait.binding");
export const TRAIT_BIND_FACTORY: unique symbol = Symbol.for(
  "ramose.trait.bind-factory",
);

type SpecOf<B> = B extends (...args: infer _Args) => infer S ? S : never;
type SelectedOf<S, K extends PropertyKey> = S extends unknown
  ? K extends keyof S
    ? Exclude<S[K], undefined>
    : {}
  : never;
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type ValuesOf<B> = SelectedOf<SpecOf<B>, "values">;
type DefaultsOf<B> = SelectedOf<SpecOf<B>, "defaults">;

type BoundField<F, K extends PropertyKey, B> = K extends KeysOfUnion<ValuesOf<B>>
  ? F & { readonly fixed: true }
  : K extends KeysOfUnion<DefaultsOf<B>>
    ? F & { readonly compositionDefault: true }
    : F;

/** Apply one bind result to a field map at the type boundary. */
export type BoundFieldMap<Fields extends Readonly<Record<string, AnyField>>, B> = {
  readonly [K in keyof Fields]: BoundField<Fields[K], K, B>;
};

type BoundFields<T extends TraitLike, B> = BoundFieldMap<T["fields"], B>;

export type TraitLike = {
  readonly _tag: "Trait";
  readonly ns: string;
  readonly fields: Readonly<Record<string, AnyField & { readonly ident: string }>>;
  readonly traits: readonly { readonly ns: string }[];
};

type FieldKeys<T extends TraitLike> = keyof T["fields"];

/** One use of a bindable trait. Trait identity remains the underlying trait. */
export type TraitBinding<
  T extends TraitLike = TraitLike,
  B extends TraitBind = TraitBind,
> = Omit<T, FieldKeys<T> | "fields"> &
  BoundFields<T, B> & {
    readonly fields: BoundFields<T, B>;
    readonly [TRAIT_BINDING]: TraitBindingRuntime<T, B>;
  };

export type BindableTrait<
  T extends TraitLike,
  B extends TraitBind,
> = T &
  ((definition: CodeDefinitionRef) => TraitBinding<T, B>) & {
    readonly [TRAIT_BIND_FACTORY]: B;
  };

export interface TraitBindingRuntime<
  T extends TraitLike = TraitLike,
  B extends TraitBind = TraitBind,
> {
  readonly trait: T;
  readonly definition: CodeDefinitionRef;
  readonly bind: B;
}

export interface ResolvedTraitBinding {
  readonly trait: TraitLike;
  readonly definition: CodeDefinition;
  readonly values: Readonly<Record<string, unknown>>;
  readonly defaults: Readonly<Record<string, CreationDefault<unknown>>>;
  readonly dependencies: readonly CodeDefinition[];
}

/** @internal Copy the mutable stored-value forms retained by bindings. */
export const cloneBindingValue = (value: unknown): unknown => {
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneBindingValue));
  }
  return value;
};

export const isCodeDefinition = (value: unknown): value is CodeDefinition =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly key?: unknown }).key === "string" &&
  typeof (value as { readonly schema?: unknown }).schema === "object" &&
  (value as { readonly schema?: { readonly _tag?: unknown } }).schema?._tag ===
    "Schema";

export const resolveCodeDefinition = (ref: CodeDefinitionRef): CodeDefinition => {
  const definition = typeof ref === "function" ? ref() : ref;
  if (!isCodeDefinition(definition) || definition.key.length === 0) {
    throw new Error(
      "ramose/reachability: a binding dependency must be a non-empty permanently keyed code definition",
    );
  }
  return definition;
};

export const bindingOf = (
  value: unknown,
): TraitBindingRuntime | undefined => {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) return undefined;
  return (value as { readonly [TRAIT_BINDING]?: TraitBindingRuntime })[
    TRAIT_BINDING
  ];
};

const plainRecord = (
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> => {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`ramose/binding: ${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`ramose/binding: ${label} must be a plain object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

/** Resolve and structurally validate one inert authoring binding. */
export const resolveTraitBinding = (
  runtime: TraitBindingRuntime,
): ResolvedTraitBinding => {
  const definition = resolveCodeDefinition(runtime.definition);
  const result = runtime.bind(definition);
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(
      `ramose/binding: trait ${JSON.stringify(runtime.trait.ns)} bind must return an object`,
    );
  }
  const values = plainRecord(result.values, "values");
  const defaultValues = plainRecord(result.defaults, "defaults");
  const defaults: Record<string, CreationDefault<unknown>> = {};
  for (const [key, value] of Object.entries(defaultValues)) {
    if (typeof value !== "function") {
      throw new Error(
        `ramose/binding: default ${JSON.stringify(key)} on trait ${JSON.stringify(runtime.trait.ns)} must be a synchronous function`,
      );
    }
    defaults[key] = value as CreationDefault<unknown>;
  }
  const dependencyRefs = result.dependencies ?? [];
  if (!Array.isArray(dependencyRefs)) {
    throw new Error("ramose/binding: dependencies must be an array");
  }
  const dependencies = dependencyRefs.map(resolveCodeDefinition);
  for (const key of [...Object.keys(values), ...Object.keys(defaults)]) {
    if (!Object.hasOwn(runtime.trait.fields, key)) {
      throw new Error(
        `ramose/binding: trait ${JSON.stringify(runtime.trait.ns)} has no field ${JSON.stringify(key)}`,
      );
    }
  }
  const snapshotValues = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    snapshotValues[key] = cloneBindingValue(value);
  }
  return Object.freeze({
    trait: runtime.trait,
    definition,
    values: Object.freeze(snapshotValues),
    defaults: Object.freeze(defaults),
    dependencies: Object.freeze(dependencies),
  });
};

export const isBindableTrait = (value: unknown): boolean =>
  typeof value === "function" && TRAIT_BIND_FACTORY in value;

/** Stable owner definition, independent of a binding wrapper or thunk. */
export const traitDefinitionOf = (value: TraitLike): TraitLike =>
  bindingOf(value)?.trait ?? value;

export const makeTraitBinding = <T extends TraitLike, B extends TraitBind>(
  trait: T,
  definition: CodeDefinitionRef,
  bind: B,
): TraitBinding<T, B> => ({
  ...trait,
  [TRAIT_BINDING]: {
    trait,
    definition,
    bind,
  },
}) as unknown as TraitBinding<T, B>;

/** Make one trait value both a stable query/ref root and a binding factory. */
export const makeBindableTrait = <T extends TraitLike, B extends TraitBind>(
  trait: T,
  bind: B,
): BindableTrait<T, B> => {
  const callable = ((definition: CodeDefinitionRef) =>
    makeTraitBinding(trait, definition, bind)) as BindableTrait<T, B>;
  for (const key of Reflect.ownKeys(trait)) {
    Object.defineProperty(
      callable,
      key,
      Object.getOwnPropertyDescriptor(trait, key)!,
    );
  }
  Object.defineProperty(callable, TRAIT_BIND_FACTORY, { value: bind });
  return callable;
};
