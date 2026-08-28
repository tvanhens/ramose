/** Closure-free deterministic interpreter for artifact-bound operation bodies. */

import { parse } from "acorn";
import type {
  CatalogDescriptor,
  FieldDescriptor,
  OperationDescriptor,
  OperationInputScalarShape,
  OperationInputShape,
} from "./catalog.ts";
import { InvalidIR } from "./failures.ts";
import type { EntityId, TraitId } from "./identities.ts";

type AstNode = {
  readonly type: string;
  readonly [key: string]: unknown;
};

export type CompiledCatalogSymbol = object;
export type CompiledFieldSymbol = object;

type CatalogSymbolMetadata = {
  readonly kind: "entity" | "trait";
  readonly id: EntityId | TraitId;
};

const catalogSymbols = new WeakMap<object, CatalogSymbolMetadata>();
const fieldSymbols = new WeakMap<object, FieldDescriptor>();

export const catalogSymbolOf = (
  value: unknown,
): CatalogSymbolMetadata | undefined =>
  typeof value === "object" && value !== null
    ? catalogSymbols.get(value)
    : undefined;

export const fieldSymbolOf = (
  value: unknown,
): FieldDescriptor | undefined =>
  typeof value === "object" && value !== null
    ? fieldSymbols.get(value)
    : undefined;

const invalid = (message: string): InvalidIR =>
  new InvalidIR({ message: `operation body ${message}` });

const ast = (value: unknown, label: string): AstNode => {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw invalid(`has invalid ${label}`);
  }
  return value as AstNode;
};

const propertyName = (member: AstNode): PropertyKey => {
  const property = ast(member.property, "member property");
  if (member.computed === true) {
    if (property.type !== "Literal") {
      throw invalid("requires statically named computed properties");
    }
    const value = property.value;
    if (typeof value !== "string" && typeof value !== "number") {
      throw invalid("requires string or number property names");
    }
    return value;
  }
  if (property.type !== "Identifier" || typeof property.name !== "string") {
    throw invalid("requires statically named properties");
  }
  return property.name;
};

const ownerFitsEntity = (
  catalog: CatalogDescriptor,
  owner: FieldDescriptor["id"]["owner"],
  entity: EntityId,
): boolean => {
  if (owner.kind === "entity") return owner.name === entity.name;
  return catalog.traitComposition.some((entry) =>
    entry.composer.name === entity.name &&
    entry.transitive.some((trait) => trait.name === owner.name)
  );
};

const makeFieldSymbol = (field: FieldDescriptor): CompiledFieldSymbol => {
  const value = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(value, "ident", {
    value: `:${field.id.owner.name}/${field.id.localName}`,
    enumerable: true,
  });
  fieldSymbols.set(value, field);
  return Object.freeze(value);
};

const makeCatalogSymbol = (
  catalog: CatalogDescriptor,
  metadata: CatalogSymbolMetadata,
): CompiledCatalogSymbol => {
  const value = Object.create(null) as Record<string, unknown>;
  const fields = catalog.fields.filter((field) =>
    metadata.kind === "entity"
      ? ownerFitsEntity(catalog, field.id.owner, metadata.id as EntityId)
      : field.id.owner.kind === "trait" &&
        field.id.owner.name === metadata.id.name
  );
  const byName = new Map<string, FieldDescriptor[]>();
  for (const field of fields) {
    const listed = byName.get(field.id.localName);
    if (listed === undefined) byName.set(field.id.localName, [field]);
    else listed.push(field);
  }
  for (const [name, listed] of byName) {
    if (listed.length !== 1) continue;
    Object.defineProperty(value, name, {
      value: makeFieldSymbol(listed[0]!),
      enumerable: true,
    });
  }
  Object.defineProperty(value, "ns", {
    value: metadata.id.name,
    enumerable: false,
  });
  catalogSymbols.set(value, metadata);
  return Object.freeze(value);
};

const alias = (value: string): string =>
  value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

type CatalogScope = {
  readonly canResolve: (name: string) => boolean;
  readonly resolve: (name: string) => CompiledCatalogSymbol;
};

const fieldKey = (field: FieldDescriptor): string =>
  `${field.id.owner.kind}\0${field.id.owner.name}\0${field.id.localName}`;

