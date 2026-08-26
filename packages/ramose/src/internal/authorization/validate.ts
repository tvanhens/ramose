/** Shared semantic validator for compiler output, templates, and installed IR. */

import {
  MAX_EXISTS_NESTING,
  MAX_EXPR_DEPTH,
  MAX_EXPR_NODES,
  MAX_TRAVERSAL_DEPTH,
} from "./bounds.ts";
import { canonicalJson, canonicalRuleBody } from "./canonical.ts";
import {
  entityComposesTrait,
  entityOf,
  fieldOf,
  operationOf,
  ownerOf,
  traitIsReachable,
  traitOf,
  type CatalogDescriptor,
  type CatalogFieldDescriptor,
} from "./descriptor.ts";
import {
  CatalogMismatch,
  InvalidInstalledIR,
  InvalidTemplate,
  RuleIdentityCollision,
} from "./errors.ts";
import {
  analyzeExpr,
  collectExprDependencies,
  type AuthPath,
  type Expr,
  type Operand,
  type RuleFocus,
} from "./expr.ts";
import {
  relativeFieldKey,
  relativeOperationKey,
  type RelativeFieldRef,
  type RelativeOperationRef,
  type RuleId,
} from "./identity.ts";
import type {
  InstalledAuthorizationIR,
  InstalledDecision,
  InstalledRule,
} from "./installed.ts";
import type {
  ExistsNeed,
  FactNeed,
  IndexNeed,
  RuleAccessPlan,
} from "./plan.ts";
import type {
  PolicyTemplateIR,
  TemplateDecision,
  TemplateRule,
} from "./template.ts";

export type DigestFn = (canonical: string) => string;

const failTemplate = (message: string, path?: string): never => {
  throw new InvalidTemplate({ message, path });
};

const failInstalled = (message: string, path?: string): never => {
  throw new InvalidInstalledIR({ message, path });
};

const failMismatch = (message: string, catalog?: CatalogDescriptor): never => {
  throw new CatalogMismatch({
    message,
    catalogId: catalog?.catalogId,
    catalogVersion: catalog?.catalogVersion,
  });
};

const assertIdent = (name: string, path: string): void => {
  if (name.length === 0) failTemplate(`empty identity at ${path}`, path);
};

const exprDepth = (expr: Expr): number => {
  switch (expr._tag) {
    case "and":
    case "or":
      return 1 + Math.max(0, ...expr.exprs.map(exprDepth));
    case "not":
    case "some":
    case "exists":
      return 1 + exprDepth(expr._tag === "not" ? expr.expr : expr.pred);
    default:
      return 1;
  }
};

const walkOperands = (expr: Expr, visit: (operand: Operand) => void): void => {
  switch (expr._tag) {
    case "and":
    case "or":
      for (const child of expr.exprs) walkOperands(child, visit);
      break;
    case "not":
      walkOperands(expr.expr, visit);
      break;
    case "eq":
      visit(expr.left);
      visit(expr.right);
      break;
    case "has":
      visit(expr.operand);
      break;
    case "some":
    case "exists":
      walkOperands(expr.pred, visit);
      break;
    default:
      break;
  }
};

const walkPaths = (expr: Expr, visit: (path: AuthPath) => void): void => {
  switch (expr._tag) {
    case "and":
    case "or":
      for (const child of expr.exprs) walkPaths(child, visit);
      break;
    case "not":
      walkPaths(expr.expr, visit);
      break;
    case "eq":
    case "has": {
      const operand = expr._tag === "eq" ? undefined : expr.operand;
      if (expr._tag === "has" && operand?._tag === "path") visit(operand.path);
      if (expr._tag === "eq") {
        if (expr.left._tag === "path") visit(expr.left.path);
        if (expr.right._tag === "path") visit(expr.right.path);
      }
      break;
    }
    case "some":
      visit(expr.path);
      walkPaths(expr.pred, visit);
      break;
    case "overlaps":
      visit(expr.left);
      visit(expr.right);
      break;
    case "exists":
      walkPaths(expr.pred, visit);
      break;
    default:
      break;
  }
};

