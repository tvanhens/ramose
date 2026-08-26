/** Typed policy authoring API. Build-time only; callbacks never reach runtime. */

import type * as SchemaNS from "effect/Schema";
import type { AnyEntity } from "../db/Entity.ts";
import type { AnyField } from "../db/Field.ts";
import type { AnySchema } from "../db/Schema.ts";
import type { AnyTrait } from "../db/Trait.ts";
import type { RelativeFieldRef, RelativeOwnerRef } from "../internal/authorization/identity.ts";
import type { RuleFocus } from "../internal/authorization/expr.ts";
import {
  always,
  and,
  claimCells,
  exists,
  hasClass,
  inputCells,
  isAuthExpr,
  me,
  not,
  or,
  self,
  snapshotOf,
  subject,
  type AuthExpr,
  type ClaimCell,
  type InputCell,
  type MeCell,
  type PathCell,
  type SubjectCell,
} from "./expr.ts";
import {
  isPolicyOperation,
  type AnyPolicyOperation,
  type PolicyOperation,
} from "./operation.ts";

export type AuthRule<Focus = unknown> = {
  readonly _tag: "AuthRule";
  readonly focus: Focus;
  readonly irFocus: RuleFocus;
  readonly expr: AuthExpr;
};

export type DecisionKind = "row" | "trait" | "field" | "operation";

export type PolicyBinding = {
  readonly kind: DecisionKind;
  readonly key: string;
  readonly target: unknown;
  readonly allow: readonly (AuthRule | AuthExpr)[];
  readonly deny: readonly (AuthRule | AuthExpr)[];
};

class DecisionBuilder {
  readonly kind: DecisionKind;
  readonly key: string;
  readonly target: unknown;
  private allows: (AuthRule | AuthExpr)[] = [];
  private denys: (AuthRule | AuthExpr)[] = [];

  constructor(kind: DecisionKind, key: string, target: unknown) {
    this.kind = kind;
    this.key = key;
    this.target = target;
  }

  allow(...arms: readonly (AuthRule | AuthExpr)[]): this {
    this.allows.push(...arms);
    return this;
  }

  deny(...arms: readonly (AuthRule | AuthExpr)[]): this {
    this.denys.push(...arms);
    return this;
  }

  collect(): PolicyBinding {
    return {
      kind: this.kind,
      key: this.key,
      target: this.target,
      allow: this.allows,
      deny: this.denys,
    };
  }
}

export type ReadTarget = AnyEntity | AnyTrait | (AnyField & { readonly ident: string });
export type RunTarget = AnyPolicyOperation;

const ownerOfComposer = (target: AnyEntity | AnyTrait): RelativeOwnerRef => ({
  kind: target._tag === "Trait" ? "trait" : "entity",
  name: target.ns,
});

const fieldKeyOf = (
  schema: AnySchema,
  field: AnyField & { readonly ident: string; readonly attrName?: string },
): string => {
  const ident = field.ident;
  const rest = ident.startsWith(":") ? ident.slice(1) : ident;
  const slash = rest.indexOf("/");
  const ns = slash >= 0 ? rest.slice(0, slash) : rest;
  const local = field.attrName ?? (slash >= 0 ? rest.slice(slash + 1) : rest);
  const kind = schema.entities[ns] !== undefined ? "entity" : "trait";
  return `${kind}:${ns}/${local}`;
};

const fieldRefOf = (
  schema: AnySchema,
  field: AnyField & { readonly ident: string; readonly attrName?: string },
): RelativeFieldRef => {
  const ident = field.ident;
  const rest = ident.startsWith(":") ? ident.slice(1) : ident;
  const slash = rest.indexOf("/");
  const ns = slash >= 0 ? rest.slice(0, slash) : rest;
  const local = field.attrName ?? (slash >= 0 ? rest.slice(slash + 1) : rest);
  return {
    owner: {
      kind: schema.entities[ns] !== undefined ? "entity" : "trait",
      name: ns,
    },
    localName: local,
  };
};

