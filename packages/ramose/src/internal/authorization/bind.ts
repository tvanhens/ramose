import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { CatalogDescriptor, FieldRefTarget, OperationInputShape } from "./catalog.ts";
import { CatalogMismatch, InvalidIR } from "./failures.ts";
import type {
  EntityId,
  FieldId,
  OperationId,
  OperationTarget,
  OwnerKind,
  OwnerRef,
  RelativeEntityId,
  RelativeFieldId,
  RelativeOperationId,
  RelativeTraitId,
  RuleId,
  TraitId,
} from "./identities.ts";
import {
  BOUND_AUTHORIZATION_IR_VERSION,
  type BoundAuthorizationIR as BoundAuthorizationIRType,
  type CanonicalAuthorizationDecisions,
  type CanonicalAuthorizationRule,
  type CanonicalRuleFocus,
  type CatalogBindingInput,
  type CatalogBindingTarget,
  type Decision,
  type RelativeAuthorizationDecisions,
  type RelativeAuthorizationRule,
  type RelativeRuleFocus,
} from "./ir.ts";
import { AUTHORIZATION_LANGUAGE_VERSION } from "./version.ts";
import type {
  CanonicalAuthorizationExpr,
  CanonicalRefTerm,
  CanonicalValueTerm,
  RelativeAuthorizationExpr,
  RelativeRefTerm,
  RelativeValueTerm,
} from "./expr.ts";
import { canonicalAuthorizationRuleMaterial, hashCanonicalRule } from "./decode.ts";
import type { InstalledPrincipalResolution, PrincipalResolutionConfig } from "./principal.ts";

export type BindFailure = InvalidIR | CatalogMismatch;

const SEPARATOR = "\u0000";

const ownerKey = (owner: OwnerRef): string => `${owner.kind}${SEPARATOR}${owner.name}`;

const fieldKey = (owner: OwnerRef, localName: string): string =>
  `${owner.kind}${SEPARATOR}${owner.name}${SEPARATOR}${localName}`;

const operationKey = (owner: OwnerRef, localName: string, target: OperationTarget): string =>
  `${owner.kind}${SEPARATOR}${owner.name}${SEPARATOR}${localName}${SEPARATOR}${target}`;

const ownerNameLocalKey = (name: string, localName: string): string =>
  `${name}${SEPARATOR}${localName}`;

const otherOwnerKind = (kind: OwnerKind): OwnerKind => (kind === "entity" ? "trait" : "entity");

type CatalogIndex = {
  readonly target: CatalogBindingTarget;
  readonly entities: ReadonlyMap<string, EntityId>;
  readonly traits: ReadonlyMap<string, TraitId>;
  readonly fields: ReadonlyMap<string, FieldId>;
  readonly operations: ReadonlyMap<string, OperationId>;
  readonly owners: ReadonlyMap<string, OwnerRef>;
  readonly fieldsByOwnerName: ReadonlyMap<string, ReadonlyArray<FieldId>>;
};

const invalid = (message: string): Result.Result<never, BindFailure> =>
  Result.fail(new InvalidIR({ message }));

const mismatch = (
  fields: ConstructorParameters<typeof CatalogMismatch>[0],
): Result.Result<never, BindFailure> => Result.fail(new CatalogMismatch(fields));

const isBlank = (value: string): boolean => value.length === 0;

const requireNonBlank = (
  value: string,
  label: string,
): Result.Result<string, BindFailure> =>
  isBlank(value) ? mismatch({ message: `blank ${label}` }) : Result.succeed(value);

const intern = <K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  label: string,
): Result.Result<void, BindFailure> => {
  if (map.has(key)) {
    return invalid(`ambiguous ${label}`);
  }
  map.set(key, value);
  return Result.succeed(undefined);
};

const pushIndex = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
};

const catalogOfIdentity = (
  identity: { readonly catalog: string },
  expected: CatalogBindingTarget,
  label: string,
): Result.Result<void, BindFailure> => {
  if (identity.catalog !== expected.catalog) {
    return mismatch({
      message: `cross-catalog ${label}`,
      expected: expected.catalog,
      actual: identity.catalog as typeof expected.catalog,
    });
  }
  return Result.succeed(undefined);
};