const resolvePathFields = (
  catalog: CatalogDescriptor,
  path: AuthPath,
  focus: RuleFocus,
): readonly CatalogFieldDescriptor[] => {
  let ownerName: string | undefined;
  let ownerKind: "entity" | "trait" | undefined;
  if (path.root._tag === "resource") {
    if (focus._tag === "entity") {
      ownerName = focus.name;
      ownerKind = "entity";
    } else if (focus._tag === "trait") {
      ownerName = focus.name;
      ownerKind = "trait";
    } else if (focus.target === "required") {
      ownerName = focus.owner.name;
      ownerKind = focus.owner.kind;
    } else {
      failTemplate("targetless operation rule cannot traverse a resource");
    }
  }

  const resolved: CatalogFieldDescriptor[] = [];
  for (const step of path.steps) {
    const field = fieldOf(catalog, step.field);
    if (field === undefined) {
      return failTemplate(
        `unknown field ${relativeFieldKey(step.field)}`,
        relativeFieldKey(step.field),
      );
    }
    if (ownerName !== undefined && ownerKind !== undefined) {
      const belongs =
        field.owner.kind === ownerKind && field.owner.name === ownerName;
      const composed =
        ownerKind === "entity" &&
        field.owner.kind === "trait" &&
        entityComposesTrait(catalog, ownerName, field.owner.name);
      if (!belongs && !composed && resolved.length === 0) {
        failTemplate(
          `field ${relativeFieldKey(step.field)} is not on ${ownerKind}:${ownerName}`,
        );
      }
    }
    if (resolved.length > 0) {
      const prev = resolved[resolved.length - 1]!;
      if (prev.valueType !== "ref" || prev.refTarget === undefined) {
        return failTemplate(`cannot traverse through non-ref ${prev.ident}`);
      }
      const refTarget = prev.refTarget;
      if (field.owner.name !== refTarget && field.owner.kind === "entity") {
        const target = entityOf(catalog, refTarget);
        const onTarget =
          target !== undefined &&
          (target.fields.some((f) => f.localName === field.localName) ||
            target.traits.includes(field.owner.name));
        if (!onTarget) {
          failTemplate(
            `field ${field.ident} is not reachable from ${prev.ident}`,
          );
        }
      }
    }
    resolved.push(field);
    if (field.valueType === "ref" && field.refTarget !== undefined) {
      ownerName = field.refTarget;
      ownerKind = "entity";
    } else {
      ownerName = undefined;
      ownerKind = undefined;
    }
  }
  return resolved;
};

const assertFocusInCatalog = (
  catalog: CatalogDescriptor,
  focus: RuleFocus,
): void => {
  switch (focus._tag) {
    case "entity":
      if (entityOf(catalog, focus.name) === undefined) {
        failTemplate(`unknown entity ${focus.name}`, focus.name);
      }
      break;
    case "trait":
      if (traitOf(catalog, focus.name) === undefined) {
        failTemplate(`unknown trait ${focus.name}`, focus.name);
      }
      if (!traitIsReachable(catalog, focus.name)) {
        failTemplate(`trait ${focus.name} is not reachable in the catalog`);
      }
      break;
    case "operation": {
      const op = operationOf(catalog, {
        owner: focus.owner,
        localName: focus.localName,
        target: focus.target,
      });
      if (op === undefined) {
        return failTemplate(
          `unknown operation ${relativeOperationKey(focus)}`,
          relativeOperationKey(focus),
        );
      }
      if (focus.owner.kind === "trait" && !traitIsReachable(catalog, focus.owner.name)) {
        failTemplate(
          `targetless or trait operation ${relativeOperationKey(focus)} is not reachable`,
        );
      }
      if (focus.target !== op.target) {
        failTemplate("operation target semantics do not match the catalog");
      }
      break;
    }
  }
};

const assertOperandKeys = (
  expr: Expr,
  claims: ReadonlySet<string>,
  inputKeys: ReadonlySet<string> | undefined,
): void => {
  walkOperands(expr, (operand) => {
    if (operand._tag === "claim" && !claims.has(operand.key)) {
      failTemplate(`undeclared claim ${operand.key}`, operand.key);
    }
    if (operand._tag === "input") {
      if (inputKeys === undefined) {
        failTemplate(`operation input ${operand.key} used outside an operation rule`);
      } else if (!inputKeys.has(operand.key)) {
        failTemplate(`unknown operation input ${operand.key}`, operand.key);
      }
    }
  });
};

