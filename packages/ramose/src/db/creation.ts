/** Pure authoritative creation-value resolution. */

import * as Schema from "effect/Schema";
import {
  bindingOf,
  cloneBindingValue,
  resolveTraitBinding,
  traitDefinitionOf,
  type ResolvedTraitBinding,
  type TraitLike,
} from "./Binding.ts";
import {
  creationDefaultIdentityOf,
  isOptionalField,
  type AnyField,
  type CreationDefault,
  type CreationDefaultContext,
  type CreationDefaultInputs,
} from "./Field.ts";
import type { AnyEntity } from "./Entity.ts";
import { traitsOf, type ComposerLike } from "./compose.ts";

export class BindingConflictError extends Error {
  override readonly name = "BindingConflictError";
}

export class CreationValueError extends Error {
  override readonly name = "CreationValueError";
}

export interface ResolvedBindingUse {
  readonly binding: ResolvedTraitBinding;
  readonly path: readonly string[];
}

type FixedEntry = {
  readonly key: string;
  readonly ident: string;
  readonly value: unknown;
  readonly path: readonly string[];
};

type DefaultEntry = {
  readonly key: string;
  readonly ident: string;
  readonly get: (context: CreationDefaultContext) => unknown;
  readonly path: readonly string[];
};

type CreationFieldEncoder = (value: unknown) => unknown;

export interface CompositionValueMetadata {
  readonly bindings: readonly ResolvedBindingUse[];
  readonly fixed: ReadonlyMap<string, FixedEntry>;
  readonly defaults: ReadonlyMap<string, readonly DefaultEntry[]>;
  readonly encoders: ReadonlyMap<string, CreationFieldEncoder>;
}

export type CompiledCreationDefault = {
  readonly source: string;
  readonly inputs: CreationDefaultInputs;
  readonly evaluate: CreationDefault<unknown>;
  readonly path: readonly string[];
};

export type CompiledCreationField = {
  readonly key: string;
  readonly ident: string;
  readonly cardinality: "one" | "many";
  readonly optional: boolean;
  readonly encoder: CreationFieldEncoder;
  readonly fixed: unknown | undefined;
  readonly defaults: readonly CompiledCreationDefault[];
  readonly fieldDefault: CompiledCreationDefault | undefined;
};

export type CompiledBindingIdentity = {
  readonly trait: string;
  readonly definition: string;
  readonly dependencies: readonly string[];
};

/** Caller-free creation runtime plan and the exact records hashed beside it. */
export type CompiledCreationPlan = {
  readonly entity: string;
  readonly fields: readonly CompiledCreationField[];
  readonly bindings: readonly CompiledBindingIdentity[];
};

const formatPath = (path: readonly string[]): string => path.join(" → ");

const declaredDefault = (
  get: CreationDefault<unknown>,
  path: readonly string[],
  label: string,
): CompiledCreationDefault => {
  const identity = creationDefaultIdentityOf(get);
  if (identity === undefined) {
    throw new BindingConflictError(
      `${label} must declare canonical captured inputs with creationDefault(inputs, get)`,
    );
  }
  return Object.freeze({
    source: identity.source,
    inputs: identity.inputs,
    evaluate: get,
    path: Object.freeze([...path]),
  });
};

const sameValue = (
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, WeakSet<object>>(),
): boolean => {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const matches = seen.get(left);
    if (matches?.has(right) === true) return true;
    if (matches === undefined) seen.set(left, new WeakSet([right]));
    else matches.add(right);
    return left.length === right.length && left.every((value, index) =>
      sameValue(value, right[index], seen)
    );
  }
  if (
    typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null
  ) {
    const matches = seen.get(left);
    if (matches?.has(right) === true) return true;
    if (matches === undefined) seen.set(left, new WeakSet([right]));
    else matches.add(right);
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) =>
        key === rightKeys[index] &&
        sameValue(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          seen,
        )
      );
  }
  return false;
};