const validateTarget = (
  target: CatalogBindingTarget,
  descriptor: CatalogDescriptor,
): Result.Result<void, BindFailure> =>
  Result.gen(function* () {
    yield* Result.all([
      requireNonBlank(target.database, "database"),
      requireNonBlank(target.catalog, "catalog id"),
      requireNonBlank(target.catalogVersion, "catalog version"),
      requireNonBlank(target.schemaFingerprint, "schema fingerprint"),
      requireNonBlank(descriptor.database, "descriptor database"),
      requireNonBlank(descriptor.id, "descriptor catalog id"),
      requireNonBlank(descriptor.version, "descriptor catalog version"),
      requireNonBlank(descriptor.fingerprint, "descriptor schema fingerprint"),
    ]);

    if (target.database !== descriptor.database) {
      return yield* mismatch({
        message: "cross-database catalog",
        expectedDatabase: target.database,
        actualDatabase: descriptor.database,
      });
    }
    if (target.catalog !== descriptor.id) {
      return yield* mismatch({
        message: "cross-catalog descriptor",
        expected: target.catalog,
        actual: descriptor.id,
      });
    }
    if (target.catalogVersion !== descriptor.version) {
      return yield* mismatch({
        message: "stale catalog version",
        expected: target.catalog,
        actual: descriptor.id,
        expectedVersion: target.catalogVersion,
        actualVersion: descriptor.version,
      });
    }
    if (target.schemaFingerprint !== descriptor.fingerprint) {
      return yield* mismatch({
        message: "schema fingerprint mismatch",
        expected: target.catalog,
        actual: descriptor.id,
        expectedFingerprint: target.schemaFingerprint,
        actualFingerprint: descriptor.fingerprint,
      });
    }
  });

const indexCatalog = (
  target: CatalogBindingTarget,
  descriptor: CatalogDescriptor,
): Result.Result<CatalogIndex, BindFailure> =>
  Result.gen(function* () {
    yield* validateTarget(target, descriptor);

    const entities = new Map<string, EntityId>();
    const traits = new Map<string, TraitId>();
    const fields = new Map<string, FieldId>();
    const operations = new Map<string, OperationId>();
    const owners = new Map<string, OwnerRef>();
    const fieldsByOwnerName = new Map<string, FieldId[]>();

    for (const entity of descriptor.entities) {
      yield* catalogOfIdentity(entity.id, target, "entity");
      if (isBlank(entity.id.name)) return yield* invalid("blank entity name");
      yield* intern(entities, entity.id.name, entity.id, `entity identity '${entity.id.name}'`);
      const owner: OwnerRef = { kind: "entity", name: entity.id.name };
      yield* intern(owners, ownerKey(owner), owner, `owner '${ownerKey(owner)}'`);
    }

    for (const trait of descriptor.traits) {
      yield* catalogOfIdentity(trait.id, target, "trait");
      if (isBlank(trait.id.name)) return yield* invalid("blank trait name");
      yield* intern(traits, trait.id.name, trait.id, `trait identity '${trait.id.name}'`);
      const owner: OwnerRef = { kind: "trait", name: trait.id.name };
      yield* intern(owners, ownerKey(owner), owner, `owner '${ownerKey(owner)}'`);
    }

    for (const field of descriptor.fields) {
      yield* catalogOfIdentity(field.id, target, "field");
      if (isBlank(field.id.localName)) return yield* invalid("blank field local name");
      if (isBlank(field.id.owner.name)) return yield* invalid("blank field owner name");
      if (!owners.has(ownerKey(field.id.owner))) {
        return yield* invalid(
          `missing owner ${field.id.owner.kind} '${field.id.owner.name}' for field '${field.id.localName}'`,
        );
      }
      yield* intern(
        fields,
        fieldKey(field.id.owner, field.id.localName),
        field.id,
        `field identity '${field.id.owner.kind}:${field.id.owner.name}.${field.id.localName}'`,
      );
      pushIndex(fieldsByOwnerName, ownerNameLocalKey(field.id.owner.name, field.id.localName), field.id);
      if (field.valueType === "ref") {
        yield* validateRefTarget(field.refTarget, target, entities, traits, "field ref target");
      }
    }

    for (const operation of descriptor.operations) {
      yield* catalogOfIdentity(operation.id, target, "operation");
      if (isBlank(operation.id.localName)) return yield* invalid("blank operation local name");
      if (isBlank(operation.id.owner.name)) return yield* invalid("blank operation owner name");
      if (!owners.has(ownerKey(operation.id.owner))) {
        return yield* invalid(
          `missing owner ${operation.id.owner.kind} '${operation.id.owner.name}' for operation '${operation.id.localName}'`,
        );
      }
      yield* intern(
        operations,
        operationKey(operation.id.owner, operation.id.localName, operation.id.target),
        operation.id,
        `operation identity '${operation.id.owner.kind}:${operation.id.owner.name}.${operation.id.localName}:${operation.id.target}'`,
      );
      yield* validateInputShape(operation.input, target, entities, traits);
    }

    for (const entity of descriptor.entities) {
      for (const trait of entity.traits) {
        yield* catalogOfIdentity(trait, target, "entity trait");
        if (!traits.has(trait.name)) {
          return yield* invalid(`missing trait '${trait.name}' composed by entity '${entity.id.name}'`);
        }
      }
    }
    for (const trait of descriptor.traits) {
      for (const composed of trait.traits) {
        yield* catalogOfIdentity(composed, target, "trait composition");
        if (!traits.has(composed.name)) {
          return yield* invalid(`missing trait '${composed.name}' composed by trait '${trait.id.name}'`);
        }
      }
    }
    for (const row of descriptor.traitComposition) {
      yield* catalogOfIdentity(row.composer, target, "trait-composition composer");
      yield* catalogOfIdentity(row.trait, target, "trait-composition trait");
      if (!entities.has(row.composer.name)) {
        return yield* invalid(`missing composer entity '${row.composer.name}'`);
      }
      if (!traits.has(row.trait.name)) {
        return yield* invalid(`missing composed trait '${row.trait.name}'`);
      }
      for (const transitive of row.transitive) {
        yield* catalogOfIdentity(transitive, target, "trait-composition transitive");
        if (!traits.has(transitive.name)) {
          return yield* invalid(`missing transitive trait '${transitive.name}'`);
        }
      }
    }

    return {
      target,
      entities,
      traits,
      fields,
      operations,
      owners,
      fieldsByOwnerName,
    };
  });

