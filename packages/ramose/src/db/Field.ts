/** Typed field: value Schema, cardinality, and options. */

import { parse } from "acorn";
import type * as SchemaNS from "effect/Schema";
import * as Schema from "effect/Schema";
import {
  Bytes,
  Instant,
  Long,
  Ref as refSchema,
  Uuid,
  enumMembersOf,
  enumSchema,
  rememberValueType,
  tryInferDbValueType,
  type DbValueType,
  type InferDbValueType,
  type SelfMarker,
  type TargetedRef,
  untargetedRef,
} from "./valueTypes.ts";

export type Cardinality = "one" | "many";
export type Uniqueness = "upsert" | "strict";

/** The only ambient value available to a creation-time default. */
export interface CreationDefaultContext {
  readonly now: Date;
}

/** Canonical captured data; Date and bytes receive distinct sealed encodings. */
export type CreationDefaultInputs =
  | null
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | readonly CreationDefaultInputs[]
  | { readonly [key: string]: CreationDefaultInputs };

export type ImmutableCreationDefaultInputs<T extends CreationDefaultInputs> =
  T extends Date
    ? Date
    : T extends Uint8Array
      ? Uint8Array
      : T extends null | string | number | boolean
    ? T
    : T extends readonly (infer Item extends CreationDefaultInputs)[]
      ? readonly ImmutableCreationDefaultInputs<Item>[]
      : T extends Readonly<Record<string, CreationDefaultInputs>>
        ? { readonly [K in keyof T]: ImmutableCreationDefaultInputs<T[K]> }
        : never;

type CreationDefaultIdentity = {
  readonly inputs: CreationDefaultInputs;
  readonly source: string;
  readonly evaluate: (context: CreationDefaultContext) => unknown;
};

const creationDefaultIdentities = new WeakMap<
  CreationDefault<unknown>,
  CreationDefaultIdentity
>();

/** Synchronous creation-time value computation. `undefined` means missing. */
export type CreationDefault<A> = ((
  context: CreationDefaultContext,
) => A | undefined);

const snapshotInputs = (
  value: CreationDefaultInputs,
  seen = new WeakSet<object>(),
): CreationDefaultInputs => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("ramose/default: inputs must contain only finite numbers");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new Error("ramose/default: inputs must contain only valid dates");
    }
    return new Date(value.getTime());
  }
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (seen.has(value)) {
    throw new Error("ramose/default: inputs must not contain cycles");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const snapshot = Object.freeze(
      value.map((item) => snapshotInputs(item, seen)),
    );
    seen.delete(value);
    return snapshot;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("ramose/default: inputs must be canonical JSON data");
  }
  const record = value as Readonly<Record<string, CreationDefaultInputs>>;
  const out = Object.create(null) as Record<string, CreationDefaultInputs>;
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) {
      throw new Error("ramose/default: inputs must be canonical JSON data");
    }
    out[key] = snapshotInputs(item, seen);
  }
  seen.delete(value);
  return Object.freeze(out);
};

type EvaluatorNode = {
  readonly type: string;
  readonly [key: string]: unknown;
};

const evaluatorError = (message: string): Error =>
  new Error(`ramose/default: evaluator ${message}`);

const node = (value: unknown, label: string): EvaluatorNode => {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw evaluatorError(`has invalid ${label}`);
  }
  return value as EvaluatorNode;
};

const staticProperty = (member: EvaluatorNode): PropertyKey => {
  const property = node(member.property, "member property");
  if (member.computed === true) {
    if (property.type !== "Literal") {
      throw evaluatorError("requires statically named properties");
    }
    const value = property.value;
    if (typeof value !== "string" && typeof value !== "number") {
      throw evaluatorError("requires string or number property names");
    }
    return value;
  }
  if (property.type !== "Identifier" || typeof property.name !== "string") {
    const value = property.value;
    if (property.type === "Literal" &&
      (typeof value === "string" || typeof value === "number")) {
      return value;
    }
    throw evaluatorError("requires statically named properties");
  }
  return property.name;
};

const primitive = (value: unknown): value is null | undefined | string | number | boolean =>
  value === null || value === undefined ||
  typeof value === "string" || typeof value === "number" ||
  typeof value === "boolean";

const numericOperands = (
  operator: string,
  left: unknown,
  right: unknown,
): readonly [number, number] => {
  if (typeof left !== "number" || typeof right !== "number") {
    throw evaluatorError(`operator '${operator}' requires number operands`);
  }
  return [left, right];
};

