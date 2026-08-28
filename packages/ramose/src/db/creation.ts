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
import { isOptionalField, type AnyField, type CreationDefaultContext } from "./Field.ts";
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

const formatPath = (path: readonly string[]): string => path.join(" → ");

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