const validateRefTarget = (
  refTarget: FieldRefTarget | undefined,
  target: CatalogBindingTarget,
  entities: ReadonlyMap<string, EntityId>,
  traits: ReadonlyMap<string, TraitId>,
  label: string,
): Result.Result<void, BindFailure> =>
  Result.gen(function* () {
    if (refTarget === undefined || refTarget._tag === "self" || refTarget._tag === "untargeted") {
      return;
    }
    if (refTarget._tag === "entity") {
      yield* catalogOfIdentity(refTarget.entity, target, label);
      if (!entities.has(refTarget.entity.name)) {
        return yield* invalid(`missing ${label} entity '${refTarget.entity.name}'`);
      }
      return;
    }
    yield* catalogOfIdentity(refTarget.trait, target, label);
    if (!traits.has(refTarget.trait.name)) {
      return yield* invalid(`missing ${label} trait '${refTarget.trait.name}'`);
    }
  });

const validateInputShape = (
  shape: OperationInputShape,
  target: CatalogBindingTarget,
  entities: ReadonlyMap<string, EntityId>,
  traits: ReadonlyMap<string, TraitId>,
): Result.Result<void, BindFailure> => {
  switch (shape._tag) {
    case "scalar":
    case "opaque":
      return Result.succeed(undefined);
    case "ref":
      return validateRefTarget(shape.refTarget, target, entities, traits, "operation input ref target");
    case "array":
      return validateInputShape(shape.items, target, entities, traits);
    case "struct":
      return Result.gen(function* () {
        for (const field of shape.fields) {
          yield* validateInputShape(field.shape, target, entities, traits);
        }
      });
  }
};

const bindEntity = (
  index: CatalogIndex,
  relative: RelativeEntityId,
): Result.Result<EntityId, BindFailure> => {
  if (isBlank(relative.name)) return invalid("blank entity name");
  const bound = index.entities.get(relative.name);
  if (bound === undefined) {
    return invalid(`missing entity '${relative.name}'`);
  }
  return Result.succeed(bound);
};

const bindTrait = (
  index: CatalogIndex,
  relative: RelativeTraitId,
): Result.Result<TraitId, BindFailure> => {
  if (isBlank(relative.name)) return invalid("blank trait name");
  const bound = index.traits.get(relative.name);
  if (bound === undefined) {
    return invalid(`missing trait '${relative.name}'`);
  }
  return Result.succeed(bound);
};

