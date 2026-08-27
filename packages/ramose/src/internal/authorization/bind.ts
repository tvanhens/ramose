/**
 * Catalog-binding kernel.
 *
 * Resolves every catalog-relative authorization identity against one
 * supplied {@link CatalogDescriptor}. No ambient lookup, global registry,
 * wire-name matching, inference, or caller-supplied canonical metadata
 * becomes authority. Each identity resolves exactly once.
 *
 * Pure where possible. Effect wraps the typed failure boundary and an
 * optional authoritative catalog capability. Failures stay
 * {@link InvalidIR} / {@link CatalogMismatch} — this layer does not
 * convert them to {@link import("./failures.ts").AuthorizationDenied}.
 *
 * The result is {@link BoundAuthorizationIR}: non-executable, not
 * accepted by runtime authorization, and structurally distinct from
 * {@link PolicyTemplateIR} and {@link InstalledAuthorizationIR}.
 */

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
import type {
  CanonicalAuthorizationExpr,
  CanonicalRefTerm,
  CanonicalValueTerm,
  RelativeAuthorizationExpr,
  RelativeRefTerm,
  RelativeValueTerm,
} from "./expr.ts";
import { hashCanonicalRuleSync } from "./decode.ts";
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

const ownerLocalKey = (owner: OwnerRef, localName: string): string =>
  `${owner.kind}${SEPARATOR}${owner.name}${SEPARATOR}${localName}`;

const otherOwnerKind = (kind: OwnerKind): OwnerKind => (kind === "entity" ? "trait" : "entity");

type CatalogIndex = {
  readonly target: CatalogBindingTarget;
  readonly entities: ReadonlyMap<string, EntityId>;
  readonly traits: ReadonlyMap<string, TraitId>;
  readonly fields: ReadonlyMap<string, FieldId>;
  readonly operations: ReadonlyMap<string, OperationId>;
  readonly owners: ReadonlyMap<string, OwnerRef>;
  readonly fieldsByOwnerName: ReadonlyMap<string, ReadonlyArray<FieldId>>;
  readonly operationsByOwnerLocal: ReadonlyMap<string, ReadonlyArray<OperationId>>;
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

const firstError = <A>(
  results: ReadonlyArray<Result.Result<A, BindFailure>>,
): Result.Result<ReadonlyArray<A>, BindFailure> => {
  const values: A[] = [];
  for (const result of results) {
    if (Result.isFailure(result)) return Result.fail(result.failure);
    values.push(result.success);
  }
  return Result.succeed(values);
};

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
): Result.Result<void, BindFailure> => {
  const blanks = firstError([
    requireNonBlank(target.database, "database"),
    requireNonBlank(target.catalog, "catalog id"),
    requireNonBlank(target.catalogVersion, "catalog version"),
    requireNonBlank(target.schemaFingerprint, "schema fingerprint"),
    requireNonBlank(descriptor.database, "descriptor database"),
    requireNonBlank(descriptor.id, "descriptor catalog id"),
    requireNonBlank(descriptor.version, "descriptor catalog version"),
    requireNonBlank(descriptor.fingerprint, "descriptor schema fingerprint"),
  ]);
  if (Result.isFailure(blanks)) return Result.fail(blanks.failure);

  if (target.database !== descriptor.database) {
    return mismatch({
      message: "cross-database catalog",
      expectedDatabase: target.database,
      actualDatabase: descriptor.database,
    });
  }
  if (target.catalog !== descriptor.id) {
    return mismatch({
      message: "cross-catalog descriptor",
      expected: target.catalog,
      actual: descriptor.id,
    });
  }
  if (target.catalogVersion !== descriptor.version) {
    return mismatch({
      message: "stale catalog version",
      expected: target.catalog,
      actual: descriptor.id,
      expectedVersion: target.catalogVersion,
      actualVersion: descriptor.version,
    });
  }
  if (target.schemaFingerprint !== descriptor.fingerprint) {
    return mismatch({
      message: "schema fingerprint mismatch",
      expected: target.catalog,
      actual: descriptor.id,
      expectedFingerprint: target.schemaFingerprint,
      actualFingerprint: descriptor.fingerprint,
    });
  }
  return Result.succeed(undefined);
};

