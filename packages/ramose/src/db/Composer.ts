import type { AnyEntity } from "./Entity.ts";
import type { AnyTrait } from "./Trait.ts";

export const COMPOSED_TRAITS: unique symbol = Symbol.for(
  "ramose/composed-traits",
);

/** A concrete entity or a trait usable as a polymorphic read focus. */
export type AnyComposer = AnyEntity | AnyTrait;

export const isComposer = (value: unknown): value is AnyComposer =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  ((value as { readonly _tag?: unknown })._tag === "Entity" ||
    (value as { readonly _tag?: unknown })._tag === "Trait");