const bindField = (
  index: CatalogIndex,
  relative: RelativeFieldId,
): Result.Result<FieldId, BindFailure> => {
  if (isBlank(relative.localName)) return invalid("blank field local name");
  if (isBlank(relative.owner.name)) return invalid("blank field owner name");
  const exact = index.fields.get(fieldKey(relative.owner, relative.localName));
  if (exact !== undefined) return Result.succeed(exact);

  const sameName = index.fieldsByOwnerName.get(
    ownerNameLocalKey(relative.owner.name, relative.localName),
  );
  if (sameName !== undefined) {
    const otherKind = sameName.find((field) => field.owner.kind !== relative.owner.kind);
    if (otherKind !== undefined) {
      return invalid(
        `wrong owner kind for field '${relative.owner.name}.${relative.localName}': expected ${relative.owner.kind}`,
      );
    }
  }

  if (!index.owners.has(ownerKey(relative.owner))) {
    const swapped: OwnerRef = { kind: otherOwnerKind(relative.owner.kind), name: relative.owner.name };
    if (index.owners.has(ownerKey(swapped))) {
      return invalid(
        `wrong owner kind for field '${relative.owner.name}.${relative.localName}': expected ${relative.owner.kind}`,
      );
    }
    return invalid(
      `missing owner ${relative.owner.kind} '${relative.owner.name}' for field '${relative.localName}'`,
    );
  }

  return invalid(
    `wrong local name for field '${relative.owner.kind}:${relative.owner.name}.${relative.localName}'`,
  );
};

const bindOperation = (
  index: CatalogIndex,
  relative: RelativeOperationId,
): Result.Result<OperationId, BindFailure> => {
  if (isBlank(relative.localName)) return invalid("blank operation local name");
  if (isBlank(relative.owner.name)) return invalid("blank operation owner name");
  const exact = index.operations.get(
    operationKey(relative.owner, relative.localName, relative.target),
  );
  if (exact !== undefined) return Result.succeed(exact);

  if (!index.owners.has(ownerKey(relative.owner))) {
    const swapped: OwnerRef = { kind: otherOwnerKind(relative.owner.kind), name: relative.owner.name };
    if (index.owners.has(ownerKey(swapped))) {
      return invalid(
        `wrong owner kind for operation '${relative.owner.name}.${relative.localName}': expected ${relative.owner.kind}`,
      );
    }
    return invalid(
      `missing owner ${relative.owner.kind} '${relative.owner.name}' for operation '${relative.localName}'`,
    );
  }

  return invalid(
    `missing operation '${relative.owner.kind}:${relative.owner.name}.${relative.localName}:${relative.target}'`,
  );
};

const bindFocus = (
  index: CatalogIndex,
  focus: RelativeRuleFocus,
): Result.Result<CanonicalRuleFocus, BindFailure> =>
  Result.gen(function* () {
    switch (focus._tag) {
      case "entity": {
        const entity = yield* bindEntity(index, focus.entity);
        return { _tag: "entity" as const, entity };
      }
      case "trait": {
        const trait = yield* bindTrait(index, focus.trait);
        return { _tag: "trait" as const, trait };
      }
      case "field": {
        const field = yield* bindField(index, focus.field);
        return { _tag: "field" as const, field };
      }
      case "operation": {
        const operation = yield* bindOperation(index, focus.operation);
        return { _tag: "operation" as const, operation };
      }
    }
  });

const bindRefTerm = (
  index: CatalogIndex,
  term: RelativeRefTerm,
): Result.Result<CanonicalRefTerm, BindFailure> =>
  Result.gen(function* () {
    const steps: CanonicalRefTerm["steps"][number][] = [];
    for (const step of term.steps) {
      const field = yield* bindField(index, step.field);
      steps.push({ field });
    }
    return { _tag: "ref" as const, root: term.root, steps };
  });

const bindValueTerm = (
  index: CatalogIndex,
  term: RelativeValueTerm,
): Result.Result<CanonicalValueTerm, BindFailure> => {
  switch (term._tag) {
    case "ref":
      return bindRefTerm(index, term);
    case "lit":
    case "subject":
    case "me":
    case "claim":
      return Result.succeed(term);
  }
};