const aliasSymbol = (
  catalog: CatalogDescriptor,
  fields: readonly FieldDescriptor[],
  entity?: EntityId,
): CompiledCatalogSymbol => {
  if (entity !== undefined) {
    return makeCatalogSymbol(catalog, { kind: "entity", id: entity });
  }
  const value = Object.create(null) as Record<string, unknown>;
  const byName = new Map<string, FieldDescriptor[]>();
  for (const field of fields) {
    const listed = byName.get(field.id.localName);
    if (listed === undefined) byName.set(field.id.localName, [field]);
    else if (!listed.some((entry) => fieldKey(entry) === fieldKey(field))) {
      listed.push(field);
    }
  }
  for (const [name, listed] of byName) {
    if (listed.length !== 1) continue;
    Object.defineProperty(value, name, {
      value: makeFieldSymbol(listed[0]!),
      enumerable: true,
    });
  }
  return Object.freeze(value);
};

type AliasUsage = {
  readonly definitions: readonly string[];
  readonly fields: ReadonlyMap<string, ReadonlySet<string>>;
};

const aliasUsage = (
  body: AstNode,
  locals: ReadonlySet<string>,
): AliasUsage => {
  const definitions: string[] = [];
  const fields = new Map<string, Set<string>>();
  const visit = (node: AstNode): void => {
    if (node.type === "MemberExpression") {
      const object = ast(node.object, "member target");
      if (object.type === "Identifier") {
        const name = String(object.name);
        if (!locals.has(name) && name !== "undefined") {
          const property = String(propertyName(node));
          const listed = fields.get(name);
          if (listed === undefined) fields.set(name, new Set([property]));
          else listed.add(property);
        }
      }
    }
    if (node.type === "CallExpression") {
      const callee = ast(node.callee, "call target");
      if (callee.type === "MemberExpression") {
        const method = String(propertyName(callee));
        if (["entity", "set", "remove", "delete", "put", "update"].includes(method)) {
          const firstRaw = (node.arguments as readonly unknown[])[0];
          if (firstRaw !== undefined) {
            const first = ast(firstRaw, "call argument");
            if (first.type === "Identifier") {
              const name = String(first.name);
              if (!locals.has(name) && name !== "undefined" && !definitions.includes(name)) {
                definitions.push(name);
              }
            }
          }
        }
      }
    }
    for (const [key, raw] of Object.entries(node)) {
      if (["start", "end", "loc", "type"].includes(key) || raw === null) continue;
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (typeof item === "object" && item !== null && "type" in item) visit(item as AstNode);
        }
      } else if (typeof raw === "object" && "type" in raw) {
        visit(raw as AstNode);
      }
    }
  };
  visit(body);
  return { definitions: Object.freeze(definitions), fields };
};

const catalogScope = (
  catalog: CatalogDescriptor,
  operation: OperationDescriptor,
  body: AstNode,
  locals: ReadonlySet<string>,
): CatalogScope => {
  const entries = [
    ...catalog.entities.map((entry) => ({
      name: alias(entry.id.name),
      value: makeCatalogSymbol(catalog, { kind: "entity", id: entry.id }),
    })),
    ...catalog.traits.map((entry) => ({
      name: alias(entry.id.name),
      value: makeCatalogSymbol(catalog, { kind: "trait", id: entry.id }),
    })),
  ];
  const match = (name: string): CompiledCatalogSymbol | undefined => {
    const normalized = alias(name);
    const matches = entries.filter((entry) => normalized.endsWith(entry.name));
    if (matches.length === 0) return undefined;
    const longest = Math.max(...matches.map((entry) => entry.name.length));
    const exact = matches.filter((entry) => entry.name.length === longest);
    return exact.length === 1 ? exact[0]!.value : undefined;
  };
  const usage = aliasUsage(body, locals);
  const aliases = new Map<string, CompiledCatalogSymbol>();
  const declaredEntities = [
    ...(operation.id.owner.kind === "entity"
      ? catalog.entities.filter((entry) => entry.id.name === operation.id.owner.name).map((entry) => entry.id)
      : []),
    ...operation.writes,
  ];
  for (const [name, properties] of usage.fields) {
    if (match(name) !== undefined) continue;
    const possibleFields = catalog.fields.filter((field) =>
      properties.has(field.id.localName) &&
      declaredEntities.some((entity) => ownerFitsEntity(catalog, field.id.owner, entity))
    );
    aliases.set(name, aliasSymbol(catalog, possibleFields));
  }
  for (const name of usage.definitions) {
    if (match(name) !== undefined) continue;
    const properties = usage.fields.get(name);
    let candidates = properties !== undefined && properties.size > 0
      ? declaredEntities
      : operation.writes;
    if (candidates.length === 0 && operation.id.owner.kind === "entity") {
      candidates = catalog.entities
        .filter((entry) => entry.id.name === operation.id.owner.name)
        .map((entry) => entry.id);
    }
    if (properties !== undefined && properties.size > 0) {
      candidates = candidates.filter((entity) =>
        [...properties].every((property) => catalog.fields.some((field) =>
          field.id.localName === property && ownerFitsEntity(catalog, field.id.owner, entity)
        ))
      );
    }
    if (candidates.length !== 1) {
      throw invalid(
        `cannot bind bundled catalog identifier '${name}' unambiguously in ` +
        `'${operation.id.owner.name}.${operation.id.localName}' ` +
        `(fields: ${[...(properties ?? [])].join(",") || "none"}; ` +
        `candidates: ${candidates.map((entry) => entry.name).join(",") || "none"})`,
      );
    }
    aliases.set(name, aliasSymbol(catalog, [], candidates[0]!));
  }
  return Object.freeze({
    canResolve: (name: string) => match(name) !== undefined || aliases.has(name),
    resolve: (name: string) => {
      const found = match(name) ?? aliases.get(name);
      if (found === undefined) {
        throw invalid(`references undeclared or ambiguous identifier '${name}'`);
      }
      return found;
    },
  });
};