/** Every binding use, including equivalent diamond paths. */
export const bindingUsesOf = (composer: ComposerLike): readonly ResolvedBindingUse[] => {
  const out: ResolvedBindingUse[] = [];
  const stack: TraitLike[] = [];

  const visit = (input: ComposerLike, path: readonly string[]): void => {
    const stable = traitDefinitionOf(input as unknown as TraitLike);
    if (stack.includes(stable)) {
      throw new BindingConflictError(
        `ramose/binding: trait cycle while resolving ${formatPath([...path, `trait:${stable.ns}`])}`,
      );
    }
    const nextPath = [...path, `trait:${stable.ns}`];
    const runtime = bindingOf(input);
    if (runtime !== undefined) {
      const binding = resolveTraitBinding(runtime);
      out.push({
        binding,
        path: Object.freeze([...nextPath, `binding:${binding.definition.key}`]),
      });
    }
    stack.push(stable);
    for (const nested of traitsOf(stable)) visit(nested, nextPath);
    stack.pop();
  };

  for (const trait of traitsOf(composer)) {
    visit(trait, [`entity:${composer.ns}`]);
  }
  return Object.freeze(out);
};

/**
 * Resolve fixed/default metadata and reject conflicting reachable bindings.
 * Maps are keyed by stable field ident, not binding-wrapper identity.
 */
export const compositionValueMetadata = (
  entity: AnyEntity,
): CompositionValueMetadata =>
  compositionValueMetadataFromBindings(
    entity,
    bindingUsesOf(entity as ComposerLike),
  );

/** Build creation metadata from binding callbacks already resolved once. */
export const compositionValueMetadataFromBindings = (
  entity: AnyEntity,
  bindings: readonly ResolvedBindingUse[],
): CompositionValueMetadata => {
  const fixed = new Map<string, FixedEntry>();
  const defaults = new Map<string, DefaultEntry[]>();
  const encoders = new Map<string, CreationFieldEncoder>();
  for (const field of Object.values(entity.fields)) {
    encoders.set(
      field.ident,
      Schema.encodeUnknownSync(field.schema as Schema.Encoder<unknown>),
    );
  }

  for (const use of bindings) {
    for (const [key, value] of Object.entries(use.binding.values)) {
      const field = use.binding.trait.fields[key];
      if (field === undefined) continue;
      const path = [...use.path, field.ident];
      if (value === undefined) {
        throw new BindingConflictError(
          `ramose/binding: fixed value ${field.ident} is undefined (path: ${formatPath(path)})`,
        );
      }
      const validated = decodeField(
        field,
        value,
        "fixed value",
        encoders.get(field.ident),
      );
      if (defaults.has(field.ident)) {
        const prior = defaults.get(field.ident)![0]!;
        throw new BindingConflictError(
          `ramose/binding: ${field.ident} is fixed at ${formatPath(path)} but defaulted at ${formatPath(prior.path)}`,
        );
      }
      const prior = fixed.get(field.ident);
      if (prior !== undefined && !sameValue(prior.value, validated)) {
        throw new BindingConflictError(
          `ramose/binding: conflicting fixed value for ${field.ident} (paths: ${formatPath(prior.path)}; ${formatPath(path)})`,
        );
      }
      if (prior === undefined) {
        fixed.set(field.ident, {
          key,
          ident: field.ident,
          value: cloneBindingValue(validated),
          path,
        });
      }
    }

    for (const [key, get] of Object.entries(use.binding.defaults)) {
      const field = use.binding.trait.fields[key];
      if (field === undefined) continue;
      const path = [...use.path, field.ident];
      const priorFixed = fixed.get(field.ident);
      if (priorFixed !== undefined) {
        throw new BindingConflictError(
          `ramose/binding: ${field.ident} is defaulted at ${formatPath(path)} but fixed at ${formatPath(priorFixed.path)}`,
        );
      }
      const entries = defaults.get(field.ident) ?? [];
      entries.push({ key, ident: field.ident, get, path });
      defaults.set(field.ident, entries);
    }
  }

  return Object.freeze({ bindings, fixed, defaults, encoders });
};

