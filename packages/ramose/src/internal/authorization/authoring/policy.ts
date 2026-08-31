import {
  reachableTraits,
  type ComposerLike,
} from "../../../db/compose.ts";
import type { AnyEntity } from "../../../db/Entity.ts";
import {
  isOwnedOperation,
  OwnedOperations,
  type AnyOwnedOperation,
} from "../../../db/Operation.ts";
import type { EntityMap, Schema } from "../../../db/Schema.ts";
import type { PathCarrier } from "../../../db/shapes.ts";
import type { AnyTrait } from "../../../db/Trait.ts";
import type { ClaimDescriptor } from "../principal.ts";
import { compileReadAuthorizationResult } from "./compile.ts";
import { all, allow, any, contains, eq, hasClass } from "./expr.ts";
import { invoke } from "./invoke.ts";
import { $ } from "./path.ts";
import { read, type ReadBuilder } from "./read.ts";
import type {
  AuthExpr,
  AuthOperandInput,
  AuthPathLike,
  AuthPathProxy,
  AuthorizationRule,
  BoxedOperand,
  CompileReadAuthorizationInput,
  ReadTarget,
} from "./types.ts";

type PrincipalField<Field, Namespace extends string> = Field extends
  & PathCarrier
  & {
    readonly ident: `:${Namespace}/${string}`;
    readonly cardinality: "one";
    readonly unique: "strict" | "upsert";
    readonly valueType: "string" | "uuid";
  }
  ? Field
  : never;

type EntityPrincipalFields<Es extends EntityMap> = {
  readonly [K in keyof Es]: Es[K] extends {
    readonly ns: infer Namespace extends string;
    readonly fields: infer Fields;
  }
    ? PrincipalField<Fields[keyof Fields], Namespace>
    : never;
}[keyof Es];

export type SchemaPrincipalField<Es extends EntityMap> = EntityPrincipalFields<Es>;

type DirectTraits<Owner> = Owner extends {
  readonly traits: readonly (infer Trait)[];
}
  ? Trait extends AnyTrait
    ? Trait
    : never
  : never;

type TraitClosure<
  Trait,
  SeenNames extends string = never,
> = Trait extends AnyTrait
  ? Trait["ns"] extends SeenNames
    ? never
    : Trait | TraitClosure<DirectTraits<Trait>, SeenNames | Trait["ns"]>
  : never;

type ReachableTrait<Es extends EntityMap> = string extends keyof Es
  ? never
  : TraitClosure<DirectTraits<Es[keyof Es]>>;

type ScalarClaimValue<ValueType> = ValueType extends "string"
  ? string
  : ValueType extends "long" | "double"
    ? number
    : ValueType extends "boolean"
      ? boolean
      : never;

type ClaimValue<Descriptor> = Descriptor extends {
  readonly shape: infer Shape;
}
  ? Shape extends { readonly _tag: "scalar"; readonly valueType: infer ValueType }
    ? ScalarClaimValue<ValueType>
    : Shape extends {
          readonly _tag: "array";
          readonly items: { readonly valueType: infer ValueType };
        }
      ? readonly ScalarClaimValue<ValueType>[]
      : never
  : never;

type OperandOf<Tag extends BoxedOperand["_tag"]> = Extract<
  BoxedOperand,
  { readonly _tag: Tag }
>;

type ContainedValue<Value> = Value extends readonly (infer Element)[]
  ? Element
  : Value;

type LiteralValue<Value> = Value extends readonly unknown[] ? never : Value;

declare const PolicyOperandValue: unique symbol;

type SymbolicOperand<Value> =
  | AuthPathLike
  | PathCarrier
  | PolicyOperand<"claim", Value>
  | ([Value] extends [string] ? PolicyOperand<"subject", string> : never);

export type PolicyOperand<
  Tag extends BoxedOperand["_tag"],
  Value = unknown,
> = OperandOf<Tag> & {
  readonly [PolicyOperandValue]?: Value;
  readonly eq: (rhs: SymbolicOperand<Value> | LiteralValue<Value>) => AuthExpr;
} & (Value extends readonly unknown[]
  ? {
      readonly contains: (
        rhs: SymbolicOperand<ContainedValue<Value>> | ContainedValue<Value>
      ) => AuthExpr;
    }
  : {});

type ClaimOperands<Claims extends readonly ClaimDescriptor[]> = {
  readonly [Descriptor in Claims[number] as Descriptor["key"]]: PolicyOperand<
    "claim",
    ClaimValue<Descriptor>
  >;
};

type RolePredicates<Roles extends readonly string[]> = {
  readonly [Role in Roles[number]]: AuthExpr;
};

export type PolicySession<
  Roles extends readonly string[],
  Claims extends readonly ClaimDescriptor[],