type ClaimShape<CF extends SchemaNS.Struct.Fields | undefined> = [CF] extends [
  SchemaNS.Struct.Fields,
]
  ? { readonly [K in keyof CF]: ClaimCell }
  : Record<never, never>;

type InputShape<I> = { readonly [K in keyof I & string]: InputCell };

export type ResourceSnapshot<F extends AnyEntity | AnyTrait> = {
  readonly [K in keyof F["fields"] & string]: PathCell;
} & { readonly id: PathCell };

export type EntityRuleContext<
  F extends AnyEntity | AnyTrait,
  Claims,
> = {
  readonly me: MeCell;
  readonly subject: SubjectCell;
  readonly claims: Claims;
  readonly resource: ResourceSnapshot<F>;
};

export type TargetedOpContext<
  Owner extends AnyEntity | AnyTrait,
  Input,
  Claims,
> = {
  readonly me: MeCell;
  readonly subject: SubjectCell;
  readonly claims: Claims;
  readonly resource: ResourceSnapshot<Owner>;
  readonly input: InputShape<Input>;
};

export type TargetlessOpContext<Input, Claims> = {
  readonly me: MeCell;
  readonly subject: SubjectCell;
  readonly claims: Claims;
  readonly input: InputShape<Input>;
};

export type RuleContext<Focus, Claims> = Focus extends PolicyOperation<
  infer Owner,
  string,
  infer Target,
  infer Input
>
  ? Target extends "none"
    ? TargetlessOpContext<Input, Claims>
    : TargetedOpContext<Owner, Input, Claims>
  : Focus extends AnyEntity | AnyTrait
    ? EntityRuleContext<Focus, Claims>
    : never;

const claimsOf = (
  struct: { readonly fields?: Readonly<Record<string, unknown>> } | undefined,
): string[] => {
  if (struct === undefined || struct.fields === undefined) return [];
  return Object.keys(struct.fields);
};

export interface PolicyOptions<
  CF extends SchemaNS.Struct.Fields | undefined = undefined,
  Classes extends string = string,
> {
  readonly principal: {
    readonly subjectClaim: string;
    readonly entity?: AnyField & { readonly ident: string; readonly attrName?: string };
  };
  readonly claims?: [CF] extends [SchemaNS.Struct.Fields] ? SchemaNS.Struct<CF> : never;
  readonly classes?: readonly Classes[];
}

export interface PolicyHelpers<
  C extends AnySchema,
  Claims,
  Classes extends string,
> {
  readonly rule: {
    <F extends AnyEntity | AnyTrait>(
      focus: F,
      body: (ctx: EntityRuleContext<F, Claims>) => AuthExpr,
    ): AuthRule<F>;
    <
      Owner extends AnyEntity | AnyTrait,
      LocalName extends string,
      Target extends "required" | "none",
      Input,
    >(
      focus: PolicyOperation<Owner, LocalName, Target, Input>,
      body: (
        ctx: RuleContext<PolicyOperation<Owner, LocalName, Target, Input>, Claims>,
      ) => AuthExpr,
    ): AuthRule<PolicyOperation<Owner, LocalName, Target, Input>>;
  };
  readonly read: (target: ReadTarget) => DecisionBuilder;
  readonly run: (target: RunTarget) => DecisionBuilder;
  readonly always: AuthExpr;
  readonly self: AuthExpr;
  readonly hasClass: (name: Classes) => AuthExpr;
  readonly exists: typeof exists;
  readonly and: typeof and;
  readonly or: typeof or;
  readonly not: typeof not;
  readonly schema: C;
}

export interface CompiledAuthoring {
  readonly schema: AnySchema;
  readonly options: PolicyOptions<SchemaNS.Struct.Fields | undefined, string>;
  readonly bindings: readonly PolicyBinding[];
  readonly rules: readonly AuthRule[];
  readonly operations: readonly AnyPolicyOperation[];
  readonly claimKeys: readonly string[];
  readonly classes: readonly string[];
  readonly principalField?: RelativeFieldRef;
}

