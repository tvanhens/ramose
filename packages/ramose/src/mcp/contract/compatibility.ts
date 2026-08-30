/**
 * Version negotiation and forward-compatible extension rules (#485).
 *
 * The contract is meant to be *frozen*, and freezing something is only useful
 * if there is a rule for what may still change. That rule is here, stated
 * twice: once as prose a reviewer can read, and once as
 * {@link classifyContractChange}, which decides mechanically so a compatibility
 * argument cannot be won by assertion.
 *
 * ## The two directions
 *
 * Compatibility is not symmetric, because the two ends of a schema are used by
 * different parties.
 *
 * - An **input** schema is what the server accepts. Old clients keep sending
 *   what they always sent, so the server may only ever *widen* what it
 *   accepts: a new optional argument is fine, a new required one is not.
 * - An **output** schema is what the server produces. Old clients keep
 *   reading what they always read, so the server may only ever *keep its
 *   promises*: a new member is fine, dropping one is not, and a new member of
 *   a closed union is not — an exhaustive client would silently mis-handle it.
 *
 * That last case is why the nine error codes are closed for v1. Adding a
 * tenth is a new contract version, not an additive change.
 *
 * ## What is not covered here
 *
 * A change to the query language is a new query-document `version`; a change
 * to one operation's contract rotates that operation's own version (#487) and
 * nothing else; a change to a Resource's meaning is a new Resource kind. Those
 * are separate version domains on purpose — a documentation edit must not
 * rotate an operation, and an operation change must not invalidate every
 * cursor in flight.
 */

/** The wire-contract version this module defines. */
export const CONTRACT_VERSION = 1 as const;

/** Changes that may be made inside contract v1 without a version bump. */
export const ADDITIVE_WITHIN_V1: readonly string[] = Object.freeze([
  "Add an optional property to a tool input schema.",
  "Add a property to a tool output schema.",
  "Relax a required input property to optional.",
  "Promote an optional output property to always-present.",
  "Widen an input enumeration, for example a new describe kind the server accepts.",
  "Narrow an output enumeration to a subset a client already handles.",
  "Add a new capability card kind behind its own `kind` discriminator.",
  "Add a new Resource kind under the ramose:// scheme.",
  "Relax a documented bound toward, but not past, the engine-internal ceiling.",
  "Improve any title, description, or hint. Prose is never part of compatibility.",
]);

/** Changes that require a new contract, query, operation, or Resource version. */
export const REQUIRES_NEW_VERSION: readonly string[] = Object.freeze([
  "Add a public error code: an exhaustive client would mis-handle it.",
  "Add a required property to a tool input schema.",
  "Remove or rename any property in either direction.",
  "Change a property's type, or narrow an input enumeration.",
  "Change what an existing property means, including its units or nullability.",
  "Change the meaning of an opaque token, cursor, version, or Resource URI.",
  "Change the query language's semantics: a new query-document version.",
  "Change one operation's public contract: that operation's version rotates.",
  "Tighten a documented bound so a previously valid request becomes invalid.",
]);

type SchemaNode = { readonly [key: string]: unknown };

/** Which end of the wire a schema describes. See the module docs. */
export type ChangeDirectionV1 = "input" | "output";

/** The verdict, with every reason a breaking change was breaking. */
export type ChangeClassificationV1 =
  | { readonly kind: "additive" }
  | { readonly kind: "breaking"; readonly reasons: readonly string[] };

const isObject = (value: unknown): value is SchemaNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const DEFS_PREFIX = "#/$defs/";

/** Follow local `$ref`s into a document's own `$defs`, guarding cycles. */
const resolve = (
  node: unknown,
  defs: SchemaNode,
  seen: ReadonlySet<string> = new Set(),
): SchemaNode | undefined => {
  if (!isObject(node)) return undefined;
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith(DEFS_PREFIX)) return node;
  const name = ref.slice(DEFS_PREFIX.length);
  if (seen.has(name)) return node;
  const target = defs[name];
  if (!isObject(target)) return node;
  return resolve(target, defs, new Set([...seen, name]));
};