> = {
  readonly subject: PolicyOperand<"subject", string>;
  readonly claims: ClaimOperands<Claims>;
  readonly roles: RolePredicates<Roles>;
  readonly hasRole: (role: Roles[number]) => AuthExpr;
};

export type PolicyReadMethods<Proxy> = {
  readonly where: (expr: AuthExpr | ((row: Proxy) => AuthExpr)) => void;
  readonly denyWhere: (expr: AuthExpr | ((row: Proxy) => AuthExpr)) => void;
  readonly always: () => void;
  readonly never: () => void;
};

export type PolicyOperationMethods = {
  readonly where: (expr: AuthExpr) => void;
  readonly denyWhere: (expr: AuthExpr) => void;
  readonly always: () => void;
  readonly never: () => void;
};

type OperationsOf<Owner> = Owner extends {
  readonly [OwnedOperations]: infer Operations extends Readonly<Record<string, AnyOwnedOperation>>;
}
  ? Operations
  : {};

type FieldsOf<Owner> = Owner extends {
  readonly fields: infer Fields extends Readonly<Record<string, unknown>>;
}
  ? Fields
  : {};

type OwnerPolicy<Owner extends AnyEntity | AnyTrait> = {
  readonly read: PolicyReadMethods<AuthPathProxy<FieldsOf<Owner>>>;
  readonly fields: {
    readonly [K in keyof FieldsOf<Owner>]: {
      readonly read: PolicyReadMethods<AuthPathProxy<FieldsOf<Owner>>>;
    };
  };
  readonly operations: {
    readonly [K in keyof OperationsOf<Owner>]: PolicyOperationMethods;
  };
};

type TraitPolicyEntry<Trait> = Trait extends AnyTrait
  ? { readonly [Name in Trait["ns"]]: OwnerPolicy<Trait> }
  : unknown;

type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

type TraitPolicy<Es extends EntityMap> = UnionToIntersection<
  TraitPolicyEntry<ReachableTrait<Es>>
>;

export type SchemaPolicy<Es extends EntityMap> = {
  readonly [K in keyof Es]: OwnerPolicy<Es[K]>;
} & TraitPolicy<Es>;

export type SchemaPolicyConfig<
  Es extends EntityMap,
  Roles extends readonly string[] = readonly [],
  Claims extends readonly ClaimDescriptor[] = readonly [],
> = {
  readonly principal?: SchemaPrincipalField<Es>;
  readonly roles?: Roles;
  readonly claims?: Claims;
};

export type PolicyContext<
  Es extends EntityMap,
  Roles extends readonly string[],
  Claims extends readonly ClaimDescriptor[],
> = {
  readonly policy: SchemaPolicy<Es>;
  readonly actor: PolicyOperand<"me">;
  readonly session: PolicySession<Roles, Claims>;
  readonly allOf: (first: AuthExpr, ...rest: readonly AuthExpr[]) => AuthExpr;
};

export type PolicyDefinition<
  Es extends EntityMap,
  Roles extends readonly string[],
  Claims extends readonly ClaimDescriptor[],
> = (context: PolicyContext<Es, Roles, Claims>) => void;

export interface ApplyPolicy<Es extends EntityMap> {
  (define: PolicyDefinition<Es, readonly [], readonly []>): void;
  <
    const Roles extends readonly string[] = readonly [],
    const Claims extends readonly ClaimDescriptor[] = readonly [],
  >(
    config: SchemaPolicyConfig<Es, Roles, Claims>,
    define: PolicyDefinition<Es, Roles, Claims>,
  ): void;
}

const policyOperand = <Tag extends "me" | "subject" | "claim", Value>(
  operand: OperandOf<Tag>,
): PolicyOperand<Tag, Value> =>
  Object.freeze({
    ...operand,
    eq: (rhs: SymbolicOperand<Value> | LiteralValue<Value>) =>
      eq(operand, rhs as AuthOperandInput),
    contains: (
      rhs: SymbolicOperand<ContainedValue<Value>> | ContainedValue<Value>,
    ) => contains(operand, rhs as AuthOperandInput),
  }) as PolicyOperand<Tag, Value>;