const indexCatalog = (
  target: CatalogBindingTarget,
  descriptor: CatalogDescriptor,
): Result.Result<CatalogIndex, BindFailure> => {
  const targetOk = validateTarget(target, descriptor);
  if (Result.isFailure(targetOk)) return Result.fail(targetOk.failure);

  const entities = new Map<string, EntityId>();
  const traits = new Map<string, TraitId>();
  const fields = new Map<string, FieldId>();
  const operations = new Map<string, OperationId>();
  const owners = new Map<string, OwnerRef>();
  const fieldsByOwnerName = new Map<string, FieldId[]>();
  const operationsByOwnerLocal = new Map<string, OperationId[]>();

  for (const entity of descriptor.entities) {
    const scoped = catalogOfIdentity(entity.id, target, "entity");
    if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
    if (isBlank(entity.id.name)) return invalid("blank entity name");
    const added = intern(entities, entity.id.name, entity.id, `entity identity '${entity.id.name}'`);
    if (Result.isFailure(added)) return Result.fail(added.failure);
    const owner: OwnerRef = { kind: "entity", name: entity.id.name };
    const ownerAdded = intern(owners, ownerKey(owner), owner, `owner '${ownerKey(owner)}'`);
    if (Result.isFailure(ownerAdded)) return Result.fail(ownerAdded.failure);
  }

  for (const trait of descriptor.traits) {
    const scoped = catalogOfIdentity(trait.id, target, "trait");
    if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
    if (isBlank(trait.id.name)) return invalid("blank trait name");
    const added = intern(traits, trait.id.name, trait.id, `trait identity '${trait.id.name}'`);
    if (Result.isFailure(added)) return Result.fail(added.failure);
    const owner: OwnerRef = { kind: "trait", name: trait.id.name };
    const ownerAdded = intern(owners, ownerKey(owner), owner, `owner '${ownerKey(owner)}'`);
    if (Result.isFailure(ownerAdded)) return Result.fail(ownerAdded.failure);
  }

  for (const field of descriptor.fields) {
    const scoped = catalogOfIdentity(field.id, target, "field");
    if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
    if (isBlank(field.id.localName)) return invalid("blank field local name");
    if (isBlank(field.id.owner.name)) return invalid("blank field owner name");
    if (!owners.has(ownerKey(field.id.owner))) {
      return invalid(
        `missing owner ${field.id.owner.kind} '${field.id.owner.name}' for field '${field.id.localName}'`,
      );
    }
    const added = intern(
      fields,
      fieldKey(field.id.owner, field.id.localName),
      field.id,
      `field identity '${field.id.owner.kind}:${field.id.owner.name}.${field.id.localName}'`,
    );
    if (Result.isFailure(added)) return Result.fail(added.failure);
    pushIndex(fieldsByOwnerName, ownerNameLocalKey(field.id.owner.name, field.id.localName), field.id);
    if (field.valueType === "ref") {
      const refs = validateRefTarget(field.refTarget, target, entities, traits, "field ref target");
      if (Result.isFailure(refs)) return Result.fail(refs.failure);
    }
  }

  for (const operation of descriptor.operations) {
    const scoped = catalogOfIdentity(operation.id, target, "operation");
    if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
    if (isBlank(operation.id.localName)) return invalid("blank operation local name");
    if (isBlank(operation.id.owner.name)) return invalid("blank operation owner name");
    if (!owners.has(ownerKey(operation.id.owner))) {
      return invalid(
        `missing owner ${operation.id.owner.kind} '${operation.id.owner.name}' for operation '${operation.id.localName}'`,
      );
    }
    const added = intern(
      operations,
      operationKey(operation.id.owner, operation.id.localName, operation.id.target),
      operation.id,
      `operation identity '${operation.id.owner.kind}:${operation.id.owner.name}.${operation.id.localName}:${operation.id.target}'`,
    );
    if (Result.isFailure(added)) return Result.fail(added.failure);
    pushIndex(
      operationsByOwnerLocal,
      ownerLocalKey(operation.id.owner, operation.id.localName),
      operation.id,
    );
    const refs = validateInputShape(operation.input, target, entities, traits);
    if (Result.isFailure(refs)) return Result.fail(refs.failure);
  }

  for (const entity of descriptor.entities) {
    for (const trait of entity.traits) {
      const scoped = catalogOfIdentity(trait, target, "entity trait");
      if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
      if (!traits.has(trait.name)) {
        return invalid(`missing trait '${trait.name}' composed by entity '${entity.id.name}'`);
      }
    }
  }
  for (const trait of descriptor.traits) {
    for (const composed of trait.traits) {
      const scoped = catalogOfIdentity(composed, target, "trait composition");
      if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
      if (!traits.has(composed.name)) {
        return invalid(`missing trait '${composed.name}' composed by trait '${trait.id.name}'`);
      }
    }
  }
  for (const row of descriptor.traitComposition) {
    const composerOk = catalogOfIdentity(row.composer, target, "trait-composition composer");
    if (Result.isFailure(composerOk)) return Result.fail(composerOk.failure);
    const traitOk = catalogOfIdentity(row.trait, target, "trait-composition trait");
    if (Result.isFailure(traitOk)) return Result.fail(traitOk.failure);
    if (!entities.has(row.composer.name)) {
      return invalid(`missing composer entity '${row.composer.name}'`);
    }
    if (!traits.has(row.trait.name)) {
      return invalid(`missing composed trait '${row.trait.name}'`);
    }
    for (const transitive of row.transitive) {
      const scoped = catalogOfIdentity(transitive, target, "trait-composition transitive");
      if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
      if (!traits.has(transitive.name)) {
        return invalid(`missing transitive trait '${transitive.name}'`);
      }
    }
  }

  return Result.succeed({
    target,
    entities,
    traits,
    fields,
    operations,
    owners,
    fieldsByOwnerName,
    operationsByOwnerLocal,
  });
};