const inputKeysForFocus = (
  catalog: CatalogDescriptor,
  focus: RuleFocus,
): ReadonlySet<string> | undefined => {
  if (focus._tag !== "operation") return undefined;
  const op = operationOf(catalog, {
    owner: focus.owner,
    localName: focus.localName,
    target: focus.target,
  });
  return new Set(op?.inputKeys ?? []);
};

const deriveAccessPlan = (
  ruleId: RuleId,
  focus: RuleFocus,
  expr: Expr,
  meta: ReturnType<typeof analyzeExpr>,
): RuleAccessPlan => {
  const facts: FactNeed[] = [];
  const indexes: IndexNeed[] = [];
  const exists: ExistsNeed[] = [];
  const seenFact = new Set<string>();
  const pushFact = (fact: FactNeed, key: string): void => {
    if (seenFact.has(key)) return;
    seenFact.add(key);
    facts.push(fact);
  };

  walkOperands(expr, (operand) => {
    switch (operand._tag) {
      case "me":
        pushFact({ _tag: "principalRow" }, "me");
        break;
      case "subject":
        pushFact({ _tag: "subject" }, "subject");
        break;
      case "claim":
        pushFact({ _tag: "claim", key: operand.key }, `claim:${operand.key}`);
        break;
      case "input":
        pushFact({ _tag: "input", key: operand.key }, `input:${operand.key}`);
        break;
      case "path":
        for (const step of operand.path.steps) {
          pushFact(
            { _tag: "resourceField", field: step.field },
            `field:${relativeFieldKey(step.field)}`,
          );
        }
        break;
      default:
        break;
    }
  });

  const walk = (node: Expr): void => {
    switch (node._tag) {
      case "and":
      case "or":
        for (const child of node.exprs) walk(child);
        break;
      case "not":
        walk(node.expr);
        break;
      case "some":
        walk(node.pred);
        break;
      case "exists":
        exists.push({ entity: node.entity, bind: node.bind });
        indexes.push({ _tag: "entityScan", entity: node.entity, fields: [] });
        walk(node.pred);
        break;
      default:
        break;
    }
  };
  walk(expr);
  void focus;
  return {
    ruleId,
    facts,
    indexes,
    exists,
    maxTraversalDepth: meta.traversalDepth,
    usesMe: meta.usesMe,
    usesResource: meta.usesResource,
    usesInput: meta.usesInput,
  };
};

const internRules = (
  rules: readonly { readonly focus: RuleFocus; readonly expr: Expr }[],
  digest: DigestFn,
): { readonly ids: readonly RuleId[]; readonly byId: Map<RuleId, string> } => {
  const byId = new Map<RuleId, string>();
  const ids: RuleId[] = [];
  for (const rule of rules) {
    const body = canonicalRuleBody(rule);
    const id = digest(body);
    const existing = byId.get(id);
    if (existing !== undefined && existing !== body) {
      throw new RuleIdentityCollision({
        message: "rule identity collision maps to different canonical bodies",
        ruleId: id,
      });
    }
    byId.set(id, body);
    ids.push(id);
  }
  return { ids, byId };
};