const stringSet = (value: unknown): ReadonlySet<string> =>
  new Set(Array.isArray(value) ? value.filter((x) => typeof x === "string") : []);

const enumValues = (node: SchemaNode): readonly unknown[] | undefined => {
  if (Array.isArray(node.enum)) return node.enum;
  if (Object.hasOwn(node, "const")) return [node.const];
  return undefined;
};

const sameScalar = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const describe = (path: readonly string[]): string =>
  path.length === 0 ? "<root>" : path.join(".");

// ---------------------------------------------------------------------------
// Keyword polarity
// ---------------------------------------------------------------------------
//
// A constraint keyword either tightens what a schema accepts or loosens it,
// and which of those is safe depends only on the direction. Tightening an
// input rejects requests that used to work; loosening an output produces
// values a client's older schema will reject. Both are breaks, and they are
// mirror images — which is why one table serves both directions.

/** Documentation. Never part of a compatibility decision. */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "$defs",
  "definitions",
  "title",
  "description",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/** Handled structurally elsewhere in `compare`. */
const STRUCTURAL_KEYWORDS: ReadonlySet<string> = new Set([
  "$ref",
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "items",
  "anyOf",
  "oneOf",
  "allOf",
  "additionalProperties",
]);

/** Raising one of these tightens the schema. Absent means unbounded below. */
const LOWER_BOUND_KEYWORDS: ReadonlySet<string> = new Set([
  "minLength",
  "minItems",
  "minProperties",
  "minimum",
  "exclusiveMinimum",
  "minContains",
]);

/** Lowering one of these tightens the schema. Absent means unbounded above. */
const UPPER_BOUND_KEYWORDS: ReadonlySet<string> = new Set([
  "maxLength",
  "maxItems",
  "maxProperties",
  "maximum",
  "exclusiveMaximum",
  "maxContains",
]);

/** Turning one of these on tightens the schema. Absent means off. */
const TIGHTENING_FLAG_KEYWORDS: ReadonlySet<string> = new Set(["uniqueItems"]);

/**
 * Recognized keywords whose values cannot be ordered, so any change to one is
 * reported rather than guessed at. Two regular expressions have no decidable
 * subset relation; neither do `if`/`then`/`else` or the applicator keywords.
 */