const bindExpr = (
  index: CatalogIndex,
  expr: RelativeAuthorizationExpr,
): Result.Result<CanonicalAuthorizationExpr, BindFailure> => {
  switch (expr._tag) {
    case "const":
    case "hasClass":
      return Result.succeed(expr);
    case "and":
    case "or":
      return Result.gen(function* () {
        const exprs = yield* Result.all(expr.exprs.map((child) => bindExpr(index, child)));
        return { _tag: expr._tag, exprs };
      });
    case "not":
      return Result.gen(function* () {
        const child = yield* bindExpr(index, expr.expr);
        return { _tag: "not" as const, expr: child };
      });
    case "eq":
      return Result.gen(function* () {
        const left = yield* bindValueTerm(index, expr.left);
        const right = yield* bindValueTerm(index, expr.right);
        return { _tag: "eq" as const, left, right };
      });
    case "has":
      return Result.gen(function* () {
        const term = yield* bindValueTerm(index, expr.term);
        return { _tag: "has" as const, term };
      });
    case "in":
      return Result.gen(function* () {
        const value = yield* bindValueTerm(index, expr.value);
        const collection = yield* bindValueTerm(index, expr.collection);
        return { _tag: "in" as const, value, collection };
      });
  }
};

const bindRule = (
  index: CatalogIndex,
  rule: RelativeAuthorizationRule,
): Result.Result<{ readonly rule: CanonicalAuthorizationRule; readonly material: string }, BindFailure> =>
  Result.gen(function* () {
    const focus = yield* bindFocus(index, rule.focus);
    const expr = yield* bindExpr(index, rule.expr);
    const bound: CanonicalAuthorizationRule = {
      id: rule.id,
      focus,
      expr,
      usesResource: rule.usesResource,
      usesMe: rule.usesMe,
      usesSubject: rule.usesSubject,
      traversalDepth: rule.traversalDepth,
    };
    const material = yield* canonicalAuthorizationRuleMaterial(bound);
    return { rule: bound, material };
  });

const remapRuleIds = (
  ids: ReadonlyArray<RuleId>,
  map: ReadonlyMap<RuleId, RuleId>,
): ReadonlyArray<RuleId> => ids.map((id) => map.get(id) ?? id);

const remapDecision = (
  decision: Decision,
  map: ReadonlyMap<RuleId, RuleId>,
): Decision => ({
  allow: remapRuleIds(decision.allow, map),
  deny: remapRuleIds(decision.deny, map),
});

const remapDecisionEntries = <Target>(
  entries: ReadonlyArray<{ readonly target: Target; readonly decision: Decision }>,
  map: ReadonlyMap<RuleId, RuleId>,
): ReadonlyArray<{ readonly target: Target; readonly decision: Decision }> =>
  entries.map((entry) => ({ ...entry, decision: remapDecision(entry.decision, map) }));

const bindDecisionEntries = <Relative, Canonical>(
  entries: ReadonlyArray<{ readonly target: Relative; readonly decision: Decision }>,
  bindTarget: (target: Relative) => Result.Result<Canonical, BindFailure>,
): Result.Result<
  ReadonlyArray<{ readonly target: Canonical; readonly decision: Decision }>,
  BindFailure
> =>
  Result.gen(function* () {
    const bound: { readonly target: Canonical; readonly decision: Decision }[] = [];
    const seen = new Set<unknown>();
    for (const entry of entries) {
      const target = yield* bindTarget(entry.target);
      if (seen.has(target)) {
        return yield* invalid("ambiguous bound decision target");
      }
      seen.add(target);
      bound.push({ target, decision: entry.decision });
    }
    return bound;
  });

const bindDecisions = (
  index: CatalogIndex,
  decisions: RelativeAuthorizationDecisions,
): Result.Result<CanonicalAuthorizationDecisions, BindFailure> =>
  Result.gen(function* () {
    const entities = yield* bindDecisionEntries(decisions.entities, (target) =>
      bindEntity(index, target),
    );
    const traits = yield* bindDecisionEntries(decisions.traits, (target) => bindTrait(index, target));
    const fields = yield* bindDecisionEntries(decisions.fields, (target) => bindField(index, target));
    const operations = yield* bindDecisionEntries(decisions.operations, (target) =>
      bindOperation(index, target)
    );
    return { entities, traits, fields, operations };
  });