const validateRefTarget = (
  refTarget: FieldRefTarget | undefined,
  target: CatalogBindingTarget,
  entities: ReadonlyMap<string, EntityId>,
  traits: ReadonlyMap<string, TraitId>,
  label: string,
): Result.Result<void, BindFailure> => {
  if (refTarget === undefined || refTarget._tag === "self" || refTarget._tag === "untargeted") {
    return Result.succeed(undefined);
  }
  if (refTarget._tag === "entity") {
    const scoped = catalogOfIdentity(refTarget.entity, target, label);
    if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
    if (!entities.has(refTarget.entity.name)) {
      return invalid(`missing ${label} entity '${refTarget.entity.name}'`);
    }
    return Result.succeed(undefined);
  }
  const scoped = catalogOfIdentity(refTarget.trait, target, label);
  if (Result.isFailure(scoped)) return Result.fail(scoped.failure);
  if (!traits.has(refTarget.trait.name)) {
    return invalid(`missing ${label} trait '${refTarget.trait.name}'`);
  }
  return Result.succeed(undefined);
};

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
    case "struct": {
      for (const field of shape.fields) {
        const nested = validateInputShape(field.shape, target, entities, traits);
        if (Result.isFailure(nested)) return Result.fail(nested.failure);
      }
      return Result.succeed(undefined);
    }
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
  const exact = index.operations.get(operationKey(relative.owner, relative.localName, relative.target));
  if (exact !== undefined) return Result.succeed(exact);

  const sameOwnerLocal = index.operationsByOwnerLocal.get(ownerLocalKey(relative.owner, relative.localName));
  if (sameOwnerLocal !== undefined) {
    return invalid(
      `wrong target semantics for operation '${relative.owner.kind}:${relative.owner.name}.${relative.localName}': expected '${relative.target}'`,
    );
  }

  const swapped: OwnerRef = { kind: otherOwnerKind(relative.owner.kind), name: relative.owner.name };
  const swappedExact = index.operations.get(
    operationKey(swapped, relative.localName, relative.target),
  );
  const swappedLocal = index.operationsByOwnerLocal.get(ownerLocalKey(swapped, relative.localName));
  if (swappedExact !== undefined || swappedLocal !== undefined) {
    return invalid(
      `wrong owner kind for operation '${relative.owner.name}.${relative.localName}': expected ${relative.owner.kind}`,
    );
  }

  if (!index.owners.has(ownerKey(relative.owner))) {
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
    `wrong local name for operation '${relative.owner.kind}:${relative.owner.name}.${relative.localName}'`,
  );
};