const focusCompatible = (
  catalog: CatalogDescriptor,
  focus: RuleFocus,
  kind: "row" | "trait" | "field" | "operation",
  key: string,
): boolean => {
  if (kind === "row") {
    if (focus._tag === "entity") return focus.name === key;
    if (focus._tag === "trait") return entityComposesTrait(catalog, key, focus.name);
    return false;
  }
  if (kind === "trait") {
    return focus._tag === "trait" && focus.name === key;
  }
  if (kind === "field") {
    const [ownerKind, rest] = key.split(":") as [string, string | undefined];
    if (rest === undefined) return false;
    const slash = rest.indexOf("/");
    const ownerName = rest.slice(0, slash);
    if (focus._tag === "entity") {
      return ownerKind === "entity" && focus.name === ownerName;
    }
    if (focus._tag === "trait") {
      if (ownerKind === "trait") return focus.name === ownerName;
      return entityComposesTrait(catalog, ownerName, focus.name);
    }
    return false;
  }
  if (focus._tag === "operation") {
    return relativeOperationKey(focus) === key;
  }
  if (focus._tag === "trait") {
    const op = catalog.operations.find(
      (candidate) => relativeOperationKey(candidate) === key,
    );
    if (op === undefined) return false;
    if (op.owner.kind === "trait") return op.owner.name === focus.name;
    return (
      op.owner.kind === "entity" &&
      entityComposesTrait(catalog, op.owner.name, focus.name)
    );
  }
  if (focus._tag === "entity") {
    const op = catalog.operations.find(
      (candidate) => relativeOperationKey(candidate) === key,
    );
    return op !== undefined && op.owner.kind === "entity" && op.owner.name === focus.name;
  }
  return false;
};

const recomputeRule = (
  catalog: CatalogDescriptor,
  rule: { readonly focus: RuleFocus; readonly expr: Expr },
  digest: DigestFn,
  claims: ReadonlySet<string>,
): TemplateRule => {
  assertFocusInCatalog(catalog, rule.focus);
  if (exprDepth(rule.expr) > MAX_EXPR_DEPTH) {
    failTemplate("expression exceeds maximum depth");
  }
  const meta = analyzeExpr(rule.expr);
  if (meta.traversalDepth > MAX_TRAVERSAL_DEPTH) {
    failTemplate("traversal depth exceeds the static bound");
  }
  if (meta.existsNesting > MAX_EXISTS_NESTING) {
    failTemplate("nested exists exceeds the static bound");
  }
  if (meta.exprNodes > MAX_EXPR_NODES) {
    failTemplate("expression exceeds the node budget");
  }
  if (rule.focus._tag === "operation" && rule.focus.target === "none" && meta.usesResource) {
    failTemplate("targetless operation rules cannot inspect a resource");
  }
  if (rule.focus._tag !== "operation" && meta.usesInput) {
    failTemplate("only operation-focused rules may read operation input");
  }
  assertOperandKeys(rule.expr, claims, inputKeysForFocus(catalog, rule.focus));
  walkPaths(rule.expr, (path) => {
    resolvePathFields(catalog, path, rule.focus);
  });
  const hasClassNames: string[] = [];
  const walkClasses = (node: Expr): void => {
    if (node._tag === "hasClass") hasClassNames.push(node.class);
    else if (node._tag === "and" || node._tag === "or") {
      for (const child of node.exprs) walkClasses(child);
    } else if (node._tag === "not" || node._tag === "some" || node._tag === "exists") {
      walkClasses(node._tag === "not" ? node.expr : node.pred);
    }
  };
  walkClasses(rule.expr);
  void hasClassNames;
  const id = digest(canonicalRuleBody(rule));
  return {
    id,
    focus: rule.focus,
    expr: rule.expr,
    dependencies: collectExprDependencies(rule.expr),
    ...meta,
  };
};

const assertDeclaredClass = (
  classes: readonly string[],
  expr: Expr,
): void => {
  const declared = new Set(classes);
  const walk = (node: Expr): void => {
    if (node._tag === "hasClass" && !declared.has(node.class)) {
      failTemplate(`undeclared class ${node.class}`, node.class);
    }
    if (node._tag === "and" || node._tag === "or") {
      for (const child of node.exprs) walk(child);
    } else if (node._tag === "not") walk(node.expr);
    else if (node._tag === "some" || node._tag === "exists") walk(node.pred);
  };
  walk(expr);
};