const collectOperations = (bindings: readonly PolicyBinding[]): AnyPolicyOperation[] => {
  const seen = new Map<string, AnyPolicyOperation>();
  const visit = (target: unknown): void => {
    if (isPolicyOperation(target)) {
      const key = `${target.owner._tag}:${target.owner.ns}/${target.localName}:${target.target}`;
      seen.set(key, target);
    }
  };
  for (const binding of bindings) {
    visit(binding.target);
    for (const arm of [...binding.allow, ...binding.deny]) {
      if (!isAuthExpr(arm)) visit(arm.focus);
    }
  }
  return [...seen.values()];
};

export const authorPolicy = <
  C extends AnySchema,
  CF extends SchemaNS.Struct.Fields | undefined,
  const Classes extends string,
>(
  schema: C,
  options: PolicyOptions<CF, Classes>,
  body: (
    helpers: PolicyHelpers<C, ClaimShape<CF>, Classes>,
  ) => readonly DecisionBuilder[],
): CompiledAuthoring => {
  const claimKeys = claimsOf(options.claims as SchemaNS.Struct<SchemaNS.Struct.Fields> | undefined);
  const classes = options.classes ?? [];
  const claims = claimCells(claimKeys) as ClaimShape<CF>;

  const rule = ((focus: AnyEntity | AnyTrait | AnyPolicyOperation, fn: (ctx: never) => AuthExpr) => {
    if (isPolicyOperation(focus)) {
      const owner = ownerOfComposer(focus.owner);
      const resource = snapshotOf(
        owner,
        focus.owner.fields as Record<string, AnyField & { readonly ident?: string }>,
      );
      const ctx = {
        me,
        subject,
        claims,
        input: inputCells(focus.inputKeys),
        ...(focus.target === "required" ? { resource } : {}),
      };
      return {
        _tag: "AuthRule" as const,
        focus,
        irFocus: {
          _tag: "operation" as const,
          owner,
          localName: focus.localName,
          target: focus.target,
        },
        expr: fn(ctx as never),
      };
    }
    const owner = ownerOfComposer(focus);
    const resource = snapshotOf(
      owner,
      focus.fields as Record<string, AnyField & { readonly ident?: string }>,
    );
    return {
      _tag: "AuthRule" as const,
      focus,
      irFocus: focus._tag === "Trait"
        ? { _tag: "trait" as const, name: focus.ns }
        : { _tag: "entity" as const, name: focus.ns },
      expr: fn({ me, subject, claims, resource } as never),
    };
  }) as PolicyHelpers<C, ClaimShape<CF>, Classes>["rule"];

  const read = (target: ReadTarget): DecisionBuilder => {
    if ("_tag" in target && target._tag === "Entity") {
      return new DecisionBuilder("row", target.ns, target);
    }
    if ("_tag" in target && target._tag === "Trait") {
      return new DecisionBuilder("trait", target.ns, target);
    }
    return new DecisionBuilder("field", fieldKeyOf(schema, target), target);
  };

  const run = (target: RunTarget): DecisionBuilder =>
    new DecisionBuilder(
      "operation",
      `${target.owner._tag === "Trait" ? "trait" : "entity"}:${target.owner.ns}/${target.localName}:${target.target}`,
      target,
    );

  const builders = body({
    rule,
    read,
    run,
    always,
    self,
    hasClass: hasClass as (name: Classes) => AuthExpr,
    exists,
    and,
    or,
    not,
    schema,
  });

  const bindings = builders.map((builder) => builder.collect());
  const rules = bindings.flatMap((binding) =>
    [...binding.allow, ...binding.deny].filter((arm): arm is AuthRule => !isAuthExpr(arm)),
  );

  return {
    schema,
    options: options as PolicyOptions<SchemaNS.Struct.Fields | undefined, string>,
    bindings,
    rules,
    operations: collectOperations(bindings),
    claimKeys,
    classes,
    principalField:
      options.principal.entity === undefined
        ? undefined
        : fieldRefOf(schema, options.principal.entity),
  };
};

void fieldRefOf;
export { DecisionBuilder, fieldKeyOf, fieldRefOf };