/** Compile one entity into copied field records and trusted capabilities. */
export const compileCreationPlan = (
  entity: AnyEntity,
  metadata: CompositionValueMetadata,
): CompiledCreationPlan => {
  const fields = Object.entries(entity.fields).map(([key, field]) => {
    const encoder = metadata.encoders.get(field.ident);
    if (encoder === undefined) {
      throw new CreationValueError(
        `ramose/create: no snapshotted codec for ${field.ident}`,
      );
    }
    const fixed = metadata.fixed.get(field.ident);
    const defaults = (metadata.defaults.get(field.ident) ?? []).map((entry) =>
      declaredDefault(
        entry.get as CreationDefault<unknown>,
        entry.path,
        `composition default '${field.ident}'`,
      )
    );
    const fieldDefault = typeof field.default === "function"
      ? declaredDefault(
        field.default,
        Object.freeze([`entity:${entity.ns}`, field.ident]),
        `field default '${field.ident}'`,
      )
      : undefined;
    return Object.freeze({
      key,
      ident: field.ident,
      cardinality: field.cardinality,
      optional: isOptionalField(field),
      encoder,
      fixed: fixed === undefined ? undefined : cloneBindingValue(fixed.value),
      defaults: Object.freeze(defaults),
      fieldDefault,
    });
  });
  const bindings = metadata.bindings.map((use) => Object.freeze({
    trait: use.binding.trait.ns,
    definition: use.binding.definition.key,
    dependencies: Object.freeze(
      use.binding.dependencies.map((dependency) => dependency.key).sort(),
    ),
  }));
  return Object.freeze({
    entity: entity.ns,
    fields: Object.freeze(fields),
    bindings: Object.freeze(bindings),
  });
};

const decodeCompiledField = (
  field: CompiledCreationField,
  value: unknown,
  source: string,
): unknown => {
  try {
    const normalized = cloneBindingValue(value);
    if (field.cardinality === "many") {
      if (!Array.isArray(normalized)) {
        throw new Error("expected an array for a cardinality-many field");
      }
      for (const item of normalized) field.encoder(item);
      return normalized;
    }
    field.encoder(normalized);
    return normalized;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CreationValueError(
      `ramose/create: invalid ${source} for ${field.ident}: ${detail}`,
    );
  }
};

/** Resolve creation values without consulting an authoring entity or binding. */
export const resolveCompiledCreationValues = (
  plan: CompiledCreationPlan,
  input: Readonly<Record<string, unknown>>,
  context: CreationDefaultContext,
): Readonly<Record<string, unknown>> => {
  if (!(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) {
    throw new CreationValueError("ramose/create: authoritative now must be a valid Date");
  }
  const authoritativeNow = context.now.getTime();
  const defaultContext = (): CreationDefaultContext =>
    Object.freeze({ now: new Date(authoritativeNow) });
  const byKey = new Map(plan.fields.map((field) => [field.key, field] as const));
  for (const key of Object.keys(input)) {
    const field = byKey.get(key);
    if (field === undefined) {
      throw new CreationValueError(
        `ramose/create: unknown field ${JSON.stringify(key)} on entity ${JSON.stringify(plan.entity)}`,
      );
    }
    if (field.fixed !== undefined) {
      throw new CreationValueError(
        `ramose/create: ${field.ident} is engine-owned and cannot be supplied`,
      );
    }
  }

  const out = Object.create(null) as Record<string, unknown>;
  for (const field of plan.fields) {
    if (field.fixed !== undefined) {
      out[field.key] = decodeCompiledField(
        field,
        field.fixed,
        "fixed value",
      );
      continue;
    }
    const explicit = Object.hasOwn(input, field.key) ? input[field.key] : undefined;
    if (explicit !== undefined) {
      out[field.key] = decodeCompiledField(field, explicit, "explicit value");
      continue;
    }

    let defaultValue: unknown = undefined;
    let defaultPath: readonly string[] | undefined;
    for (const entry of field.defaults) {
      const value = entry.evaluate(defaultContext());
      if (value === undefined) continue;
      const normalized = cloneBindingValue(value);
      if (defaultPath !== undefined && !sameValue(defaultValue, normalized)) {
        throw new BindingConflictError(
          `ramose/binding: conflicting defaults for ${field.ident} (paths: ${formatPath(defaultPath)}; ${formatPath(entry.path)})`,
        );
      }
      defaultValue = normalized;
      defaultPath = entry.path;
    }
    if (defaultPath !== undefined) {
      out[field.key] = decodeCompiledField(
        field,
        defaultValue,
        "composition default",
      );
      continue;
    }
    if (field.fieldDefault !== undefined) {
      const value = field.fieldDefault.evaluate(defaultContext());
      if (value !== undefined) {
        out[field.key] = decodeCompiledField(field, value, "field default");
        continue;
      }
    }
    if (field.optional) continue;
    throw new CreationValueError(
      `ramose/create: entity ${plan.entity} is missing required field ${field.ident}`,
    );
  }
  return Object.freeze(out);
};

function decodeField(
  field: AnyField & { readonly ident: string },
  value: unknown,
  source: string,
  encoder: CreationFieldEncoder = Schema.encodeUnknownSync(
    field.schema as Schema.Encoder<unknown>,
  ),
): unknown {
  try {
    if (field.cardinality === "many") {
      if (!Array.isArray(value)) {
        throw new Error("expected an array for a cardinality-many field");
      }
      return value.map((item) => {
        encoder(item);
        return item;
      });
    }
    encoder(value);
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CreationValueError(
      `ramose/create: invalid ${source} for ${field.ident}: ${detail}`,
    );
  }
}

const fixedLocalKeys = (
  entity: AnyEntity,
  metadata: CompositionValueMetadata,
): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const [key, field] of Object.entries(entity.fields)) {
    if (metadata.fixed.has(field.ident)) keys.add(key);
  }
  return keys;
};