const bindPrincipal = (
  index: CatalogIndex,
  principal: PrincipalResolutionConfig,
): Result.Result<InstalledPrincipalResolution, BindFailure> =>
  Result.gen(function* () {
    if (principal.entity === undefined) {
      return { subjectClaim: principal.subjectClaim };
    }
    const entity = yield* bindField(index, principal.entity);
    return { subjectClaim: principal.subjectClaim, entity };
  });

const clonePlain = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => clonePlain(item)) as T;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    copy[key] = clonePlain((value as Record<string, unknown>)[key]);
  }
  return copy as T;
};

const freezePlain = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) freezePlain(item);
  } else {
    for (const key of Object.keys(value)) {
      freezePlain((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
};

const freezeBound = <T>(value: T): T => freezePlain(clonePlain(value));

export const bindPolicyTemplateResult = (
  input: CatalogBindingInput,
): Result.Result<BoundAuthorizationIRType, BindFailure> =>
  Result.gen(function* () {
    const index = yield* indexCatalog(input.target, input.descriptor);
    const principal = yield* bindPrincipal(index, input.template.principal);
    const boundRules = yield* Result.all(input.template.rules.map((rule) => bindRule(index, rule)));

    const seen = new Map<RuleId, string>();
    const rules: CanonicalAuthorizationRule[] = [];
    for (let i = 0; i < input.template.rules.length; i++) {
      const source = input.template.rules[i]!.id;
      const { rule, material } = boundRules[i]!;
      const existing = seen.get(source);
      if (existing !== undefined) {
        return yield* invalid(
          existing === material
            ? `duplicate source rule id '${source}'`
            : `colliding source rule id '${source}'`,
        );
      }
      seen.set(source, material);
      rules.push(rule);
    }

    const decisions = yield* bindDecisions(index, input.template.decisions);
    return freezeBound({
      _tag: "BoundAuthorizationIR" as const,
      version: BOUND_AUTHORIZATION_IR_VERSION,
      languageVersion: AUTHORIZATION_LANGUAGE_VERSION,
      database: input.target.database,
      catalog: input.target.catalog,
      catalogVersion: input.target.catalogVersion,
      schemaFingerprint: input.target.schemaFingerprint,
      classes: input.template.classes,
      claims: input.template.claims,
      principal,
      rules,
      decisions,
    });
  });

const restampBoundRuleIds = Effect.fn("Authorization.restampBoundRuleIds")(function* (
  bound: BoundAuthorizationIRType,
): Effect.fn.Return<BoundAuthorizationIRType, BindFailure> {
  const idMap = new Map<RuleId, RuleId>();
  const rules: CanonicalAuthorizationRule[] = [];
  for (const rule of bound.rules) {
    const id = yield* hashCanonicalRule(rule);
    idMap.set(rule.id, id);
    rules.push({ ...rule, id });
  }
  return freezeBound({
    ...bound,
    rules,
    decisions: {
      entities: remapDecisionEntries(bound.decisions.entities, idMap),
      traits: remapDecisionEntries(bound.decisions.traits, idMap),
      fields: remapDecisionEntries(bound.decisions.fields, idMap),
      operations: remapDecisionEntries(bound.decisions.operations, idMap),
    },
  });
});

export const bindPolicyTemplate = Effect.fn("Authorization.bindPolicyTemplate")(function* (
  input: CatalogBindingInput,
): Effect.fn.Return<BoundAuthorizationIRType, BindFailure> {
  const bound = yield* Effect.fromResult(bindPolicyTemplateResult(input));
  return yield* restampBoundRuleIds(bound);
});

export interface AuthoritativeCatalogService {
  readonly resolve: (
    target: CatalogBindingTarget,
  ) => Effect.Effect<CatalogDescriptor, BindFailure>;
}

export class AuthoritativeCatalog extends Context.Service<
  AuthoritativeCatalog,
  AuthoritativeCatalogService
>()("ramose/authorization/AuthoritativeCatalog") {}

export const bindAgainstAuthoritativeCatalog = Effect.fn(
  "Authorization.bindAgainstAuthoritativeCatalog",
)(function* (target: CatalogBindingTarget, template: CatalogBindingInput["template"]) {
  const catalogs = yield* AuthoritativeCatalog;
  const descriptor = yield* catalogs.resolve(target);
  return yield* bindPolicyTemplate({ target, descriptor, template });
});
