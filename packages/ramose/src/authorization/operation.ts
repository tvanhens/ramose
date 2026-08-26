/** Policy-facing owned operation handles. Map keys are local names. */

import type * as SchemaNS from "effect/Schema";
import type { AnyEntity } from "../db/Entity.ts";
import type { AnyTrait } from "../db/Trait.ts";
import type { OperationTarget, RelativeOwnerRef } from "../internal/authorization/identity.ts";

export type OperationOwner = AnyEntity | AnyTrait;

export interface PolicyOperation<
  Owner extends OperationOwner = OperationOwner,
  LocalName extends string = string,
  Target extends OperationTarget = OperationTarget,
  Input = unknown,
> {
  readonly _tag: "PolicyOperation";
  readonly owner: Owner;
  readonly localName: LocalName;
  readonly target: Target;
  readonly input: SchemaNS.Top;
  readonly inputKeys: readonly string[];
  /** Phantom input type. Never at runtime. */
  readonly _input?: Input;
}

export type AnyPolicyOperation = PolicyOperation<
  OperationOwner,
  string,
  OperationTarget,
  unknown
>;

export type OperationSpec = {
  readonly self?: boolean;
  readonly input: SchemaNS.Top;
};

type TargetOf<S extends OperationSpec> = [S["self"]] extends [false]
  ? "none"
  : "required";

const inputKeysOf = (input: SchemaNS.Top): readonly string[] => {
  const fields = (input as { readonly fields?: Record<string, unknown> }).fields;
  return fields === undefined ? [] : Object.keys(fields).sort();
};

export const ownerRefOf = (owner: OperationOwner): RelativeOwnerRef => ({
  kind: owner._tag === "Trait" ? "trait" : "entity",
  name: owner.ns,
});

export function operation<
  Owner extends OperationOwner,
  const LocalName extends string,
  const Spec extends OperationSpec,
>(
  owner: Owner,
  localName: LocalName,
  spec: Spec,
): PolicyOperation<Owner, LocalName, TargetOf<Spec>, SchemaNS.Schema.Type<Spec["input"]>> {
  return {
    _tag: "PolicyOperation",
    owner,
    localName,
    target: (spec.self === false ? "none" : "required") as TargetOf<Spec>,
    input: spec.input,
    inputKeys: inputKeysOf(spec.input),
  };
}

export function operations<
  Owner extends OperationOwner,
  const M extends Record<string, OperationSpec>,
>(
  owner: Owner,
  map: M,
): {
  readonly [K in keyof M]: PolicyOperation<
    Owner,
    K & string,
    TargetOf<M[K]>,
    SchemaNS.Schema.Type<M[K]["input"]>
  >;
} {
  const out: Record<string, AnyPolicyOperation> = {};
  for (const [localName, spec] of Object.entries(map)) {
    out[localName] = operation(owner, localName, spec);
  }
  return out as {
    readonly [K in keyof M]: PolicyOperation<
      Owner,
      K & string,
      TargetOf<M[K]>,
      SchemaNS.Schema.Type<M[K]["input"]>
    >;
  };
}

export const isPolicyOperation = (value: unknown): value is AnyPolicyOperation =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "PolicyOperation";