const bindFocus = (
  index: CatalogIndex,
  focus: RelativeRuleFocus,
): Result.Result<CanonicalRuleFocus, BindFailure> => {
  switch (focus._tag) {
    case "entity": {
      const entity = bindEntity(index, focus.entity);
      if (Result.isFailure(entity)) return Result.fail(entity.failure);
      return Result.succeed({ _tag: "entity", entity: entity.success });
    }
    case "trait": {
      const trait = bindTrait(index, focus.trait);
      if (Result.isFailure(trait)) return Result.fail(trait.failure);
      return Result.succeed({ _tag: "trait", trait: trait.success });
    }
    case "field": {
      const field = bindField(index, focus.field);
      if (Result.isFailure(field)) return Result.fail(field.failure);
      return Result.succeed({ _tag: "field", field: field.success });
    }
    case "operation": {
      const operation = bindOperation(index, focus.operation);
      if (Result.isFailure(operation)) return Result.fail(operation.failure);
      return Result.succeed({ _tag: "operation", operation: operation.success });
    }
  }
};

const bindRefTerm = (
  index: CatalogIndex,
  term: RelativeRefTerm,
): Result.Result<CanonicalRefTerm, BindFailure> => {
  const steps: CanonicalRefTerm["steps"][number][] = [];
  for (const step of term.steps) {
    const field = bindField(index, step.field);
    if (Result.isFailure(field)) return Result.fail(field.failure);
    steps.push({ field: field.success });
  }
  return Result.succeed({ _tag: "ref", root: term.root, steps });
};

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
    case "input":
    case "bind":
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
    case "or": {
      const exprs = firstError(expr.exprs.map((child) => bindExpr(index, child)));
      if (Result.isFailure(exprs)) return Result.fail(exprs.failure);
      return Result.succeed({ _tag: expr._tag, exprs: exprs.success });
    }
    case "not": {
      const child = bindExpr(index, expr.expr);
      if (Result.isFailure(child)) return Result.fail(child.failure);
      return Result.succeed({ _tag: "not", expr: child.success });
    }
    case "eq": {
      const left = bindValueTerm(index, expr.left);
      if (Result.isFailure(left)) return Result.fail(left.failure);
      const right = bindValueTerm(index, expr.right);
      if (Result.isFailure(right)) return Result.fail(right.failure);
      return Result.succeed({ _tag: "eq", left: left.success, right: right.success });
    }
    case "has": {
      const term = bindValueTerm(index, expr.term);
      if (Result.isFailure(term)) return Result.fail(term.failure);
      return Result.succeed({ _tag: "has", term: term.success });
    }
    case "in": {
      const value = bindValueTerm(index, expr.value);
      if (Result.isFailure(value)) return Result.fail(value.failure);
      const collection = bindValueTerm(index, expr.collection);
      if (Result.isFailure(collection)) return Result.fail(collection.failure);
      return Result.succeed({
        _tag: "in",
        value: value.success,
        collection: collection.success,
      });
    }
    case "some": {
      const collection = bindRefTerm(index, expr.collection);
      if (Result.isFailure(collection)) return Result.fail(collection.failure);
      const pred = bindExpr(index, expr.pred);
      if (Result.isFailure(pred)) return Result.fail(pred.failure);
      return Result.succeed({
        _tag: "some",
        collection: collection.success,
        bind: expr.bind,
        pred: pred.success,
      });
    }
    case "overlaps": {
      const left = bindRefTerm(index, expr.left);
      if (Result.isFailure(left)) return Result.fail(left.failure);
      const right = bindRefTerm(index, expr.right);
      if (Result.isFailure(right)) return Result.fail(right.failure);
      return Result.succeed({ _tag: "overlaps", left: left.success, right: right.success });
    }
    case "exists": {
      const entity = bindEntity(index, expr.entity);
      if (Result.isFailure(entity)) return Result.fail(entity.failure);
      const pred = bindExpr(index, expr.pred);
      if (Result.isFailure(pred)) return Result.fail(pred.failure);
      return Result.succeed({
        _tag: "exists",
        entity: entity.success,
        bind: expr.bind,
        pred: pred.success,
      });
    }
  }
};