const validateDecisionMap = (
  catalog: CatalogDescriptor,
  rulesById: ReadonlyMap<RuleId, TemplateRule>,
  decisions: PolicyTemplateIR["decisions"],
): void => {
  const check = (
    kind: "row" | "trait" | "field" | "operation",
    key: string,
    decision: TemplateDecision,
  ): void => {
    const seen = new Set<RuleId>();
    for (const id of [...decision.allow, ...decision.deny]) {
      const rule = rulesById.get(id);
      if (rule === undefined) return failTemplate(`decision references unknown rule ${id}`);
      if (seen.has(id)) return failTemplate(`duplicate rule ${id} in decision ${key}`);
      seen.add(id);
      if (!focusCompatible(catalog, rule.focus, kind, key)) {
        failTemplate(`rule ${id} focus is incompatible with ${kind} ${key}`);
      }
    }
    if (kind === "row" && entityOf(catalog, key) === undefined) {
      failTemplate(`unknown row decision ${key}`, key);
    }
    if (kind === "trait") {
      if (traitOf(catalog, key) === undefined) failTemplate(`unknown trait decision ${key}`, key);
      if (!traitIsReachable(catalog, key)) {
        failTemplate(`trait decision ${key} is not reachable`);
      }
    }
    if (kind === "field") {
      const field = lookupDecisionField(catalog, key);
      if (field === undefined) failTemplate(`unknown field decision ${key}`, key);
    }
    if (kind === "operation") {
      const op = catalog.operations.find((candidate) => relativeOperationKey(candidate) === key);
      if (op === undefined) return failTemplate(`unknown operation decision ${key}`, key);
      if (op.owner.kind === "trait" && !traitIsReachable(catalog, op.owner.name)) {
        failTemplate(`operation decision ${key} trait is not reachable`);
      }
    }
  };

  for (const [key, decision] of Object.entries(decisions.rows)) {
    check("row", key, decision);
  }
  for (const [key, decision] of Object.entries(decisions.traits)) {
    check("trait", key, decision);
  }
  for (const [key, decision] of Object.entries(decisions.fields)) {
    check("field", key, decision);
  }
  for (const [key, decision] of Object.entries(decisions.operations)) {
    check("operation", key, decision);
  }
};

const lookupDecisionField = (
  catalog: CatalogDescriptor,
  key: string,
): CatalogFieldDescriptor | undefined => {
  const colon = key.indexOf(":");
  const slash = key.indexOf("/");
  if (colon < 0 || slash < 0) return undefined;
  const owner: RelativeFieldRef = {
    owner: {
      kind: key.slice(0, colon) as "entity" | "trait",
      name: key.slice(colon + 1, slash),
    },
    localName: key.slice(slash + 1),
  };
  return fieldOf(catalog, owner);
};

const sameMeta = (
  a: TemplateRule,
  b: {
    readonly id: string;
    readonly usesResource: boolean;
    readonly usesInput: boolean;
    readonly usesMe: boolean;
    readonly usesSubject: boolean;
    readonly traversalDepth: number;
    readonly existsNesting: number;
    readonly exprNodes: number;
    readonly dependencies: readonly string[];
  },
): boolean =>
  a.id === b.id &&
  a.usesResource === b.usesResource &&
  a.usesInput === b.usesInput &&
  a.usesMe === b.usesMe &&
  a.usesSubject === b.usesSubject &&
  a.traversalDepth === b.traversalDepth &&
  a.existsNesting === b.existsNesting &&
  a.exprNodes === b.exprNodes &&
  canonicalJson(a.dependencies) === canonicalJson(b.dependencies);

const validatePrincipal = (
  catalog: CatalogDescriptor,
  principal: PolicyTemplateIR["principal"],
): void => {
  assertIdent(principal.subjectClaim, "principal.subjectClaim");
  if (principal.entity !== undefined) {
    const field = fieldOf(catalog, principal.entity);
    if (field === undefined) {
      return failTemplate("principal entity field is not in the catalog");
    }
    if (field.unique === undefined) {
      return failTemplate("principal entity field must be unique");
    }
    if (field.cardinality !== "one") {
      failTemplate("principal entity field must be cardinality one");
    }
  }
};