/** Reject any caller-owned occurrence of a fixed key, including `undefined`. */
export const assertNoFixedValues = (
  entity: AnyEntity,
  input: Readonly<Record<string, unknown>>,
): void => {
  const metadata = compositionValueMetadata(entity);
  for (const key of fixedLocalKeys(entity, metadata)) {
    if (Object.hasOwn(input, key)) {
      throw new CreationValueError(
        `ramose/create: ${entity.fields[key]!.ident} is engine-owned and cannot be supplied`,
      );
    }
  }
};

/**
 * Resolve one creation row with exact precedence:
 * explicit (except `undefined`) → composition default → field default →
 * optional/many omission → required failure. Fixed values are engine-owned.
 */
export const resolveCreationValues = (
  entity: AnyEntity,
  input: Readonly<Record<string, unknown>>,
  context: CreationDefaultContext,
  metadata: CompositionValueMetadata = compositionValueMetadata(entity),
): Readonly<Record<string, unknown>> => {
  if (!(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) {
    throw new CreationValueError("ramose/create: authoritative now must be a valid Date");
  }
  const authoritativeNow = context.now.getTime();
  const defaultContext = (): CreationDefaultContext =>
    Object.freeze({ now: new Date(authoritativeNow) });
  const fixedKeys = fixedLocalKeys(entity, metadata);

  for (const key of Object.keys(input)) {
    const field = entity.fields[key];
    if (field === undefined) {
      throw new CreationValueError(
        `ramose/create: unknown field ${JSON.stringify(key)} on entity ${JSON.stringify(entity.ns)}`,
      );
    }
    if (fixedKeys.has(key)) {
      throw new CreationValueError(
        `ramose/create: ${field.ident} is engine-owned and cannot be supplied`,
      );
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(entity.fields)) {
    const encoder = metadata.encoders.get(field.ident);
    if (encoder === undefined) {
      throw new CreationValueError(
        `ramose/create: no snapshotted codec for ${field.ident}`,
      );
    }
    const fixed = metadata.fixed.get(field.ident);
    if (fixed !== undefined) {
      out[key] = decodeField(
        field,
        cloneBindingValue(fixed.value),
        "fixed value",
        encoder,
      );
      continue;
    }

    const explicit = Object.hasOwn(input, key) ? input[key] : undefined;
    if (explicit !== undefined) {
      out[key] = decodeField(field, explicit, "explicit value", encoder);
      continue;
    }

    const boundDefaults = metadata.defaults.get(field.ident) ?? [];
    let defaultValue: unknown = undefined;
    let defaultPath: readonly string[] | undefined;
    for (const entry of boundDefaults) {
      const value = entry.get(defaultContext());
      if (value === undefined) continue;
      if (defaultPath !== undefined && !sameValue(defaultValue, value)) {
        throw new BindingConflictError(
          `ramose/binding: conflicting defaults for ${field.ident} (paths: ${formatPath(defaultPath)}; ${formatPath(entry.path)})`,
        );
      }
      defaultValue = value;
      defaultPath = entry.path;
    }
    if (defaultPath !== undefined) {
      out[key] = decodeField(
        field,
        defaultValue,
        "composition default",
        encoder,
      );
      continue;
    }

    if (typeof field.default === "function") {
      const value = field.default(defaultContext());
      if (value !== undefined) {
        out[key] = decodeField(field, value, "field default", encoder);
        continue;
      }
    }

    if (isOptionalField(field)) continue;
    throw new CreationValueError(
      `ramose/create: entity ${entity.ns} is missing required field ${field.ident}`,
    );
  }
  return Object.freeze(out);
};