const patternNames = (pattern: AstNode): readonly string[] => {
  if (pattern.type === "Identifier" && typeof pattern.name === "string") {
    return [pattern.name];
  }
  if (pattern.type === "ObjectPattern") {
    return (pattern.properties as readonly unknown[]).flatMap((raw) => {
      const property = ast(raw, "object binding property");
      if (property.type !== "Property" || property.computed === true) {
        throw invalid("supports only static object binding properties");
      }
      return patternNames(ast(property.value, "object binding value"));
    });
  }
  if (pattern.type === "ArrayPattern") {
    return (pattern.elements as readonly unknown[]).flatMap((raw) =>
      raw === null ? [] : patternNames(ast(raw, "array binding value"))
    );
  }
  throw invalid("requires identifier, object, or array bindings");
};

const declaredNames = (body: AstNode): ReadonlySet<string> => {
  const names = new Set<string>();
  if (body.type !== "BlockStatement") return names;
  for (const raw of body.body as readonly unknown[]) {
    const statement = ast(raw, "statement");
    if (statement.type !== "VariableDeclaration") continue;
    for (const rawDeclaration of statement.declarations as readonly unknown[]) {
      const declaration = ast(rawDeclaration, "variable declaration");
      for (const name of patternNames(ast(declaration.id, "variable binding"))) {
        names.add(name);
      }
    }
  }
  return names;
};