export const semanticallyValidateTemplate = (
  template: PolicyTemplateIR,
  catalog: CatalogDescriptor,
  digest: DigestFn,
): PolicyTemplateIR => {
  validatePrincipal(catalog, template.principal);
  const claims = new Set(template.claims);
  if (new Set(template.classes).size !== template.classes.length) {
    failTemplate("duplicate class names");
  }
  if (claims.size !== template.claims.length) failTemplate("duplicate claim keys");

  const intern = internRules(template.rules, digest);
  const recomputed: TemplateRule[] = [];
  const byId = new Map<RuleId, TemplateRule>();
  for (let i = 0; i < template.rules.length; i++) {
    const rule = template.rules[i]!;
    assertDeclaredClass(template.classes, rule.expr);
    const next = recomputeRule(catalog, rule, digest, claims);
    if (next.id !== intern.ids[i]) {
      failTemplate("rule identity does not match the canonical digest");
    }
    if (!sameMeta(next, rule)) {
      failTemplate("rule metadata does not match recomputed values", rule.id);
    }
    const existing = byId.get(next.id);
    if (existing !== undefined) {
      if (canonicalRuleBody(existing) !== canonicalRuleBody(next)) {
        throw new RuleIdentityCollision({
          message: "rule identity collision maps to different canonical bodies",
          ruleId: next.id,
        });
      }
    } else {
      byId.set(next.id, next);
      recomputed.push(next);
    }
  }

  validateDecisionMap(catalog, byId, template.decisions);
  return {
    ...template,
    rules: recomputed,
  };
};

const samePlan = (a: RuleAccessPlan, b: RuleAccessPlan): boolean =>
  canonicalJson(a) === canonicalJson(b);

export const bindTemplate = (
  template: PolicyTemplateIR,
  catalog: CatalogDescriptor,
  digest: DigestFn,
): Omit<InstalledAuthorizationIR, never> => {
  const validated = semanticallyValidateTemplate(template, catalog, digest);
  const rules: InstalledRule[] = validated.rules.map((rule) => ({
    ...rule,
    accessPlan: deriveAccessPlan(rule.id, rule.focus, rule.expr, rule),
  }));
  const decisions = validated.decisions as {
    readonly rows: Readonly<Record<string, InstalledDecision>>;
    readonly traits: Readonly<Record<string, InstalledDecision>>;
    readonly fields: Readonly<Record<string, InstalledDecision>>;
    readonly operations: Readonly<Record<string, InstalledDecision>>;
  };
  const accessPlans = (
    [
      ["row", decisions.rows],
      ["trait", decisions.traits],
      ["field", decisions.fields],
      ["operation", decisions.operations],
    ] as const
  ).flatMap(([kind, map]) =>
    Object.entries(map).map(([key, decision]) => ({
      kind,
      key,
      rules: [...decision.allow, ...decision.deny]
        .map((id) => rules.find((rule) => rule.id === id)?.accessPlan)
        .filter((plan): plan is RuleAccessPlan => plan !== undefined),
    })),
  );

  const policyHash = digest(
    canonicalJson({
      principal: validated.principal,
      classes: validated.classes,
      claims: validated.claims,
      rules: validated.rules.map((rule) => ({
        focus: rule.focus,
        expr: rule.expr,
      })),
      decisions: validated.decisions,
    }),
  );

  return {
    _tag: "InstalledAuthorizationIR",
    version: "ramose.authorization.installed.1",
    catalogId: catalog.catalogId,
    catalogVersion: catalog.catalogVersion,
    catalogFingerprint: catalog.fingerprint,
    policyHash,
    principal: {
      subjectClaim: validated.principal.subjectClaim,
      entity:
        validated.principal.entity === undefined
          ? undefined
          : {
              catalog: catalog.catalogId,
              owner: validated.principal.entity.owner,
              localName: validated.principal.entity.localName,
            },
    },
    classes: validated.classes,
    claims: validated.claims,
    identities: {
      entities: catalog.entities.map((entity) => ({
        catalog: catalog.catalogId,
        name: entity.name,
      })),
      traits: catalog.traits.map((trait) => ({
        catalog: catalog.catalogId,
        name: trait.name,
      })),
      fields: [
        ...catalog.entities.flatMap((entity) =>
          entity.fields.map((field) => ({
            catalog: catalog.catalogId,
            owner: field.owner,
            localName: field.localName,
          })),
        ),
        ...catalog.traits.flatMap((trait) =>
          trait.fields.map((field) => ({
            catalog: catalog.catalogId,
            owner: field.owner,
            localName: field.localName,
          })),
        ),
      ],
      operations: catalog.operations.map((op) => ({
        catalog: catalog.catalogId,
        owner: op.owner,
        localName: op.localName,
        target: op.target,
      })),
    },
    traitComposition: Object.fromEntries(
      catalog.entities.map((entity) => [entity.name, entity.traits]),
    ),
    operationDescriptors: catalog.operations.map((op) => ({
      identity: {
        catalog: catalog.catalogId,
        owner: op.owner,
        localName: op.localName,
        target: op.target,
      },
      inputKeys: op.inputKeys,
    })),
    rules,
    decisions,
    accessPlans,
  };
};