const bindRule = (
  index: CatalogIndex,
  rule: RelativeAuthorizationRule,
): Result.Result<CanonicalAuthorizationRule, BindFailure> => {
  const focus = bindFocus(index, rule.focus);
  if (Result.isFailure(focus)) return Result.fail(focus.failure);
  const expr = bindExpr(index, rule.expr);
  if (Result.isFailure(expr)) return Result.fail(expr.failure);
  const bound: CanonicalAuthorizationRule = {
    id: rule.id,
    focus: focus.success,
    expr: expr.success,
    usesResource: rule.usesResource,
    usesInput: rule.usesInput,
    usesMe: rule.usesMe,
    usesSubject: rule.usesSubject,
    traversalDepth: rule.traversalDepth,
    existsDepth: rule.existsDepth,
    dependencies: rule.dependencies,
  };
  return Result.succeed({ ...bound, id: hashCanonicalRuleSync(bound) });
};

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
> => {
  const bound: { readonly target: Canonical; readonly decision: Decision }[] = [];
  const seen = new Set<unknown>();
  for (const entry of entries) {
    const target = bindTarget(entry.target);
    if (Result.isFailure(target)) return Result.fail(target.failure);
    if (seen.has(target.success)) {
      return invalid("ambiguous bound decision target");
    }
    seen.add(target.success);
    bound.push({ target: target.success, decision: entry.decision });
  }
  return Result.succeed(bound);
};

const bindDecisions = (
  index: CatalogIndex,
  decisions: RelativeAuthorizationDecisions,
): Result.Result<CanonicalAuthorizationDecisions, BindFailure> => {
  const entities = bindDecisionEntries(decisions.entities, (target) => bindEntity(index, target));
  if (Result.isFailure(entities)) return Result.fail(entities.failure);
  const traits = bindDecisionEntries(decisions.traits, (target) => bindTrait(index, target));
  if (Result.isFailure(traits)) return Result.fail(traits.failure);
  const fields = bindDecisionEntries(decisions.fields, (target) => bindField(index, target));
  if (Result.isFailure(fields)) return Result.fail(fields.failure);
  const operations = bindDecisionEntries(decisions.operations, (target) =>
    bindOperation(index, target),
  );
  if (Result.isFailure(operations)) return Result.fail(operations.failure);
  return Result.succeed({
    entities: entities.success,
    traits: traits.success,
    fields: fields.success,
    operations: operations.success,
  });
};