const evaluateBinary = (operator: string, left: unknown, right: unknown): unknown => {
  switch (operator) {
    case "===": return left === right;
    case "!==": return left !== right;
    case "+": {
      if (typeof left === "number" && typeof right === "number") return left + right;
      if (typeof left === "string" && typeof right === "string") return left + right;
      throw evaluatorError("operator '+' requires two numbers or two strings");
    }
    case "-": { const [l, r] = numericOperands(operator, left, right); return l - r; }
    case "*": { const [l, r] = numericOperands(operator, left, right); return l * r; }
    case "/": { const [l, r] = numericOperands(operator, left, right); return l / r; }
    case "%": { const [l, r] = numericOperands(operator, left, right); return l % r; }
    case "**": { const [l, r] = numericOperands(operator, left, right); return l ** r; }
    case "<":
    case "<=":
    case ">":
    case ">=": {
      if (
        !((typeof left === "number" && typeof right === "number") ||
          (typeof left === "string" && typeof right === "string"))
      ) {
        throw evaluatorError(`operator '${operator}' requires matching primitives`);
      }
      if (operator === "<") return left < right;
      if (operator === "<=") return left <= right;
      if (operator === ">") return left > right;
      return left >= right;
    }
    case "|": { const [l, r] = numericOperands(operator, left, right); return l | r; }
    case "&": { const [l, r] = numericOperands(operator, left, right); return l & r; }
    case "^": { const [l, r] = numericOperands(operator, left, right); return l ^ r; }
    case "<<": { const [l, r] = numericOperands(operator, left, right); return l << r; }
    case ">>": { const [l, r] = numericOperands(operator, left, right); return l >> r; }
    case ">>>": { const [l, r] = numericOperands(operator, left, right); return l >>> r; }
    default: throw evaluatorError(`does not support operator '${operator}'`);
  }
};

const evaluateNode = (
  current: EvaluatorNode,
  bindings: Readonly<Record<string, unknown>>,
): unknown => {
  switch (current.type) {
    case "Literal": {
      if (current.regex !== undefined || current.bigint !== undefined) {
        throw evaluatorError("supports only canonical primitive literals");
      }
      return current.value;
    }
    case "Identifier": {
      const name = current.name;
      if (name === "undefined") return undefined;
      if (typeof name !== "string" || !Object.hasOwn(bindings, name)) {
        throw evaluatorError(`references undeclared identifier '${String(name)}'`);
      }
      return bindings[name];
    }
    case "MemberExpression": {
      if (current.optional === true) {
        throw evaluatorError("does not support optional member access");
      }
      const target = evaluateNode(node(current.object, "member target"), bindings);
      const property = staticProperty(current);
      if ((typeof target !== "object" && typeof target !== "function") || target === null) {
        throw evaluatorError(`cannot read '${String(property)}' from a primitive`);
      }
      if (!Object.hasOwn(target, property)) {
        throw evaluatorError(`cannot read inherited or missing property '${String(property)}'`);
      }
      return Reflect.get(target, property);
    }
    case "UnaryExpression": {
      const operator = String(current.operator);
      const value = evaluateNode(node(current.argument, "unary argument"), bindings);
      if (operator === "!") return !value;
      if (operator === "typeof") return typeof value;
      if (typeof value !== "number") {
        throw evaluatorError(`operator '${operator}' requires a number operand`);
      }
      if (operator === "+") return value;
      if (operator === "-") return -value;
      if (operator === "~") return ~value;
      throw evaluatorError(`does not support operator '${operator}'`);
    }
    case "BinaryExpression":
      return evaluateBinary(
        String(current.operator),
        evaluateNode(node(current.left, "left operand"), bindings),
        evaluateNode(node(current.right, "right operand"), bindings),
      );
    case "LogicalExpression": {
      const left = evaluateNode(node(current.left, "left operand"), bindings);
      if (current.operator === "&&") {
        return left ? evaluateNode(node(current.right, "right operand"), bindings) : left;
      }
      if (current.operator === "||") {
        return left ? left : evaluateNode(node(current.right, "right operand"), bindings);
      }
      if (current.operator === "??") {
        return left ?? evaluateNode(node(current.right, "right operand"), bindings);
      }
      throw evaluatorError(`does not support operator '${String(current.operator)}'`);
    }
    case "ConditionalExpression":
      return evaluateNode(node(current.test, "condition"), bindings)
        ? evaluateNode(node(current.consequent, "consequent"), bindings)
        : evaluateNode(node(current.alternate, "alternate"), bindings);
    case "ArrayExpression":
      return (current.elements as readonly unknown[]).map((element) => {
        if (element === null) return undefined;
        const item = node(element, "array element");
        if (item.type === "SpreadElement") {
          throw evaluatorError("does not support spread elements");
        }
        return evaluateNode(item, bindings);
      });
    case "ObjectExpression": {
      const out = Object.create(null) as Record<PropertyKey, unknown>;
      for (const rawProperty of current.properties as readonly unknown[]) {
        const property = node(rawProperty, "object property");
        if (property.type !== "Property" || property.kind !== "init" || property.method === true) {
          throw evaluatorError("supports only ordinary object properties");
        }
        const key = property.computed === true
          ? evaluateNode(node(property.key, "computed property"), bindings)
          : staticProperty({ ...property, property: property.key });
        if (typeof key !== "string" && typeof key !== "number") {
          throw evaluatorError("requires string or number object keys");
        }
        out[key] = evaluateNode(node(property.value, "property value"), bindings);
      }
      return out;
    }
    case "TemplateLiteral": {
      const quasis = current.quasis as readonly EvaluatorNode[];
      const expressions = current.expressions as readonly EvaluatorNode[];
      let out = String((quasis[0]!.value as { cooked?: string }).cooked ?? "");
      for (let index = 0; index < expressions.length; index++) {
        const value = evaluateNode(expressions[index]!, bindings);
        if (!primitive(value)) {
          throw evaluatorError("template substitutions must be primitive");
        }
        out += String(value);
        out += String((quasis[index + 1]!.value as { cooked?: string }).cooked ?? "");
      }
      return out;
    }
    default:
      throw evaluatorError(`does not support syntax '${current.type}'`);
  }
};