const readMethods = (
  target: ReadTarget,
  rules: AuthorizationRule[],
  callbackOwner?: AnyEntity | AnyTrait,
): PolicyReadMethods<AuthPathProxy> => {
  const builder = (read as unknown as (
    target: ReadTarget,
  ) => ReadBuilder<AuthPathProxy>)(target);
  const resolve = (
    expr: AuthExpr | ((row: AuthPathProxy) => AuthExpr),
  ): AuthExpr | ((row: AuthPathProxy) => AuthExpr) =>
    callbackOwner !== undefined && typeof expr === "function"
      ? expr($(callbackOwner))
      : expr;
  const allowExprs: AuthExpr[] = [];
  const denyExprs: AuthExpr[] = [];
  let allowIndex: number | undefined;
  let denyIndex: number | undefined;
  const append = (
    kind: "allow" | "deny",
    expr: AuthExpr | ((row: AuthPathProxy) => AuthExpr),
  ): void => {
    const resolved = resolve(expr) as AuthExpr;
    const exprs = kind === "allow" ? allowExprs : denyExprs;
    exprs.push(resolved);
    const combined = exprs.length === 1 ? resolved : any(...exprs);
    const rule = kind === "allow"
      ? builder.when(combined)
      : builder.deny(combined);
    const index = kind === "allow" ? allowIndex : denyIndex;
    if (index === undefined) {
      const nextIndex = rules.push(rule) - 1;
      if (kind === "allow") allowIndex = nextIndex;
      else denyIndex = nextIndex;
    } else {
      rules[index] = rule;
    }
  };
  return Object.freeze({
    where(expr) {
      append("allow", expr);
    },
    denyWhere(expr) {
      append("deny", expr);
    },
    always() {
      append("allow", allow);
    },
    never() {
      append("deny", allow);
    },
  });
};

const operationMethods = (
  target: AnyOwnedOperation,
  rules: AuthorizationRule[],
): PolicyOperationMethods => {
  const builder = invoke(target);
  const allowExprs: AuthExpr[] = [];
  const denyExprs: AuthExpr[] = [];
  let allowIndex: number | undefined;
  let denyIndex: number | undefined;
  const append = (kind: "allow" | "deny", expr: AuthExpr): void => {
    const exprs = kind === "allow" ? allowExprs : denyExprs;
    exprs.push(expr);
    const combined = exprs.length === 1 ? expr : any(...exprs);
    const rule = kind === "allow"
      ? builder.when(combined)
      : builder.deny(combined);
    const index = kind === "allow" ? allowIndex : denyIndex;
    if (index === undefined) {
      const nextIndex = rules.push(rule) - 1;
      if (kind === "allow") allowIndex = nextIndex;
      else denyIndex = nextIndex;
    } else {
      rules[index] = rule;
    }
  };
  return Object.freeze({
    where(expr) {
      append("allow", expr);
    },
    denyWhere(expr) {
      append("deny", expr);
    },
    always() {
      append("allow", allow);
    },
    never() {
      append("deny", allow);
    },
  });
};

const ownerPolicy = (
  owner: AnyEntity | AnyTrait,
  rules: AuthorizationRule[],
): OwnerPolicy<AnyEntity | AnyTrait> => {
  const fields: Record<string, { readonly read: PolicyReadMethods<AuthPathProxy> }> = {};
  for (const [name, field] of Object.entries(owner.fields)) {
    fields[name] = Object.freeze({ read: readMethods(field, rules, owner) });
  }

  const operations: Record<string, PolicyOperationMethods> = {};
  for (const [name, operation] of Object.entries(owner[OwnedOperations] ?? {})) {
    if (isOwnedOperation(operation)) {
      operations[name] = operationMethods(operation, rules);
    }
  }

  return Object.freeze({
    read: readMethods(owner, rules, owner),
    fields: Object.freeze(fields),
    operations: Object.freeze(operations),
  }) as OwnerPolicy<AnyEntity | AnyTrait>;
};

const policyFor = <Es extends EntityMap>(
  schema: Schema<string, Es>,
  rules: AuthorizationRule[],
): SchemaPolicy<Es> => {
  const policy: Record<string, OwnerPolicy<AnyEntity | AnyTrait>> = {};
  for (const [name, entity] of Object.entries(schema.entities)) {
    policy[name] = ownerPolicy(entity, rules);
  }
  const traits = reachableTraits(
    Object.values(schema.entities) as ComposerLike[],
  );
  for (const [name, trait] of traits) {
    policy[name] = ownerPolicy(trait as unknown as AnyTrait, rules);
  }
  return Object.freeze(policy) as SchemaPolicy<Es>;
};

const sessionFor = <
  Roles extends readonly string[],
  Claims extends readonly ClaimDescriptor[],
>(
  roles: Roles,
  claims: Claims,
): PolicySession<Roles, Claims> => {
  const rolePredicates: Record<string, AuthExpr> = {};
  for (const role of roles) rolePredicates[role] = hasClass(role);
  const declaredRoles = new Set(roles);

  const claimOperands: Record<string, PolicyOperand<"claim">> = {};
  for (const descriptor of claims) {
    claimOperands[descriptor.key] = policyOperand<"claim", unknown>({
      _tag: "claim",
      key: descriptor.key,
    });
  }

  return Object.freeze({
    subject: policyOperand<"subject", string>({ _tag: "subject" }),
    claims: Object.freeze(claimOperands),
    roles: Object.freeze(rolePredicates),
    hasRole(role: Roles[number]) {
      if (!declaredRoles.has(role)) {
        throw new Error(`ramose/policy: undeclared role ${JSON.stringify(role)}`);
      }
      return hasClass(role);
    },
  }) as PolicySession<Roles, Claims>;
};