const bindPrincipal = (
  index: CatalogIndex,
  principal: PrincipalResolutionConfig,
): Result.Result<InstalledPrincipalResolution, BindFailure> => {
  if (principal.entity === undefined) {
    return Result.succeed({ subjectClaim: principal.subjectClaim });
  }
  const entity = bindField(index, principal.entity);
  if (Result.isFailure(entity)) return Result.fail(entity.failure);
  return Result.succeed({ subjectClaim: principal.subjectClaim, entity: entity.success });
};

/**
 * Deep-copy JSON-shaped data so later freeze cannot seal caller-owned
 * template, descriptor, or identity objects the result still names.
 */
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

/**
 * Pure catalog-binding kernel. Resolves every relative identity in the
 * template against `input.descriptor`, then re-keys each rule ID from the
 * catalog-qualified body and remaps decision references. Does not
 * recompute derived flags or assemble
 * {@link import("./ir.ts").InstalledAuthorizationIR}.
 */
export const bindPolicyTemplateResult = (
  input: CatalogBindingInput,
): Result.Result<BoundAuthorizationIRType, BindFailure> => {
  const index = indexCatalog(input.target, input.descriptor);
  if (Result.isFailure(index)) return Result.fail(index.failure);

  const principal = bindPrincipal(index.success, input.template.principal);
  if (Result.isFailure(principal)) return Result.fail(principal.failure);

  const rules = firstError(input.template.rules.map((rule) => bindRule(index.success, rule)));
  if (Result.isFailure(rules)) return Result.fail(rules.failure);

  const idMap = new Map<RuleId, RuleId>();
  for (let i = 0; i < input.template.rules.length; i++) {
    idMap.set(input.template.rules[i]!.id, rules.success[i]!.id);
  }

  const decisions = bindDecisions(index.success, input.template.decisions);
  if (Result.isFailure(decisions)) return Result.fail(decisions.failure);

  const bound: BoundAuthorizationIRType = {
    _tag: "BoundAuthorizationIR",
    version: BOUND_AUTHORIZATION_IR_VERSION,
    database: input.target.database,
    catalog: input.target.catalog,
    catalogVersion: input.target.catalogVersion,
    schemaFingerprint: input.target.schemaFingerprint,
    classes: input.template.classes,
    claims: input.template.claims,
    principal: principal.success,
    rules: rules.success,
    decisions: {
      entities: remapDecisionEntries(decisions.success.entities, idMap),
      traits: remapDecisionEntries(decisions.success.traits, idMap),
      fields: remapDecisionEntries(decisions.success.fields, idMap),
      operations: remapDecisionEntries(decisions.success.operations, idMap),
    },
  };
  return Result.succeed(freezeBound(bound));
};

export const bindPolicyTemplate = Effect.fn("Authorization.bindPolicyTemplate")(function* (
  input: CatalogBindingInput,
): Effect.fn.Return<BoundAuthorizationIRType, BindFailure> {
  return yield* Effect.fromResult(bindPolicyTemplateResult(input));
});

export interface AuthoritativeCatalogService {
  /**
   * Resolve the catalog for this exact install target. Implementations
   * must key by database + catalog + version + fingerprint. A catalog
   * name alone is not authority.
   */
  readonly resolve: (
    target: CatalogBindingTarget,
  ) => Effect.Effect<CatalogDescriptor, BindFailure>;
}

/**
 * Authoritative catalog capability. Fetched once per bind, never per
 * expression node. Not a global registry.
 */
export class AuthoritativeCatalog extends Context.Service<
  AuthoritativeCatalog,
  AuthoritativeCatalogService
>()("ramose/authorization/AuthoritativeCatalog") {}

export const bindAgainstAuthoritativeCatalog = Effect.fn(
  "Authorization.bindAgainstAuthoritativeCatalog",
)(function* (target: CatalogBindingTarget, template: CatalogBindingInput["template"]) {
  const catalogs = yield* AuthoritativeCatalog;
  const descriptor = yield* catalogs.resolve(target);
  return yield* Effect.fromResult(bindPolicyTemplateResult({ target, descriptor, template }));
});