const validate = (
  current: AstNode,
  locals: ReadonlySet<string>,
  scope: CatalogScope,
): void => {
  switch (current.type) {
    case "Literal":
      if (current.regex !== undefined || current.bigint !== undefined) {
        throw invalid("supports only canonical primitive literals");
      }
      return;
    case "Identifier": {
      const name = String(current.name);
      if (name !== "undefined" && !locals.has(name) && !scope.canResolve(name)) {
        throw invalid(`references undeclared identifier '${name}'`);
      }
      return;
    }
    case "MemberExpression":
      if (current.optional === true) throw invalid("does not support optional member access");
      propertyName(current);
      validate(ast(current.object, "member target"), locals, scope);
      return;
    case "CallExpression":
      if (current.optional === true) throw invalid("does not support optional calls");
      validate(ast(current.callee, "call target"), locals, scope);
      for (const raw of current.arguments as readonly unknown[]) {
        const argument = ast(raw, "call argument");
        if (argument.type === "SpreadElement") throw invalid("does not support spread arguments");
        validate(argument, locals, scope);
      }
      return;
    case "AwaitExpression":
      validate(ast(current.argument, "await argument"), locals, scope);
      return;
    case "UnaryExpression":
      if (!["!", "typeof", "+", "-", "~"].includes(String(current.operator))) {
        throw invalid(`does not support unary operator '${String(current.operator)}'`);
      }
      validate(ast(current.argument, "unary argument"), locals, scope);
      return;
    case "BinaryExpression":
      if (![
        "===", "!==", "+", "-", "*", "/", "%", "**", "<", "<=", ">", ">=",
        "|", "&", "^", "<<", ">>", ">>>",
      ].includes(String(current.operator))) {
        throw invalid(`does not support binary operator '${String(current.operator)}'`);
      }
      validate(ast(current.left, "left operand"), locals, scope);
      validate(ast(current.right, "right operand"), locals, scope);
      return;
    case "LogicalExpression":
      if (!["&&", "||", "??"].includes(String(current.operator))) {
        throw invalid(`does not support logical operator '${String(current.operator)}'`);
      }
      validate(ast(current.left, "left operand"), locals, scope);
      validate(ast(current.right, "right operand"), locals, scope);
      return;
    case "ConditionalExpression":
      validate(ast(current.test, "condition"), locals, scope);
      validate(ast(current.consequent, "consequent"), locals, scope);
      validate(ast(current.alternate, "alternate"), locals, scope);
      return;
    case "SequenceExpression":
      for (const raw of current.expressions as readonly unknown[]) {
        validate(ast(raw, "sequence expression"), locals, scope);
      }
      return;
    case "ArrayExpression":
      for (const raw of current.elements as readonly unknown[]) {
        if (raw === null) continue;
        const item = ast(raw, "array element");
        if (item.type === "SpreadElement") throw invalid("does not support spread elements");
        validate(item, locals, scope);
      }
      return;
    case "ObjectExpression":
      for (const raw of current.properties as readonly unknown[]) {
        const property = ast(raw, "object property");
        if (property.type !== "Property" || property.kind !== "init" || property.method === true) {
          throw invalid("supports only ordinary object properties");
        }
        if (property.computed === true) validate(ast(property.key, "object key"), locals, scope);
        validate(ast(property.value, "object value"), locals, scope);
      }
      return;
    case "TemplateLiteral":
      for (const raw of current.expressions as readonly unknown[]) {
        validate(ast(raw, "template expression"), locals, scope);
      }
      return;
    case "BlockStatement":
      for (const raw of current.body as readonly unknown[]) validate(ast(raw, "statement"), locals, scope);
      return;
    case "ExpressionStatement":
      validate(ast(current.expression, "expression"), locals, scope);
      return;
    case "ReturnStatement":
      if (current.argument !== null) validate(ast(current.argument, "return value"), locals, scope);
      return;
    case "VariableDeclaration":
      if (current.kind !== "const" && current.kind !== "let") {
        throw invalid("supports only initialized const or let declarations");
      }
      for (const raw of current.declarations as readonly unknown[]) {
        const declaration = ast(raw, "variable declaration");
        if (declaration.init === null) throw invalid("requires initialized const declarations");
        validate(ast(declaration.init, "variable initializer"), locals, scope);
      }
      return;
    case "IfStatement":
      validate(ast(current.test, "if condition"), locals, scope);
      validate(ast(current.consequent, "if consequent"), locals, scope);
      if (current.alternate !== null) validate(ast(current.alternate, "if alternate"), locals, scope);
      return;
    case "EmptyStatement":
      return;
    default:
      throw invalid(`does not support syntax '${current.type}'`);
  }
};

type StaticValueShape = OperationInputShape | undefined;

const scalarShape = (valueType: OperationInputScalarShape["valueType"]): OperationInputScalarShape => ({
  _tag: "scalar",
  valueType,
});

const bindStaticShape = (
  pattern: AstNode,
  shape: StaticValueShape,
  shapes: Map<string, StaticValueShape>,
): void => {
  if (pattern.type === "Identifier") {
    shapes.set(String(pattern.name), shape);
    return;
  }
  if (pattern.type === "ObjectPattern") {
    for (const raw of pattern.properties as readonly unknown[]) {
      const property = ast(raw, "object binding property");
      const key = String(propertyName({ ...property, property: property.key }));
      const field = shape?._tag === "struct"
        ? shape.fields.find((candidate) => candidate.key === key)
        : undefined;
      bindStaticShape(ast(property.value, "object binding value"), field?.shape, shapes);
    }
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const raw of pattern.elements as readonly unknown[]) {
      if (raw !== null) {
        bindStaticShape(
          ast(raw, "array binding value"),
          shape?._tag === "array" ? shape.items : undefined,
          shapes,
        );
      }
    }
  }
};

