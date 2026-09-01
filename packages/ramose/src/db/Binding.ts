import type { AnyField, CreationDefault, ValueOf } from "./Field.ts";
import type { AnySchema } from "./Schema.ts";

/** Minimal permanently-keyed code definition understood by reachability. */
export interface CodeDefinition {
  readonly key: string;
  readonly schema: AnySchema;
}

/** Lazy form permits a database definition declared later in the module. */
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
  readonly values?: BindingValues<Fields>;
  readonly defaults?: BindingDefaults<Fields>;
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
}

export const cloneBindingValue = (
  value: unknown,
  seen = new WeakSet<object>(),
): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("ramose/binding: values must contain only finite numbers");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new Error("ramose/binding: values must contain only valid dates");
    }
    return new Date(value.getTime());
  }
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value !== "object" || value === null) {
    throw new Error("ramose/binding: values must contain only supported stored data");
  }
  if (seen.has(value)) {
    throw new Error("ramose/binding: values must not contain cycles");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = Object.freeze(value.map((item) => cloneBindingValue(item, seen)));
    seen.delete(value);
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("ramose/binding: values must contain only supported stored data");
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) {
      throw new Error("ramose/binding: values must not contain undefined");
    }
    Object.defineProperty(copy, key, {
      value: cloneBindingValue(item, seen),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  seen.delete(value);
  return Object.freeze(copy);
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
  for (const key of Object.keys(result)) {
    if (key !== "values" && key !== "defaults") {
      throw new Error(`ramose/binding: unsupported result field ${JSON.stringify(key)}`);
    }
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
  });
};

export const isBindableTrait = (value: unknown): boolean =>
  typeof value === "function" && TRAIT_BIND_FACTORY in value;

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