const validateEvaluatorNode = (
  current: EvaluatorNode,
  parameters: ReadonlySet<string>,
): void => {
  switch (current.type) {
    case "Literal":
      if (current.regex !== undefined || current.bigint !== undefined) {
        throw evaluatorError("supports only canonical primitive literals");
      }
      return;
    case "Identifier": {
      const name = String(current.name);
      if (name !== "undefined" && !parameters.has(name)) {
        throw evaluatorError(`references undeclared identifier '${name}'`);
      }
      return;
    }
    case "MemberExpression":
      if (current.optional === true) {
        throw evaluatorError("does not support optional member access");
      }
      staticProperty(current);
      validateEvaluatorNode(node(current.object, "member target"), parameters);
      return;
    case "UnaryExpression": {
      const operator = String(current.operator);
      if (!["!", "typeof", "+", "-", "~"].includes(operator)) {
        throw evaluatorError(`does not support operator '${operator}'`);
      }
      validateEvaluatorNode(node(current.argument, "unary argument"), parameters);
      return;
    }
    case "BinaryExpression": {
      const operator = String(current.operator);
      if (![
        "===", "!==", "+", "-", "*", "/", "%", "**", "<", "<=", ">", ">=",
        "|", "&", "^", "<<", ">>", ">>>",
      ].includes(operator)) {
        throw evaluatorError(`does not support operator '${operator}'`);
      }
      validateEvaluatorNode(node(current.left, "left operand"), parameters);
      validateEvaluatorNode(node(current.right, "right operand"), parameters);
      return;
    }
    case "LogicalExpression": {
      const operator = String(current.operator);
      if (!["&&", "||", "??"].includes(operator)) {
        throw evaluatorError(`does not support operator '${operator}'`);
      }
      validateEvaluatorNode(node(current.left, "left operand"), parameters);
      validateEvaluatorNode(node(current.right, "right operand"), parameters);
      return;
    }
    case "ConditionalExpression":
      validateEvaluatorNode(node(current.test, "condition"), parameters);
      validateEvaluatorNode(node(current.consequent, "consequent"), parameters);
      validateEvaluatorNode(node(current.alternate, "alternate"), parameters);
      return;
    case "ArrayExpression":
      for (const element of current.elements as readonly unknown[]) {
        if (element === null) continue;
        const item = node(element, "array element");
        if (item.type === "SpreadElement") {
          throw evaluatorError("does not support spread elements");
        }
        validateEvaluatorNode(item, parameters);
      }
      return;
    case "ObjectExpression":
      for (const rawProperty of current.properties as readonly unknown[]) {
        const property = node(rawProperty, "object property");
        if (property.type !== "Property" || property.kind !== "init" || property.method === true) {
          throw evaluatorError("supports only ordinary object properties");
        }
        if (property.computed === true) {
          validateEvaluatorNode(node(property.key, "computed property"), parameters);
        } else {
          staticProperty({ ...property, property: property.key });
        }
        validateEvaluatorNode(node(property.value, "property value"), parameters);
      }
      return;
    case "TemplateLiteral":
      for (const expression of current.expressions as readonly unknown[]) {
        validateEvaluatorNode(node(expression, "template expression"), parameters);
      }
      return;
    default:
      throw evaluatorError(`does not support syntax '${current.type}'`);
  }
};