const staticShape = (
  current: AstNode,
  shapes: ReadonlyMap<string, StaticValueShape>,
): StaticValueShape => {
  if (current.type === "Identifier") return shapes.get(String(current.name));
  if (current.type === "Literal") {
    if (typeof current.value === "string") return scalarShape("string");
    if (typeof current.value === "number") return scalarShape("double");
    if (typeof current.value === "boolean") return scalarShape("boolean");
    return undefined;
  }
  if (current.type === "TemplateLiteral") return scalarShape("string");
  if (current.type !== "MemberExpression") return undefined;

  const target = staticShape(ast(current.object, "member target"), shapes);
  if (target === undefined) return undefined;
  const key = propertyName(current);
  switch (target._tag) {
    case "struct": {
      const field = target.fields.find((candidate) => candidate.key === String(key));
      if (field === undefined) {
        throw invalid(`references unknown input member '${String(key)}'`);
      }
      return field.shape;
    }
    case "array":
      if (key === "length") return scalarShape("long");
      if (typeof key === "number" || /^(0|[1-9][0-9]*)$/.test(String(key))) {
        return target.items;
      }
      throw invalid(`does not support inherited array member '${String(key)}'`);
    case "scalar":
    case "ref":
      throw invalid(`does not support member '${String(key)}' on ${target._tag} input values`);
    case "opaque":
      throw invalid(`cannot validate member '${String(key)}' on opaque input values`);
  }
};

/** Reject member access whose runtime support cannot follow from the installed input shape. */
const validateStaticMemberAccess = (
  body: AstNode,
  inputPattern: AstNode | undefined,
  input: OperationInputShape,
): void => {
  const shapes = new Map<string, StaticValueShape>();
  if (inputPattern !== undefined) bindStaticShape(inputPattern, input, shapes);
  const visit = (current: AstNode): void => {
    if (current.type === "VariableDeclaration") {
      for (const raw of current.declarations as readonly unknown[]) {
        const declaration = ast(raw, "variable declaration");
        const initializer = ast(declaration.init, "variable initializer");
        visit(initializer);
        bindStaticShape(
          ast(declaration.id, "variable binding"),
          staticShape(initializer, shapes),
          shapes,
        );
      }
      return;
    }
    if (current.type === "MemberExpression") staticShape(current, shapes);
    for (const [key, raw] of Object.entries(current)) {
      if (["start", "end", "loc", "type"].includes(key) || raw === null) continue;
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (typeof item === "object" && item !== null && "type" in item) visit(item as AstNode);
        }
      } else if (typeof raw === "object" && "type" in raw) {
        visit(raw as AstNode);
      }
    }
  };
  visit(body);
};

class Environment {
  readonly #values = new Map<string, unknown>();
  constructor(
    readonly scope: CatalogScope,
  ) {}
  set(name: string, value: unknown): void {
    this.#values.set(name, value);
  }
  get(name: string): unknown {
    if (name === "undefined") return undefined;
    if (this.#values.has(name)) return this.#values.get(name);
    return this.scope.resolve(name);
  }
}

const bindPattern = (
  pattern: AstNode,
  value: unknown,
  environment: Environment,
): void => {
  if (pattern.type === "Identifier") {
    environment.set(String(pattern.name), value);
    return;
  }
  if (pattern.type === "ObjectPattern") {
    if (typeof value !== "object" || value === null) {
      throw invalid("cannot destructure a non-object value");
    }
    for (const raw of pattern.properties as readonly unknown[]) {
      const property = ast(raw, "object binding property");
      const key = propertyName({ ...property, property: property.key });
      bindPattern(
        ast(property.value, "object binding value"),
        Reflect.get(value, key),
        environment,
      );
    }
    return;
  }
  if (pattern.type === "ArrayPattern") {
    if (!Array.isArray(value)) throw invalid("cannot destructure a non-array value");
    const elements = pattern.elements as readonly unknown[];
    for (let index = 0; index < elements.length; index++) {
      const item = elements[index];
      if (item !== null) bindPattern(ast(item, "array binding value"), value[index], environment);
    }
    return;
  }
  throw invalid("has an unsupported binding pattern");
};

const own = (target: unknown, key: PropertyKey): unknown => {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) {
    throw invalid(`cannot read '${String(key)}' from a primitive`);
  }
  if (!Object.hasOwn(target, key)) {
    throw invalid(`cannot read inherited or missing property '${String(key)}'`);
  }
  return Reflect.get(target, key);
};

