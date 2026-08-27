/**
 * Auth-path construction for the read-authorization language (#406).
 *
 * `$()` / `path()` / field stamps exist only before compile. They accumulate
 * hops; compile lowers each hop to {@link import("../identities.ts").RelativeFieldId}.
 * Real Entity / Field objects are never mutated.
 */

import { isSelfRefSchema, refTargetOf } from "../../../db/valueTypes.ts";
import { contains, eq } from "./expr.ts";
import {
  isPathCarrier,
  stepFromCarrier,
  AUTH_PATH_TAG,
  type AuthOperandInput,
  type AuthPathLike,
  type AuthPathProxy,
  type AuthPathStep,
} from "./types.ts";

type FieldOwner = {
  readonly ns?: string | undefined;
  readonly fields: { readonly [key: string]: unknown };
  readonly id?: unknown;
};

class AuthPath implements AuthPathLike {
  readonly _tag = AUTH_PATH_TAG;
  readonly steps: readonly AuthPathStep[];

  constructor(steps: readonly AuthPathStep[]) {
    this.steps = steps;
  }

  eq(rhs: AuthOperandInput) {
    return eq(this, rhs);
  }

  contains(rhs: AuthOperandInput) {
    return contains(this, rhs);
  }
}

export type { AuthPathLike as AuthPath };

const fieldOf = (owner: FieldOwner, name: string): unknown => {
  if (Object.hasOwn(owner.fields, name)) return owner.fields[name];
  if (name === "id" && isPathCarrier(owner.id)) return owner.id;
  return undefined;
};

const nextOwner = (field: unknown, current: FieldOwner): FieldOwner | undefined => {
  if (typeof field !== "object" || field === null) return undefined;
  const schema = (field as { readonly schema?: unknown }).schema;
  if (isSelfRefSchema(schema)) return current;
  const resolve = refTargetOf(schema);
  if (resolve === undefined) return undefined;
  const target = resolve();
  return {
    ns: target.ns,
    fields: target.fields as { readonly [key: string]: unknown },
  };
};

const missingStep = (owner: FieldOwner, name: string): AuthPathStep => ({
  ident: owner.ns !== undefined ? `:${owner.ns}/${name}` : name,
  localName: name,
  cardinality: "one",
  valueType: undefined,
  reverse: false,
});

const navigate = (owner: FieldOwner, steps: readonly AuthPathStep[]): AuthPathProxy => {
  const path = new AuthPath(steps);
  return new Proxy(path, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        const field = fieldOf(owner, prop);
        if (field !== undefined) {
          const step = isPathCarrier(field) ? stepFromCarrier(field) : missingStep(owner, prop);
          const next = isPathCarrier(field) ? (nextOwner(field, owner) ?? { fields: {} }) : { fields: {} };
          return navigate(next, [...steps, step]);
        }
      }
      if (prop === "eq" || prop === "contains" || prop === "_tag" || prop === "steps") {
        return Reflect.get(target, prop, receiver);
      }
      if (prop === "then" || prop === "toJSON") return undefined;
      if (typeof prop !== "string") return undefined;
      return navigate({ fields: {} }, [...steps, missingStep(owner, prop)]);
    },
  }) as unknown as AuthPathProxy;
};

/**
 * Auth-path proxy over an Entity or Trait. Property access accumulates
 * hops; `.eq` / `.contains` are the only terminals.
 */
export const $ = <N extends { readonly fields: object; readonly ns?: string; readonly id?: unknown }>(
  root: N,
): AuthPathProxy<N["fields"]> =>
  navigate(
    {
      ns: root.ns,
      fields: root.fields as { readonly [key: string]: unknown },
      id: root.id,
    },
    [],
  ) as AuthPathProxy<N["fields"]>;

const hopToSteps = (hop: AuthPathLike | { readonly ident: string }): readonly AuthPathStep[] => {
  if (hop instanceof AuthPath || (hop as AuthPathLike)._tag === AUTH_PATH_TAG) {
    return (hop as AuthPathLike).steps;
  }
  if (isPathCarrier(hop)) return [stepFromCarrier(hop)];
  return [
    {
      ident: "",
      localName: "",
      cardinality: "one",
      valueType: undefined,
      reverse: false,
    },
  ];
};

/** Concatenate stamped fields and AuthPaths into one AuthPath. */
export const path = (...hops: ReadonlyArray<AuthPathLike | { readonly ident: string }>): AuthPath => {
  const steps: AuthPathStep[] = [];
  for (const hop of hops) {
    steps.push(...hopToSteps(hop));
  }
  return new AuthPath(steps);
};