const compileEvaluator = <Inputs extends CreationDefaultInputs, A>(
  source: string,
  snapshot: ImmutableCreationDefaultInputs<Inputs>,
): ((context: CreationDefaultContext) => A | undefined) => {
  let program: EvaluatorNode;
  try {
    program = parse(`(${source})`, { ecmaVersion: "latest" }) as unknown as EvaluatorNode;
  } catch (cause) {
    throw evaluatorError(
      `must be parseable JavaScript: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const statement = node((program.body as readonly unknown[])[0], "program body");
  const evaluator = node(statement.expression, "expression");
  if (
    statement.type !== "ExpressionStatement" ||
    (evaluator.type !== "ArrowFunctionExpression" && evaluator.type !== "FunctionExpression")
  ) {
    throw evaluatorError("must be an arrow or function expression");
  }
  const parameters = evaluator.params as readonly unknown[];
  if (parameters.length > 2) {
    throw evaluatorError("accepts at most inputs and context parameters");
  }
  const names = parameters.map((parameter) => {
    const item = node(parameter, "parameter");
    if (item.type !== "Identifier" || typeof item.name !== "string") {
      throw evaluatorError("requires simple identifier parameters");
    }
    return item.name;
  });
  let expression = node(evaluator.body, "body");
  if (expression.type === "BlockStatement") {
    const statements = expression.body as readonly unknown[];
    if (statements.length !== 1) {
      throw evaluatorError("block bodies must contain exactly one return statement");
    }
    const returned = node(statements[0], "return statement");
    if (returned.type !== "ReturnStatement" || returned.argument === null) {
      throw evaluatorError("block bodies must contain exactly one return statement");
    }
    expression = node(returned.argument, "return value");
  }
  validateEvaluatorNode(expression, new Set(names));
  return (context) => {
    const value = evaluateNode(expression, Object.freeze({
      ...(names[0] === undefined ? {} : { [names[0]]: snapshot }),
      ...(names[1] === undefined ? {} : { [names[1]]: context }),
    }));
    return value === undefined
      ? undefined
      : snapshotInputs(value as CreationDefaultInputs) as A;
  };
};

/**
 * Snapshot every runtime/config input used by a default as immutable canonical
 * data. The evaluator is parsed as a declarative expression and may read only
 * its snapshot and authoritative context parameters. Calls, mutation, dynamic
 * property names, and undeclared identifiers are rejected. Capture Date and
 * Uint8Array values in `inputs`; constructing them inside the evaluator is not
 * supported.
 */
export const creationDefault = <
  A,
  const Inputs extends CreationDefaultInputs,
>(
  inputs: Inputs,
  get: (
    inputs: ImmutableCreationDefaultInputs<Inputs>,
    context: CreationDefaultContext,
  ) => A | undefined,
): CreationDefault<A> => {
  const snapshot = snapshotInputs(inputs) as ImmutableCreationDefaultInputs<Inputs>;
  const source = Function.prototype.toString.call(get);
  const run = compileEvaluator<Inputs, A>(source, snapshot);
  const declared = Object.freeze(run) as CreationDefault<A>;
  creationDefaultIdentities.set(
    declared as CreationDefault<unknown>,
    Object.freeze({ inputs: snapshot, source, evaluate: declared }),
  );
  return declared;
};

/** @internal Immutable identity retained on a declared default. */
export const creationDefaultIdentityOf = (
  get: CreationDefault<unknown>,
): CreationDefaultIdentity | undefined =>
  creationDefaultIdentities.get(get);

/**
 * Field options. Cardinality, uniqueness and ownership live on
 * {@link Field.many} / {@link Field.unique} / {@link Field.owned} — annotating
 * a shared bag cannot erase them.
 *
 * `valueType` is not an option: brand the schema with
 * {@link import("./valueTypes.ts").stored}.
 */
export interface FieldOptions<A = unknown> {
  readonly index?: boolean;
  readonly doc?: string;
  /**
   * Omitted at create; `| undefined` on the default row. Card-many is
   * already trivially satisfiable (empty set) and is never a required key.
   *
   * This is one of two sources of {@link Field.isOptional}. The other is
   * the Effect schema AST: `Field(Schema.UndefinedOr(Schema.String))` is
   * silently optional even when this flag is absent. Say `optional: true`
   * explicitly if you mean it — a schema refactor that admits `undefined`
   * flips requiredness without touching this bag. Fail-closed rejection of
   * that inference is #185's doctrine and is not applied here.
   */
  readonly optional?: boolean;
  /**
   * Pure creation-time default. It is resolved only by the authoritative
   * creation boundary; update and the existing branch of an upsert ignore it.
   */
  readonly default?: CreationDefault<A>;
}

type FieldFlags = {
  readonly cardinality?: Cardinality;
  readonly unique?: Uniqueness | undefined;
  readonly owned?: boolean;
};

/** True when `O` names the key (even if the value is `false` / `undefined`). */
type Named<O, K extends string> = [O] extends [{ readonly [P in K]: unknown }]
  ? true
  : false;

type OptionalOf<O> = [O] extends [{ readonly optional: infer B }]
  ? B extends true
    ? true
    : false
  : false;

/** Composition may set `optional` (`false` → `true`); absence keeps the inner field. */
type MergeOptional<Opt extends boolean, O> = Named<O, "optional"> extends true
  ? OptionalOf<O>
  : Opt;

type HasDefaultOf<O> = Named<O, "default">;
type MergeDefault<Def extends boolean, O> = Named<O, "default"> extends true
  ? true
  : Def;
type ValidDefault<O, A> = O extends {
  readonly default: (...args: infer _Args) => infer D;
}
  ? Exclude<D, undefined> extends A
    ? unknown
    : { readonly "default must return the field value type": true }
  : unknown;

type FieldDefaultValue<S extends SchemaNS.Top, Card extends Cardinality> =
  Card extends "many"
    ? readonly SchemaNS.Schema.Type<S>[]
    : SchemaNS.Schema.Type<S>;

type ValidManyConversion<
  Card extends Cardinality,
  Def extends boolean,
  O = undefined,
> = Card extends "many"
  ? unknown
  : Def extends true
    ? O extends { readonly default: CreationDefault<readonly unknown[]> }
      ? unknown
      : {
        readonly "Field.many(defaultedField) requires a new array default": true;
      }
    : unknown;

/**
 * Fail-closed argument for `Field(schema)` when inference cannot name
 * `:db.type/*`. The brand key is the instruction — wrap with
 * {@link import("./valueTypes.ts").stored}, or use {@link Enum} for a
 * string-literal set. The demand is at this call, not at `install()`.
 */
type InferableSchema<S extends SchemaNS.Top> = InferDbValueType<S> extends DbValueType
  ? S
  : S & {
      readonly "wrap with stored(schema, vt) — this Schema cannot infer :db.type/*": true;
    };

export interface Field<
  S extends SchemaNS.Top = SchemaNS.Top,
  Card extends Cardinality = Cardinality,
  Unique extends Uniqueness | undefined = Uniqueness | undefined,
  VT extends DbValueType | undefined = DbValueType | undefined,
  Owned extends boolean = boolean,
  Opt extends boolean = false,
  Def extends boolean = false,
> {
  readonly _tag: "Field";
  readonly schema: S;
  readonly cardinality: Card;
  readonly unique: Unique;
  readonly index: boolean;
  readonly owned: Owned;
  readonly doc: string | undefined;
  readonly valueType: VT;
  /**
   * Presence flag for required-at-transact. True when `{ optional: true }`
   * **or** the Effect schema AST admits `undefined` (see
   * {@link FieldOptions.optional}). Not named `optional` — that getter is
   * the pull-shaping method on a stamped field. A sixth type parameter so
   * `string({ optional: true })` survives `Entity` stamping the way
   * `owned` / `cardinality` do.
   */
  readonly isOptional: Opt;
  /** Present when declared in the field options. */
  readonly default: Def extends true
    ? CreationDefault<FieldDefaultValue<S, Card>>
    : undefined;
}

export type AnyField = Field<
  SchemaNS.Top,
  Cardinality,
  Uniqueness | undefined,
  DbValueType | undefined,
  boolean,
  boolean,
  boolean
>;

export declare namespace Field {
  /** Any field — the bound for field-generic helpers. */
  export type Any = AnyField;
}

export const isField = (value: unknown): value is AnyField =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Field" &&
  "schema" in value;

const rejectRetiredOptions = (options?: object): void => {
  if (options == null) return;
  if ("valueType" in options) {
    throw new Error(
      "ramose/schema: valueType is not a field option. Brand the schema with stored(schema, vt).",
    );
  }
  if ("cardinality" in options) {
    throw new Error(
      "ramose/schema: cardinality is not a field option. Use Field.many(schema).",
    );
  }
  if ("unique" in options) {
    throw new Error(
      'ramose/schema: unique is not a field option. Use Field.unique(schema, "upsert" | "strict").',
    );
  }
  if ("owned" in options || "isComponent" in options) {
    throw new Error(
      "ramose/schema: owned is not a field option. Use Field.owned(schema).",
    );
  }
};

const makeField = (
  schema: SchemaNS.Top,
  options?: FieldOptions<unknown>,
  flags?: FieldFlags,
): AnyField => {
  rejectRetiredOptions(options);
  const unique = flags?.unique;
  const field = {
    _tag: "Field" as const,
    schema,
    cardinality: flags?.cardinality ?? "one",
    unique,
    index: options?.index ?? unique !== undefined,
    owned: flags?.owned ?? false,
    doc: options?.doc,
    valueType: tryInferDbValueType(schema),
    isOptional: options?.optional === true || schemaAllowsUndefined(schema),
    default: options?.default,
  };
  const members = enumMembersOf(schema);
  return members !== undefined ? Object.assign(field, { members }) : field;
};

const schemaAllowsUndefined = (schema: { readonly ast?: { readonly _tag?: unknown; readonly types?: readonly { readonly _tag?: unknown }[] } }): boolean => {
  const ast = schema.ast;
  if (ast === undefined) return false;
  if (ast._tag === "Undefined") return true;
  if (ast._tag === "Union" && Array.isArray(ast.types)) {
    return ast.types.some((t) => t._tag === "Undefined" || schemaAllowsUndefined({ ast: t }));
  }
  return false;
};

/** Required-at-transact: card-many is never a required key. */
export const isOptionalField = (field: AnyField): boolean =>
  field.cardinality === "many" || field.isOptional === true;

const fieldSchema = (input: AnyField | SchemaNS.Top): SchemaNS.Top =>
  isField(input) ? input.schema : input;

const mergeFieldOptions = (
  input: AnyField | SchemaNS.Top,
  extra?: FieldOptions<unknown>,
): FieldOptions<unknown> => {
  rejectRetiredOptions(extra);
  if (!isField(input)) return extra ?? {};
  const doc = extra?.doc ?? input.doc;
  const defaultValue = extra?.default ?? input.default;
  return {
    index: extra?.index ?? input.index,
    ...(doc !== undefined && { doc }),
    optional: extra?.optional ?? input.isOptional,
    ...(defaultValue !== undefined && { default: defaultValue }),
  };
};

const mergeFlags = (
  input: AnyField | SchemaNS.Top,
  flags?: FieldFlags,
): FieldFlags => {
  if (!isField(input)) return flags ?? {};
  return {
    cardinality: flags?.cardinality ?? input.cardinality,
    unique: flags?.unique ?? input.unique,
    owned: flags?.owned ?? input.owned,
  };
};

const applyField = (
  input: AnyField | SchemaNS.Top,
  options?: FieldOptions<unknown>,
  flags?: FieldFlags,
): AnyField =>
  makeField(fieldSchema(input), mergeFieldOptions(input, options), mergeFlags(input, flags));

const applyManyField = (
  input: AnyField | SchemaNS.Top,
  options?: FieldOptions<unknown>,
): AnyField => {
  if (
    isField(input) &&
    input.cardinality !== "many" &&
    input.default !== undefined &&
    options?.default === undefined
  ) {
    throw new Error(
      "ramose/schema: Field.many(defaultedField) requires a new array default",
    );
  }
  return applyField(input, options, { cardinality: "many" });
};

type FieldMany = {
  <S extends SchemaNS.Top>(
    schema: InferableSchema<S>,
  ): Field<S, "many", undefined, InferDbValueType<S>, false, false, false>;
  <S extends SchemaNS.Top, const O extends FieldOptions>(
    schema: InferableSchema<S>,
    options: O & ValidDefault<O, readonly SchemaNS.Schema.Type<S>[]>,
  ): Field<S, "many", undefined, InferDbValueType<S>, false, OptionalOf<O>, HasDefaultOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean>(
    field: Field<S, C, U, VT, Own, Opt, Def> & ValidManyConversion<C, Def>,
  ): Field<S, "many", U, VT, Own, Opt, Def>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean, const O extends FieldOptions>(
    field: Field<S, C, U, VT, Own, Opt, Def>,
    options: O & ValidDefault<O, readonly SchemaNS.Schema.Type<S>[]> &
      ValidManyConversion<C, Def, O>,
  ): Field<S, "many", U, VT, Own, MergeOptional<Opt, O>, MergeDefault<Def, O>>;
};

type FieldUnique = {
  <S extends SchemaNS.Top, const U extends Uniqueness>(
    schema: InferableSchema<S>,
    uniqueness: U,
  ): Field<S, "one", U, InferDbValueType<S>, false, false, false>;
  <S extends SchemaNS.Top, const U extends Uniqueness, const O extends FieldOptions>(
    schema: InferableSchema<S>,
    uniqueness: U,
    options: O & ValidDefault<O, SchemaNS.Schema.Type<S>>,
  ): Field<S, "one", U, InferDbValueType<S>, false, OptionalOf<O>, HasDefaultOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, _U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean, const U extends Uniqueness>(
    field: Field<S, C, _U, VT, Own, Opt, Def>,
    uniqueness: U,
  ): Field<S, C, U, VT, Own, Opt, Def>;
  <S extends SchemaNS.Top, C extends Cardinality, _U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean, const U extends Uniqueness, const O extends FieldOptions>(
    field: Field<S, C, _U, VT, Own, Opt, Def>,
    uniqueness: U,
    options: O & ValidDefault<O, FieldDefaultValue<S, C>>,
  ): Field<S, C, U, VT, Own, MergeOptional<Opt, O>, MergeDefault<Def, O>>;
};

type FieldOwned = {
  <S extends SchemaNS.Top>(
    schema: InferableSchema<S>,
  ): Field<S, "one", undefined, InferDbValueType<S>, true, false, false>;
  <S extends SchemaNS.Top, const O extends FieldOptions>(
    schema: InferableSchema<S>,
    options: O & ValidDefault<O, SchemaNS.Schema.Type<S>>,
  ): Field<S, "one", undefined, InferDbValueType<S>, true, OptionalOf<O>, HasDefaultOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean>(
    field: Field<S, C, U, VT, Own, Opt, Def>,
  ): Field<S, C, U, VT, true, Opt, Def>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean, const O extends FieldOptions>(
    field: Field<S, C, U, VT, Own, Opt, Def>,
    options: O & ValidDefault<O, FieldDefaultValue<S, C>>,
  ): Field<S, C, U, VT, true, MergeOptional<Opt, O>, MergeDefault<Def, O>>;
};

/**
 * Declare a field. File it under an entity key to stamp `:entity/name`.
 *
 * Prefer the value shorthands (`string()`, `boolean()`, `Ref(User)`, …)
 * for app schemas. `Field(schema)` is the advanced form: a raw Effect
 * Schema. When inference cannot name `:db.type/*`, wrap the schema with
 * {@link import("./valueTypes.ts").stored} — `stored(Schema.Literals(["on", "off"]), "string")`.
 *
 * Cardinality, uniqueness and ownership are the function:
 * `Field.many(schema)`, `Field.unique(schema, "upsert" | "strict")`,
 * `Field.owned(schema)`. They compose with a shorthand or a raw Schema.
 * `"upsert"` unifies with the existing row on a colliding write;
 * `"strict"` rejects the write. Composition cannot change `valueType` —
 * brand the schema with {@link import("./valueTypes.ts").stored}.
 *
 * Runtime `isOptional` has a second source: an Effect schema AST that
 * admits `undefined`. `{ optional: true }` is the documented flag;
 * `Field(Schema.UndefinedOr(Schema.String))` is also optional. The
 * inference is not fail-closed here (#185).
 * `Field.unique` always indexes; `Field.unique(string({ index: false }), "upsert")`
 * discards `index: false` (unique implies index).
 */
export const Field: {
  <S extends SchemaNS.Top>(
    schema: InferableSchema<S>,
  ): Field<S, "one", undefined, InferDbValueType<S>, false, false, false>;
  <S extends SchemaNS.Top, const O extends FieldOptions>(
    schema: InferableSchema<S>,
    options: O & ValidDefault<O, SchemaNS.Schema.Type<S>>,
  ): Field<S, "one", undefined, InferDbValueType<S>, false, OptionalOf<O>, HasDefaultOf<O>>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean>(
    field: Field<S, C, U, VT, Own, Opt, Def>,
  ): Field<S, C, U, VT, Own, Opt, Def>;
  <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean, const O extends FieldOptions>(
    field: Field<S, C, U, VT, Own, Opt, Def>,
    options: O & ValidDefault<O, FieldDefaultValue<S, C>>,
  ): Field<S, C, U, VT, Own, MergeOptional<Opt, O>, MergeDefault<Def, O>>;
  readonly many: FieldMany;
  readonly unique: FieldUnique;
  readonly owned: FieldOwned;
} = Object.assign(
  ((input: SchemaNS.Top | AnyField, options?: FieldOptions<unknown>) =>
    applyField(input, options)) as {
    <S extends SchemaNS.Top>(
      schema: InferableSchema<S>,
    ): Field<S, "one", undefined, InferDbValueType<S>, false, false, false>;
    <S extends SchemaNS.Top, const O extends FieldOptions>(
      schema: InferableSchema<S>,
      options: O & ValidDefault<O, SchemaNS.Schema.Type<S>>,
    ): Field<S, "one", undefined, InferDbValueType<S>, false, OptionalOf<O>, HasDefaultOf<O>>;
    <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean>(
      field: Field<S, C, U, VT, Own, Opt, Def>,
    ): Field<S, C, U, VT, Own, Opt, Def>;
    <S extends SchemaNS.Top, C extends Cardinality, U extends Uniqueness | undefined, VT extends DbValueType | undefined, Own extends boolean, Opt extends boolean, Def extends boolean, const O extends FieldOptions>(
      field: Field<S, C, U, VT, Own, Opt, Def>,
      options: O & ValidDefault<O, FieldDefaultValue<S, C>>,
    ): Field<S, C, U, VT, Own, MergeOptional<Opt, O>, MergeDefault<Def, O>>;
  },
  {
    many: ((input: AnyField | SchemaNS.Top, options?: FieldOptions) =>
      applyManyField(input, options)) as FieldMany,
    unique: ((
      input: AnyField | SchemaNS.Top,
      uniqueness: Uniqueness,
      options?: FieldOptions,
    ) =>
      applyField(
        input,
        { ...mergeFieldOptions(input, options), index: true },
        { unique: uniqueness },
      )) as FieldUnique,
    owned: ((input: AnyField | SchemaNS.Top, options?: FieldOptions) =>
      applyField(input, options, { owned: true })) as FieldOwned,
  },
);

export type ValueOf<A extends AnyField> = SchemaNS.Schema.Type<A["schema"]>;

type Shorthand<S extends SchemaNS.Top, VT extends DbValueType> = {
  (): Field<S, "one", undefined, VT, false, false, false>;
  <const O extends FieldOptions>(
    options: O & ValidDefault<O, SchemaNS.Schema.Type<S>>,
  ): Field<S, "one", undefined, VT, false, OptionalOf<O>, HasDefaultOf<O>>;
};

const shorthand =
  <S extends SchemaNS.Top, VT extends DbValueType>(
    schema: S,
  ): Shorthand<S, VT> =>
  ((options?: FieldOptions) =>
    makeField(schema, options)) as Shorthand<S, VT>;

/** Text. Stored as `:db.type/string`. */
export const string: Shorthand<typeof Schema.String, "string"> = shorthand(
  Schema.String,
);

/** True / false. Stored as `:db.type/boolean`. */
export const boolean: Shorthand<typeof Schema.Boolean, "boolean"> = shorthand(
  Schema.Boolean,
);

/** Whole number. Stored as `:db.type/long` (plain `float()` / `Schema.Number` is double). */
export const int: Shorthand<typeof Long, "long"> = shorthand(Long);

/**
 * Floating-point number. Stored as `:db.type/double`.
 *
 * `Finite`, not `Number`: the wire format is JSON, where `Infinity` and `NaN`
 * serialize to `null`, so a non-finite value could never round-trip. Rejecting
 * it at the schema fails loudly instead of silently storing `null`.
 */
export const float: Shorthand<typeof Schema.Finite, "double"> = shorthand(
  Schema.Finite,
);

/** Point in time. You pass and receive a `Date`. Stored as `:db.type/instant`. */
export const timestamp: Shorthand<typeof Instant, "instant"> = shorthand(
  Instant,
);

/** Canonical UUID string. Stored as `:db.type/uuid`. */
export const uuid: Shorthand<typeof Uuid, "uuid"> = shorthand(Uuid);

/** Binary data. Stored as `:db.type/bytes`. */
export const bytes: Shorthand<typeof Bytes, "bytes"> = shorthand(Bytes);

type EnumField<L extends readonly [string, ...string[]]> = Field<
  ReturnType<typeof enumSchema<L>>,
  "one",
  undefined,
  "string",
  false,
  false,
  false
> & { readonly members: L };

type EnumFieldOpts<
  L extends readonly [string, ...string[]],
  O extends FieldOptions<L[number]>,
> = Field<
  ReturnType<typeof enumSchema<L>>,
  "one",
  undefined,
  "string",
  false,
  OptionalOf<O>,
  HasDefaultOf<O>
> & { readonly members: L };

/**
 * Closed string set. Stored as `:db.type/string`. `Enum(["low", "med"])`
 * types the field as `"low" | "med"` and carries the members on the
 * field (`Issue.status.members`) so the UI does not restate the list.
 */
export const Enum: {
  <const L extends readonly [string, ...string[]]>(values: L): EnumField<L>;
  <const L extends readonly [string, ...string[]], const O extends FieldOptions<L[number]>>(
    values: L,
    options: O & ValidDefault<O, L[number]>,
  ): EnumFieldOpts<L, O>;
} = ((values: readonly [string, ...string[]], options?: FieldOptions<string>) =>
  makeField(enumSchema(values), options)) as typeof Enum;

type EntityLike = { readonly fields: object; readonly ns: string };

type RefShorthand = {
  <const N extends EntityLike>(
    target: N,
  ): Field<TargetedRef<N["fields"], N["ns"], N>, "one", undefined, "ref", false, false, false>;
  <const N extends EntityLike>(
    target: () => N,
  ): Field<TargetedRef<N["fields"], N["ns"], N>, "one", undefined, "ref", false, false, false>;
  <const N extends EntityLike, const O extends FieldOptions<number>>(
    target: N,
    options: O & ValidDefault<O, SchemaNS.Schema.Type<TargetedRef<N["fields"], N["ns"], N>>>,
  ): Field<
    TargetedRef<N["fields"], N["ns"], N>,
    "one",
    undefined,
    "ref",
    false,
    OptionalOf<O>,
    HasDefaultOf<O>
  >;
  <const N extends EntityLike, const O extends FieldOptions<number>>(
    target: () => N,
    options: O & ValidDefault<O, SchemaNS.Schema.Type<TargetedRef<N["fields"], N["ns"], N>>>,
  ): Field<
    TargetedRef<N["fields"], N["ns"], N>,
    "one",
    undefined,
    "ref",
    false,
    OptionalOf<O>,
    HasDefaultOf<O>
  >;
  readonly self: Field<
    TargetedRef<SelfMarker>,
    "one",
    undefined,
    "ref",
    false,
    false,
    false
  >;
} & typeof untargetedRef;

/**
 * Targeted reference. Prefer `Ref(User)`; use `Ref(() => Other)` only
 * when the target is declared later. `Ref.self` is a self-ref.
 * The bare `Ref` (passed to {@link Field}) is an untargeted ref.
 */
export const Ref: RefShorthand = Object.assign(
  ((
    target: EntityLike | (() => EntityLike),
    options?: FieldOptions<number>,
  ) => makeField(refSchema(target as EntityLike & (() => EntityLike)), options)) as RefShorthand,
  untargetedRef,
  {
    self: makeField(refSchema.self) as Field<
      TargetedRef<SelfMarker>,
      "one",
      undefined,
      "ref",
      false,
      false,
      false
    >,
  },
);
rememberValueType(Ref, "ref");