const binary = (operator: string, left: unknown, right: unknown): unknown => {
  switch (operator) {
    case "===": return left === right;
    case "!==": return left !== right;
    case "+": return (left as never) + (right as never);
    case "-": return Number(left) - Number(right);
    case "*": return Number(left) * Number(right);
    case "/": return Number(left) / Number(right);
    case "%": return Number(left) % Number(right);
    case "**": return Number(left) ** Number(right);
    case "<": return (left as never) < (right as never);
    case "<=": return (left as never) <= (right as never);
    case ">": return (left as never) > (right as never);
    case ">=": return (left as never) >= (right as never);
    case "|": return Number(left) | Number(right);
    case "&": return Number(left) & Number(right);
    case "^": return Number(left) ^ Number(right);
    case "<<": return Number(left) << Number(right);
    case ">>": return Number(left) >> Number(right);
    case ">>>": return Number(left) >>> Number(right);
    default: throw invalid(`does not support binary operator '${operator}'`);
  }
};

const evaluate = async (current: AstNode, environment: Environment): Promise<unknown> => {
  switch (current.type) {
    case "Literal": return current.value;
    case "Identifier": return environment.get(String(current.name));
    case "MemberExpression":
      return own(
        await evaluate(ast(current.object, "member target"), environment),
        propertyName(current),
      );
    case "CallExpression": {
      const callee = ast(current.callee, "call target");
      let receiver: unknown = undefined;
      let fn: unknown;
      if (callee.type === "MemberExpression") {
        receiver = await evaluate(ast(callee.object, "call receiver"), environment);
        fn = own(receiver, propertyName(callee));
      } else {
        fn = await evaluate(callee, environment);
      }
      if (typeof fn !== "function") throw invalid("attempted to call a non-function");
      const args = [];
      for (const raw of current.arguments as readonly unknown[]) {
        args.push(await evaluate(ast(raw, "call argument"), environment));
      }
      return Reflect.apply(fn, receiver, args);
    }
    case "AwaitExpression":
      return await evaluate(ast(current.argument, "await argument"), environment);
    case "UnaryExpression": {
      const value = await evaluate(ast(current.argument, "unary argument"), environment);
      switch (current.operator) {
        case "!": return !value;
        case "typeof": return typeof value;
        case "+": return Number(value);
        case "-": return -Number(value);
        case "~": return ~Number(value);
        default: throw invalid(`does not support unary operator '${String(current.operator)}'`);
      }
    }
    case "BinaryExpression":
      return binary(
        String(current.operator),
        await evaluate(ast(current.left, "left operand"), environment),
        await evaluate(ast(current.right, "right operand"), environment),
      );
    case "LogicalExpression": {
      const left = await evaluate(ast(current.left, "left operand"), environment);
      if (current.operator === "&&") {
        return left ? evaluate(ast(current.right, "right operand"), environment) : left;
      }
      if (current.operator === "||") {
        return left ? left : evaluate(ast(current.right, "right operand"), environment);
      }
      return left ?? evaluate(ast(current.right, "right operand"), environment);
    }
    case "ConditionalExpression":
      return await evaluate(ast(current.test, "condition"), environment)
        ? evaluate(ast(current.consequent, "consequent"), environment)
        : evaluate(ast(current.alternate, "alternate"), environment);
    case "SequenceExpression": {
      let value: unknown = undefined;
      for (const raw of current.expressions as readonly unknown[]) {
        value = await evaluate(ast(raw, "sequence expression"), environment);
      }
      return value;
    }
    case "ArrayExpression": {
      const out = [];
      for (const raw of current.elements as readonly unknown[]) {
        out.push(raw === null ? undefined : await evaluate(ast(raw, "array element"), environment));
      }
      return out;
    }
    case "ObjectExpression": {
      const out = Object.create(null) as Record<PropertyKey, unknown>;
      for (const raw of current.properties as readonly unknown[]) {
        const property = ast(raw, "object property");
        const key = property.computed === true
          ? await evaluate(ast(property.key, "object key"), environment) as PropertyKey
          : propertyName({ ...property, property: property.key });
        out[key] = await evaluate(ast(property.value, "object value"), environment);
      }
      return out;
    }
    case "TemplateLiteral": {
      const quasis = current.quasis as readonly AstNode[];
      const expressions = current.expressions as readonly unknown[];
      let out = String((quasis[0]!.value as { cooked?: string }).cooked ?? "");
      for (let index = 0; index < expressions.length; index++) {
        out += String(await evaluate(ast(expressions[index], "template expression"), environment));
        out += String((quasis[index + 1]!.value as { cooked?: string }).cooked ?? "");
      }
      return out;
    }
    default:
      throw invalid(`cannot evaluate syntax '${current.type}'`);
  }
};