export const semanticallyValidateInstalled = (
  installed: InstalledAuthorizationIR,
  catalog: CatalogDescriptor,
  digest: DigestFn,
): InstalledAuthorizationIR => {
  if (installed.catalogId !== catalog.catalogId) {
    failMismatch("installed catalog identity does not match the descriptor", catalog);
  }
  if (installed.catalogVersion !== catalog.catalogVersion) {
    failMismatch("installed catalog version is stale", catalog);
  }
  if (installed.catalogFingerprint !== catalog.fingerprint) {
    failMismatch("installed catalog fingerprint does not match", catalog);
  }
  for (const entity of installed.identities.entities) {
    if (entity.catalog !== catalog.catalogId) {
      failMismatch("cross-catalog entity identity", catalog);
    }
    if (entityOf(catalog, entity.name) === undefined) {
      failInstalled(`unknown installed entity ${entity.name}`);
    }
  }
  for (const trait of installed.identities.traits) {
    if (trait.catalog !== catalog.catalogId) {
      failMismatch("cross-catalog trait identity", catalog);
    }
    if (traitOf(catalog, trait.name) === undefined) {
      failInstalled(`unknown installed trait ${trait.name}`);
    }
  }
  for (const op of installed.identities.operations) {
    if (op.catalog !== catalog.catalogId) {
      failMismatch("cross-catalog operation identity", catalog);
    }
    if (
      operationOf(catalog, {
        owner: op.owner,
        localName: op.localName,
        target: op.target,
      }) === undefined
    ) {
      failInstalled(`unknown installed operation ${relativeOperationKey(op)}`);
    }
  }

  const template: PolicyTemplateIR = {
    _tag: "PolicyTemplateIR",
    version: "ramose.policy.template.1",
    principal: {
      subjectClaim: installed.principal.subjectClaim,
      entity:
        installed.principal.entity === undefined
          ? undefined
          : {
              owner: installed.principal.entity.owner,
              localName: installed.principal.entity.localName,
            },
    },
    classes: installed.classes,
    claims: installed.claims,
    rules: installed.rules.map((rule) => ({
      id: rule.id,
      focus: rule.focus,
      expr: rule.expr,
      usesResource: rule.usesResource,
      usesInput: rule.usesInput,
      usesMe: rule.usesMe,
      usesSubject: rule.usesSubject,
      traversalDepth: rule.traversalDepth,
      existsNesting: rule.existsNesting,
      exprNodes: rule.exprNodes,
      dependencies: rule.dependencies,
    })),
    decisions: installed.decisions,
  };

  const rebound = bindTemplate(template, catalog, digest);
  if (rebound.policyHash !== installed.policyHash) {
    failInstalled("policy hash does not match the recomputed digest");
  }
  for (const rule of installed.rules) {
    const expected = rebound.rules.find((item) => item.id === rule.id);
    if (expected === undefined || !samePlan(expected.accessPlan, rule.accessPlan)) {
      failInstalled("rule access plan does not match recomputed plan", rule.id);
    }
  }
  if (canonicalJson(rebound.decisions) !== canonicalJson(installed.decisions)) {
    failInstalled("installed decisions do not match recomputed decisions");
  }
  if (canonicalJson(rebound.traitComposition) !== canonicalJson(installed.traitComposition)) {
    failInstalled("trait composition does not match the catalog");
  }
  return rebound;
};

export const fieldDecisionKey = (field: RelativeFieldRef): string =>
  relativeFieldKey(field);

export const operationDecisionKey = (op: RelativeOperationRef): string =>
  relativeOperationKey(op);

export { deriveAccessPlan, internRules, recomputeRule };