const EXACT_MATCH_KEYWORDS: ReadonlySet<string> = new Set([
  "pattern",
  "format",
  "multipleOf",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "propertyNames",
  "patternProperties",
  "dependentRequired",
  "dependentSchemas",
  "prefixItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/**
 * `additionalProperties` as a three-state openness, tightest last. A schema
 * value sits between the two booleans and cannot be ordered against either.
 */
const openness = (value: unknown): "open" | "closed" | "constrained" => {
  if (value === undefined || value === true) return "open";
  if (value === false) return "closed";
  return "constrained";
};

/**
 * Decide whether moving from `before` to `after` is additive for the given
 * direction, or breaking — and if breaking, exactly why.
 *
 * Both arguments are self-contained JSON Schema 2020-12 roots, as
 * `json-schema.ts` produces. Comparison walks `properties` and follows local
 * `$ref`s.
 *
 * It fails closed. Constraint keywords are compared by polarity, keywords whose
 * values cannot be ordered are reported on any change, and a keyword the
 * classifier does not recognize at all is reported on any change too. The
 * asymmetry is deliberate: a wrong "breaking" costs a reviewer an argument,
 * while a wrong "additive" ships a silent break to every client already
 * depending on the old shape — so an unrecognized keyword is never taken as
 * evidence of compatibility.
 */
export const classifyContractChange = (
  before: SchemaNode,
  after: SchemaNode,
  direction: ChangeDirectionV1,
): ChangeClassificationV1 => {
  const reasons: string[] = [];
  const beforeDefs = isObject(before.$defs) ? before.$defs : {};
  const afterDefs = isObject(after.$defs) ? after.$defs : {};
  // Cycle guard keyed by the *pair of resolved nodes*, not by path. A path key
  // would grow without bound on a recursive schema, which never revisits a
  // path but does revisit the same two definitions forever.
  const compared = new WeakMap<object, WeakSet<object>>();

  /**
   * Report a change in what a schema accepts, if this direction cannot take
   * it. Tightening breaks inputs; loosening breaks outputs.
   */
  const reportPolarity = (
    path: readonly string[],
    keyword: string,
    change: "tightened" | "loosened",
  ): void => {
    const breaks = direction === "input"
      ? change === "tightened"
      : change === "loosened";
    if (breaks) {
      reasons.push(`${describe(path)}: ${direction} ${keyword} ${change}`);
    }
  };

  /**
   * Compare every keyword that is not walked structurally.
   *
   * The union of both nodes' keys is considered, so a constraint that appears
   * or disappears is judged the same way as one whose value moved.
   */
  const compareConstraints = (
    left: SchemaNode,
    right: SchemaNode,
    path: readonly string[],
  ): void => {
    for (const keyword of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (
        ANNOTATION_KEYWORDS.has(keyword) || STRUCTURAL_KEYWORDS.has(keyword)
      ) continue;

      const before = left[keyword];
      const after = right[keyword];
      if (sameScalar(before, after)) continue;

      if (LOWER_BOUND_KEYWORDS.has(keyword) || UPPER_BOUND_KEYWORDS.has(keyword)) {
        const lower = LOWER_BOUND_KEYWORDS.has(keyword);
        const unconstrained = lower ? -Infinity : Infinity;
        const from = typeof before === "number" ? before : unconstrained;
        const to = typeof after === "number" ? after : unconstrained;
        if (from === to) continue;
        const raised = to > from;
        reportPolarity(path, keyword, (lower ? raised : !raised) ? "tightened" : "loosened");
        continue;
      }

      if (TIGHTENING_FLAG_KEYWORDS.has(keyword)) {
        reportPolarity(path, keyword, after === true ? "tightened" : "loosened");
        continue;
      }

      reasons.push(
        EXACT_MATCH_KEYWORDS.has(keyword)
          ? `${describe(path)}: ${keyword} changed, and no ordering between two values of it can be decided`
          : `${describe(path)}: unrecognized keyword ${keyword} changed`,
      );
    }

    const from = openness(left.additionalProperties);
    const to = openness(right.additionalProperties);
    if (from !== to) {
      if (from === "constrained" || to === "constrained") {
        reasons.push(
          `${describe(path)}: additionalProperties changed to or from a schema`,
        );
      } else {
        reportPolarity(
          path,
          "additionalProperties",
          to === "closed" ? "tightened" : "loosened",
        );
      }
    } else if (
      from === "constrained" &&
      !sameScalar(left.additionalProperties, right.additionalProperties)
    ) {
      compare(
        left.additionalProperties,
        right.additionalProperties,
        [...path, "additionalProperties"],
      );
    }
  };

  const compare = (
    beforeNode: unknown,
    afterNode: unknown,
    path: readonly string[],
  ): void => {
    const left = resolve(beforeNode, beforeDefs);
    const right = resolve(afterNode, afterDefs);
    if (left === undefined || right === undefined) return;

    const seenAgainst = compared.get(left);
    if (seenAgainst === undefined) {
      compared.set(left, new WeakSet([right]));
    } else if (seenAgainst.has(right)) {
      return;
    } else {
      seenAgainst.add(right);
    }

    if (
      left.type !== undefined && right.type !== undefined &&
      !sameScalar(left.type, right.type)
    ) {
      reasons.push(`${describe(path)}: type changed`);
      return;
    }

    const leftEnum = enumValues(left);
    const rightEnum = enumValues(right);
    if (leftEnum !== undefined && rightEnum !== undefined) {
      const rightSet = new Set(rightEnum.map((value) => JSON.stringify(value)));
      const leftSet = new Set(leftEnum.map((value) => JSON.stringify(value)));
      const removed = [...leftSet].filter((value) => !rightSet.has(value));
      const added = [...rightSet].filter((value) => !leftSet.has(value));
      if (direction === "input" && removed.length > 0) {
        reasons.push(
          `${describe(path)}: input enumeration narrowed (${removed.join(", ")})`,
        );
      }
      if (direction === "output" && added.length > 0) {
        reasons.push(
          `${describe(path)}: output enumeration widened (${added.join(", ")})`,
        );
      }
    }

    compareConstraints(left, right, path);

    // Unions: line arms up positionally, and treat a shrinking output union
    // and a shrinking input union the same way an enumeration is treated.
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const leftArms = left[keyword];
      const rightArms = right[keyword];
      if (Array.isArray(leftArms) && Array.isArray(rightArms)) {
        if (direction === "input" && rightArms.length < leftArms.length) {
          reasons.push(`${describe(path)}: input union lost an alternative`);
        }
        if (direction === "output" && rightArms.length > leftArms.length) {
          reasons.push(`${describe(path)}: output union gained an alternative`);
        }
        const shared = Math.min(leftArms.length, rightArms.length);
        for (let index = 0; index < shared; index++) {
          compare(leftArms[index], rightArms[index], [
            ...path,
            `${keyword}[${index}]`,
          ]);
        }
      } else if (Array.isArray(leftArms) !== Array.isArray(rightArms)) {
        reasons.push(`${describe(path)}: ${keyword} appeared or disappeared`);
      }
    }

    // `allOf` arms are conjunctive, so its polarity is the opposite of a
    // union's: gaining an arm narrows what validates, losing one widens it.
    {
      const leftArms = left.allOf;
      const rightArms = right.allOf;
      if (Array.isArray(leftArms) && Array.isArray(rightArms)) {
        if (rightArms.length !== leftArms.length) {
          reportPolarity(
            path,
            "allOf",
            rightArms.length > leftArms.length ? "tightened" : "loosened",
          );
        }
        const shared = Math.min(leftArms.length, rightArms.length);
        for (let index = 0; index < shared; index++) {
          compare(leftArms[index], rightArms[index], [
            ...path,
            `allOf[${index}]`,
          ]);
        }
      } else if (Array.isArray(leftArms) !== Array.isArray(rightArms)) {
        reportPolarity(
          path,
          "allOf",
          Array.isArray(rightArms) ? "tightened" : "loosened",
        );
      }
    }

    if (isObject(left.items) || isObject(right.items)) {
      compare(left.items, right.items, [...path, "items"]);
    }

    const leftProperties = isObject(left.properties) ? left.properties : undefined;
    const rightProperties = isObject(right.properties)
      ? right.properties
      : undefined;
    if (leftProperties === undefined || rightProperties === undefined) return;

    const leftRequired = stringSet(left.required);
    const rightRequired = stringSet(right.required);

    for (const name of Object.keys(leftProperties)) {
      if (!Object.hasOwn(rightProperties, name)) {
        reasons.push(`${describe([...path, name])}: property removed`);
        continue;
      }
      if (direction === "input" && !leftRequired.has(name) && rightRequired.has(name)) {
        reasons.push(
          `${describe([...path, name])}: optional input property became required`,
        );
      }
      if (direction === "output" && leftRequired.has(name) && !rightRequired.has(name)) {
        reasons.push(
          `${describe([...path, name])}: guaranteed output property became optional`,
        );
      }
      compare(leftProperties[name], rightProperties[name], [...path, name]);
    }

    for (const name of Object.keys(rightProperties)) {
      if (Object.hasOwn(leftProperties, name)) continue;
      if (direction === "input" && rightRequired.has(name)) {
        reasons.push(
          `${describe([...path, name])}: new required input property`,
        );
      }
    }
  };

  compare(before, after, []);
  return reasons.length === 0
    ? { kind: "additive" }
    : { kind: "breaking", reasons: Object.freeze(reasons) };
};