type ReturnSignal = { readonly returned: true; readonly value: unknown };

const executeStatement = async (
  statement: AstNode,
  environment: Environment,
): Promise<ReturnSignal | undefined> => {
  switch (statement.type) {
    case "EmptyStatement": return undefined;
    case "ExpressionStatement":
      await evaluate(ast(statement.expression, "expression"), environment);
      return undefined;
    case "ReturnStatement":
      return {
        returned: true,
        value: statement.argument === null
          ? undefined
          : await evaluate(ast(statement.argument, "return value"), environment),
      };
    case "VariableDeclaration":
      for (const raw of statement.declarations as readonly unknown[]) {
        const declaration = ast(raw, "variable declaration");
        bindPattern(
          ast(declaration.id, "variable binding"),
          await evaluate(ast(declaration.init, "variable initializer"), environment),
          environment,
        );
      }
      return undefined;
    case "IfStatement": {
      const branch = await evaluate(ast(statement.test, "if condition"), environment)
        ? ast(statement.consequent, "if consequent")
        : statement.alternate === null
        ? undefined
        : ast(statement.alternate, "if alternate");
      return branch === undefined ? undefined : executeStatement(branch, environment);
    }
    case "BlockStatement":
      for (const raw of statement.body as readonly unknown[]) {
        const result = await executeStatement(ast(raw, "statement"), environment);
        if (result !== undefined) return result;
      }
      return undefined;
    default:
      throw invalid(`cannot execute syntax '${statement.type}'`);
  }
};

const parseBody = (source: string): AstNode => {
  const parseExpression = (text: string): AstNode => {
    const program = parse(text, { ecmaVersion: "latest" }) as unknown as AstNode;
    const statement = ast((program.body as readonly unknown[])[0], "program statement");
    return ast(statement.expression, "function expression");
  };
  try {
    const expression = parseExpression(`(${source})`);
    if (expression.type === "ArrowFunctionExpression" || expression.type === "FunctionExpression") {
      return expression;
    }
  } catch {}
  try {
    const object = parseExpression(`({${source}})`);
    const property = ast((object.properties as readonly unknown[])[0], "method property");
    const value = ast(property.value, "method value");
    if (value.type === "FunctionExpression") return value;
  } catch (cause) {
    throw invalid(
      `must be parseable JavaScript: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  throw invalid("must be a function, arrow, or method body");
};

export type CompiledOperationBody = (
  op: unknown,
  input: unknown,
) => Promise<unknown>;

/** Compile one frozen body source into a deterministic, closure-free plan. */
export const compileOperationBody = (
  source: string,
  catalog: CatalogDescriptor,
  operation: OperationDescriptor,
): CompiledOperationBody => {
  const fn = parseBody(source);
  const params = fn.params as readonly unknown[];
  if (params.length > 2) throw invalid("accepts at most op and input parameters");
  const patterns = params.map((parameter) => ast(parameter, "parameter"));
  const locals = new Set(patterns.flatMap(patternNames));
  for (const name of declaredNames(ast(fn.body, "function body"))) locals.add(name);
  const scope = catalogScope(catalog, operation, ast(fn.body, "function body"), locals);
  validate(ast(fn.body, "function body"), locals, scope);
  validateStaticMemberAccess(ast(fn.body, "function body"), patterns[1], operation.input);

  return Object.freeze(async (op: unknown, input: unknown): Promise<unknown> => {
    const environment = new Environment(scope);
    if (patterns[0] !== undefined) bindPattern(patterns[0], op, environment);
    if (patterns[1] !== undefined) bindPattern(patterns[1], input, environment);
    const body = ast(fn.body, "function body");
    if (body.type !== "BlockStatement") return evaluate(body, environment);
    const result = await executeStatement(body, environment);
    return result?.value;
  });
};
