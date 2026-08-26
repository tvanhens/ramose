/**
 * Fail-closed parse / serialize for {@link AuthorizationIR}.
 * Invalid, incomplete, or mismatched documents throw — callers deny (**FC-1**).
 */

import { PolicyError } from "../../db/SchemaErrors.ts";
import { canonicalJson, canonicalize } from "./canonical.ts";
import {
  AUTHORIZATION_IR_VERSION,
  type AuthorizationIR,
  type FieldId,
  type IrDecision,
  type IrExpr,
  type IrOperand,
  type IrPath,
  type IrRule,
  type OperationId,
  type OwnerId,
  type PathStep,
} from "./ir.ts";

const fail = (message: string): never => {
  throw new PolicyError({ message: `ramose/authorization: ${message}` });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const expectRecord = (value: unknown, where: string): Record<string, unknown> => {
  if (!isRecord(value)) return fail(`${where}: expected an object`);
  return value;
};

const expectString = (value: unknown, where: string): string => {
  if (typeof value !== "string" || value.length === 0) return fail(`${where}: expected a non-empty string`);
  return value;
};

const expectBoolean = (value: unknown, where: string): boolean => {
  if (typeof value !== "boolean") return fail(`${where}: expected a boolean`);
  return value;
};

const expectArray = (value: unknown, where: string): readonly unknown[] => {
  if (!Array.isArray(value)) return fail(`${where}: expected an array`);
  return value;
};

const expectKeys = (value: Record<string, unknown>, allowed: readonly string[], where: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where}: unknown key ${JSON.stringify(key)}`);
  }
};

const parseOwner = (value: unknown, where: string): OwnerId => {
  const o = expectRecord(value, where);
  expectKeys(o, ["kind", "ns"], where);
  const kind = expectString(o.kind, `${where}.kind`);
  if (kind !== "entity" && kind !== "trait") return fail(`${where}.kind: expected entity or trait`);
  return { kind, ns: expectString(o.ns, `${where}.ns`) };
};

const parseStep = (value: unknown, where: string): PathStep => {
  const o = expectRecord(value, where);
  expectKeys(o, ["ident", "key", "cardinality", "valueType"], where);
  const cardinality = expectString(o.cardinality, `${where}.cardinality`);
  if (cardinality !== "one" && cardinality !== "many") {
    return fail(`${where}.cardinality: expected one or many`);
  }
  const ident = o.ident === undefined ? undefined : expectString(o.ident, `${where}.ident`);
  const key = o.key === undefined ? undefined : expectString(o.key, `${where}.key`);
  if ((ident === undefined) === (key === undefined)) {
    return fail(`${where}: exactly one of ident or key is required`);
  }
  return {
    ...(ident !== undefined ? { ident } : {}),
    ...(key !== undefined ? { key } : {}),
    cardinality,
    valueType: expectString(o.valueType, `${where}.valueType`),
  };
};

const parsePath = (value: unknown, where: string): IrPath => {
  const o = expectRecord(value, where);
  expectKeys(o, ["root", "steps"], where);
  return {
    root: expectString(o.root, `${where}.root`),
    steps: expectArray(o.steps, `${where}.steps`).map((step, i) => parseStep(step, `${where}.steps[${i}]`)),
  };
};

const parseOperand = (value: unknown, where: string): IrOperand => {
  const o = expectRecord(value, where);
  const kind = expectString(o.kind, `${where}.kind`);
  if (kind === "me") {
    expectKeys(o, ["kind"], where);
    return { kind: "me" };
  }
  if (kind === "lit") {
    expectKeys(o, ["kind", "value"], where);
    if (!("value" in o)) fail(`${where}.value: missing`);
    return { kind: "lit", value: o.value };
  }
  if (kind === "path") {
    expectKeys(o, ["kind", "path"], where);
    return { kind: "path", path: parsePath(o.path, `${where}.path`) };
  }
  return fail(`${where}.kind: unsupported ${JSON.stringify(kind)}`);
};

const parseExpr = (value: unknown, where: string): IrExpr => {
  const o = expectRecord(value, where);
  const kind = expectString(o.kind, `${where}.kind`);
  switch (kind) {
    case "const":
      expectKeys(o, ["kind", "value"], where);
      return { kind: "const", value: expectBoolean(o.value, `${where}.value`) };
    case "hasClass":
      expectKeys(o, ["kind", "class"], where);
      return { kind: "hasClass", class: expectString(o.class, `${where}.class`) };
    case "eq":
      expectKeys(o, ["kind", "left", "right"], where);
      return {
        kind: "eq",
        left: parseOperand(o.left, `${where}.left`),
        right: parseOperand(o.right, `${where}.right`),
      };
    case "has":
      expectKeys(o, ["kind", "path", "value"], where);
      return {
        kind: "has",
        path: parsePath(o.path, `${where}.path`),
        ...(o.value === undefined ? {} : { value: parseOperand(o.value, `${where}.value`) }),
      };
    case "some":
      expectKeys(o, ["kind", "path", "bind", "body"], where);
      return {
        kind: "some",
        path: parsePath(o.path, `${where}.path`),
        bind: expectString(o.bind, `${where}.bind`),
        body: parseExpr(o.body, `${where}.body`),
      };
    case "overlaps":
      expectKeys(o, ["kind", "left", "right"], where);
      return {
        kind: "overlaps",
        left: parsePath(o.left, `${where}.left`),
        right: parsePath(o.right, `${where}.right`),
      };
    case "exists":
      expectKeys(o, ["kind", "entity", "bind", "body"], where);
      return {
        kind: "exists",
        entity: expectString(o.entity, `${where}.entity`),
        bind: expectString(o.bind, `${where}.bind`),
        body: parseExpr(o.body, `${where}.body`),
      };
    case "and":
    case "or": {
      expectKeys(o, ["kind", "exprs"], where);
      const exprs = expectArray(o.exprs, `${where}.exprs`);
      if (exprs.length === 0) fail(`${where}.exprs: must not be empty`);
      return {
        kind,
        exprs: exprs.map((expr, i) => parseExpr(expr, `${where}.exprs[${i}]`)),
      };
    }
    case "not":
      expectKeys(o, ["kind", "expr"], where);
      return { kind: "not", expr: parseExpr(o.expr, `${where}.expr`) };
    default:
      return fail(`${where}.kind: unsupported ${JSON.stringify(kind)}`);
  }
};

const parseRule = (value: unknown, where: string): IrRule => {
  const o = expectRecord(value, where);
  expectKeys(o, ["id", "focus", "expr", "usesResource", "usesInput"], where);
  return {
    id: expectString(o.id, `${where}.id`),
    focus: parseOwner(o.focus, `${where}.focus`),
    expr: parseExpr(o.expr, `${where}.expr`),
    usesResource: expectBoolean(o.usesResource, `${where}.usesResource`),
    usesInput: expectBoolean(o.usesInput, `${where}.usesInput`),
  };
};

const parseDecision = (value: unknown, where: string): IrDecision => {
  const o = expectRecord(value, where);
  expectKeys(o, ["allow", "deny"], where);
  return {
    allow: expectArray(o.allow, `${where}.allow`).map((id, i) => expectString(id, `${where}.allow[${i}]`)),
    deny: expectArray(o.deny, `${where}.deny`).map((id, i) => expectString(id, `${where}.deny[${i}]`)),
  };
};

const parseDecisionMap = (
  value: unknown,
  where: string,
): { readonly [key: string]: IrDecision } => {
  const o = expectRecord(value, where);
  const out: Record<string, IrDecision> = {};
  for (const [key, decision] of Object.entries(o)) {
    out[key] = parseDecision(decision, `${where}[${JSON.stringify(key)}]`);
  }
  return out;
};

const parseFieldId = (value: unknown, where: string): FieldId => {
  const o = expectRecord(value, where);
  expectKeys(o, ["kind", "ident", "owner", "name", "cardinality", "valueType"], where);
  if (o.kind !== "field") fail(`${where}.kind: expected field`);
  const cardinality = expectString(o.cardinality, `${where}.cardinality`);
  if (cardinality !== "one" && cardinality !== "many") {
    return fail(`${where}.cardinality: expected one or many`);
  }
  return {
    kind: "field",
    ident: expectString(o.ident, `${where}.ident`),
    owner: parseOwner(o.owner, `${where}.owner`),
    name: expectString(o.name, `${where}.name`),
    cardinality,
    valueType: expectString(o.valueType, `${where}.valueType`),
  };
};

const parseOperationId = (value: unknown, where: string): OperationId => {
  const o = expectRecord(value, where);
  expectKeys(o, ["kind", "name", "owner", "targetless"], where);
  if (o.kind !== "operation") fail(`${where}.kind: expected operation`);
  return {
    kind: "operation",
    name: expectString(o.name, `${where}.name`),
    ...(o.owner === undefined ? {} : { owner: parseOwner(o.owner, `${where}.owner`) }),
    targetless: expectBoolean(o.targetless, `${where}.targetless`),
  };
};

const checkComplete = (ir: AuthorizationIR): void => {
  const ruleIds = new Set(ir.rules.map((rule) => rule.id));
  if (ruleIds.size !== ir.rules.length) fail("duplicate rule id");
  const mentioned = [
    ...Object.values(ir.rows),
    ...Object.values(ir.traits),
    ...Object.values(ir.fields),
    ...Object.values(ir.operations),
  ];
  for (const decision of mentioned) {
    for (const id of [...decision.allow, ...decision.deny]) {
      if (!ruleIds.has(id)) fail(`decision names unknown rule ${JSON.stringify(id)}`);
    }
  }
};

const parseDocument = (value: unknown): AuthorizationIR => {
  const o = expectRecord(value, "ir");
  expectKeys(o, [
    "version",
    "principal",
    "classes",
    "claims",
    "identities",
    "rules",
    "rows",
    "traits",
    "fields",
    "operations",
  ], "ir");
  if (o.version !== AUTHORIZATION_IR_VERSION) {
    fail(`unsupported version ${JSON.stringify(o.version)}`);
  }
  const principal = expectRecord(o.principal, "ir.principal");
  expectKeys(principal, ["ident", "entity"], "ir.principal");
  const identities = expectRecord(o.identities, "ir.identities");
  expectKeys(identities, ["entities", "traits", "fields", "operations"], "ir.identities");
  const ir: AuthorizationIR = {
    version: AUTHORIZATION_IR_VERSION,
    principal: {
      ident: expectString(principal.ident, "ir.principal.ident"),
      entity: expectString(principal.entity, "ir.principal.entity"),
    },
    classes: expectArray(o.classes, "ir.classes").map((c, i) => expectString(c, `ir.classes[${i}]`)),
    claims: expectArray(o.claims, "ir.claims").map((c, i) => expectString(c, `ir.claims[${i}]`)),
    identities: {
      entities: expectArray(identities.entities, "ir.identities.entities").map((e, i) =>
        parseOwner(e, `ir.identities.entities[${i}]`),
      ),
      traits: expectArray(identities.traits, "ir.identities.traits").map((e, i) =>
        parseOwner(e, `ir.identities.traits[${i}]`),
      ),
      fields: expectArray(identities.fields, "ir.identities.fields").map((e, i) =>
        parseFieldId(e, `ir.identities.fields[${i}]`),
      ),
      operations: expectArray(identities.operations, "ir.identities.operations").map((e, i) =>
        parseOperationId(e, `ir.identities.operations[${i}]`),
      ),
    },
    rules: expectArray(o.rules, "ir.rules").map((rule, i) => parseRule(rule, `ir.rules[${i}]`)),
    rows: parseDecisionMap(o.rows, "ir.rows"),
    traits: parseDecisionMap(o.traits, "ir.traits"),
    fields: parseDecisionMap(o.fields, "ir.fields"),
    operations: parseDecisionMap(o.operations, "ir.operations"),
  };
  if (new Set(ir.classes).size !== ir.classes.length) fail("duplicate class");
  checkComplete(ir);
  return ir;
};

/** Parse a JSON string or decoded value. Throws {@link PolicyError} on any defect. */
export const parseAuthorizationIR = (input: string | unknown): AuthorizationIR => {
  if (input === undefined || input === null) fail("missing compiled authorization IR");
  let value: unknown = input;
  if (typeof input === "string") {
    if (input.length === 0) fail("missing compiled authorization IR");
    try {
      value = JSON.parse(input);
    } catch (cause) {
      throw new PolicyError({
        message: "ramose/authorization: compiled IR is not valid JSON",
        cause,
      });
    }
  }
  return parseDocument(value);
};

/** Deterministic JSON. Same IR always yields the same string. */
export const serializeAuthorizationIR = (ir: AuthorizationIR): string => {
  const parsed = parseDocument(canonicalize(ir));
  return canonicalJson(parsed);
};