const snapshotClaim = (descriptor: ClaimDescriptor): ClaimDescriptor => {
  const shape = descriptor.shape._tag === "scalar"
    ? Object.freeze({ ...descriptor.shape })
    : Object.freeze({
        ...descriptor.shape,
        items: Object.freeze({ ...descriptor.shape.items }),
      });
  return Object.freeze({ ...descriptor, shape });
};

const assertPrincipalField = <Es extends EntityMap>(
  schema: Schema<string, Es>,
  principal: PathCarrier | undefined,
): void => {
  if (principal === undefined) return;
  const entity = Object.values(schema.entities).find((candidate) =>
    Object.values(candidate.fields).some((field) => field === principal)
  );
  if (entity === undefined) {
    throw new Error("ramose/policy: principal field is not in this schema");
  }
  if (!principal.ident.startsWith(`:${entity.ns}/`)) {
    throw new Error("ramose/policy: principal field must be entity-owned");
  }
  const field = principal as PathCarrier & {
    readonly cardinality?: unknown;
    readonly unique?: unknown;
    readonly valueType?: unknown;
  };
  if (field.cardinality !== "one") {
    throw new Error("ramose/policy: principal field must have cardinality one");
  }
  if (field.unique !== "strict" && field.unique !== "upsert") {
    throw new Error("ramose/policy: principal field is not unique");
  }
  if (field.valueType !== "string" && field.valueType !== "uuid") {
    throw new Error("ramose/policy: principal field must be string-compatible");
  }
};

export function collectSchemaPolicy<Es extends EntityMap>(
  schema: Schema<string, Es>,
  define: PolicyDefinition<Es, readonly [], readonly []>,
): CompileReadAuthorizationInput;
export function collectSchemaPolicy<
  Es extends EntityMap,
  const Roles extends readonly string[] = readonly [],
  const Claims extends readonly ClaimDescriptor[] = readonly [],
>(
  schema: Schema<string, Es>,
  config: SchemaPolicyConfig<Es, Roles, Claims>,
  define: PolicyDefinition<Es, Roles, Claims>,
): CompileReadAuthorizationInput;
export function collectSchemaPolicy<Es extends EntityMap>(
  schema: Schema<string, Es>,
  configOrDefine:
    | SchemaPolicyConfig<Es, readonly string[], readonly ClaimDescriptor[]>
    | PolicyDefinition<Es, readonly [], readonly []>,
  maybeDefine?: PolicyDefinition<
    Es,
    readonly string[],
    readonly ClaimDescriptor[]
  >,
): CompileReadAuthorizationInput {
  const config = typeof configOrDefine === "function" ? {} : configOrDefine;
  const define = typeof configOrDefine === "function" ? configOrDefine : maybeDefine;
  if (define === undefined) {
    throw new Error("ramose/policy: applyPolicy requires a policy callback");
  }

  const roles = Object.freeze([...(config.roles ?? [])]);
  const claims = Object.freeze((config.claims ?? []).map(snapshotClaim));
  assertPrincipalField(schema, config.principal);
  const rules: AuthorizationRule[] = [];
  const callbackResult = (define as (
    context: PolicyContext<
      Es,
      readonly string[],
      readonly ClaimDescriptor[]
    >,
  ) => unknown)({
    policy: policyFor(schema, rules),
    actor: policyOperand<"me", unknown>({ _tag: "me" }),
    session: sessionFor(roles, claims),
    allOf: (first, ...rest) => all(first, ...rest),
  });
  if (
    (typeof callbackResult === "object" || typeof callbackResult === "function") &&
    callbackResult !== null &&
    typeof (callbackResult as { readonly then?: unknown }).then === "function"
  ) {
    Object.freeze(rules);
    void Promise.resolve(callbackResult).catch(() => undefined);
    throw new Error("ramose/policy: policy callback must be synchronous");
  }
  Object.freeze(rules);

  const input: CompileReadAuthorizationInput = Object.freeze({
    schema,
    rules,
    classes: roles,
    claims,
    ...(config.principal === undefined
      ? {}
      : { principal: Object.freeze({ entity: config.principal }) }),
  });
  const validation = compileReadAuthorizationResult(input);
  if (validation._tag === "Failure") throw validation.failure;
  return input;
}
