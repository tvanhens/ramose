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
// Keyword dispositions
// ---------------------------------------------------------------------------
//
// A constraint keyword either tightens what a schema accepts or loosens it,
// and which of those is safe depends only on the direction. Tightening an
// input rejects requests that used to work; loosening an output produces
// values a client's older schema will reject. Both are breaks, and they are
// mirror images — which is why one table serves both directions.
//
// The table below is exhaustive by construction, and that is the point. Every
// keyword gets a disposition, every disposition handles a keyword being
// present on one side only, and "absent" always means "unconstrained". A
// keyword that appears where there was no constraint is a tightening; one that
// disappears is a loosening. Handling that uniformly is what stops the
// one-sided-presence family of bugs from having to be rediscovered per
// keyword — and `RECOGNIZED_SCHEMA_KEYWORDS` is checked against everything the
// generator actually emits, so a new keyword cannot arrive unclassified.

/** How one keyword's contribution to compatibility is decided. */
export type KeywordDispositionV1 =
  /** Documentation. Never part of a compatibility decision. */
  | "annotation"
  /** A pointer, resolved before anything is compared. */
  | "reference"
  /** The `type` keyword. Absent means any type. */
  | "type"
  /** `enum` / `const`: an allowed-value set. Absent means any value. */
  | "enumeration"
  /** The `required` name set. Absent means nothing is required. */
  | "required"
  /** Raising it tightens. Absent means unbounded below. */
  | "lowerBound"
  /** Lowering it tightens. Absent means unbounded above. */
  | "upperBound"
  /** Turning it on tightens. Absent means off. */
  | "tighteningFlag"
  /** Boolean-or-schema openness. Absent means open. */
  | "openness"
  /** One nested schema. Absent means unconstrained. */
  | "subschema"
  /** `anyOf` / `oneOf`: more arms is looser. Absent means unconstrained. */
  | "disjunction"
  /** `allOf`: more arms is tighter. Absent means unconstrained. */
  | "conjunction"
  /** The `properties` map. Absent means no members are described. */
  | "propertyMap"
  /** Recognized, but two values of it have no decidable ordering. */
  | "unorderable";

/**
 * Every JSON Schema 2020-12 keyword this classifier knows, and how it decides.
 *
 * A keyword missing from this table is not assumed harmless: it is reported on
 * any change, including appearing or disappearing. The sweep test walks the
 * published schemas and asserts every keyword they actually use is listed here,
 * so the generator cannot introduce one that silently falls through.
 */
export const SCHEMA_KEYWORD_DISPOSITIONS: Readonly<
  Record<string, KeywordDispositionV1>
> = Object.freeze({
  // Documentation and identity.
  $schema: "annotation",
  $id: "annotation",
  $anchor: "annotation",
  $dynamicAnchor: "annotation",
  $vocabulary: "annotation",
  $comment: "annotation",
  $defs: "annotation",
  definitions: "annotation",
  title: "annotation",
  description: "annotation",
  examples: "annotation",
  default: "annotation",
  deprecated: "annotation",
  readOnly: "annotation",
  writeOnly: "annotation",

  // Pointers.
  $ref: "reference",
  $dynamicRef: "reference",

  // Value constraints.
  type: "type",
  enum: "enumeration",
  const: "enumeration",
  required: "required",
  minLength: "lowerBound",
  minItems: "lowerBound",
  minProperties: "lowerBound",
  minimum: "lowerBound",
  exclusiveMinimum: "lowerBound",
  minContains: "lowerBound",
  maxLength: "upperBound",
  maxItems: "upperBound",
  maxProperties: "upperBound",
  maximum: "upperBound",
  exclusiveMaximum: "upperBound",
  maxContains: "upperBound",
  uniqueItems: "tighteningFlag",

  // Applicators.
  additionalProperties: "openness",
  unevaluatedProperties: "openness",
  additionalItems: "openness",
  unevaluatedItems: "openness",
  items: "subschema",
  contains: "subschema",
  propertyNames: "subschema",
  contentSchema: "subschema",
  anyOf: "disjunction",
  oneOf: "disjunction",
  allOf: "conjunction",
  properties: "propertyMap",

  // Recognized, but not orderable: two regular expressions have no decidable
  // subset relation, and neither do conditional or per-name applicators.
  pattern: "unorderable",
  format: "unorderable",
  multipleOf: "unorderable",
  contentEncoding: "unorderable",
  contentMediaType: "unorderable",
  patternProperties: "unorderable",
  dependentRequired: "unorderable",
  dependentSchemas: "unorderable",
  prefixItems: "unorderable",
  not: "unorderable",
  if: "unorderable",
  then: "unorderable",
  else: "unorderable",
});

/** Every keyword with an explicit disposition. See the sweep test. */
export const RECOGNIZED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set(
  Object.keys(SCHEMA_KEYWORD_DISPOSITIONS),
);

/**
 * `additionalProperties` and friends as a three-state openness. A schema value
 * sits between the two booleans and cannot be ordered against either. Absent
 * is open, which is what JSON Schema means by leaving it out.
 */
const openness = (value: unknown): "open" | "closed" | "constrained" => {
  if (value === undefined || value === true) return "open";
  if (value === false) return "closed";
  return "constrained";
};

const jsonSet = (values: readonly unknown[]): ReadonlySet<string> =>
  new Set(values.map((value) => JSON.stringify(value) ?? "null"));

/**
 * Decide whether moving from `before` to `after` is additive for the given
 * direction, or breaking — and if breaking, exactly why.
 *
 * Both arguments are self-contained JSON Schema 2020-12 roots, as
 * `json-schema.ts` produces. Comparison walks every keyword position and
 * follows local `$ref`s.
 *
 * It fails closed. Constraints are compared by polarity, a keyword appearing
 * or disappearing is treated as a change from or to "unconstrained", keywords
 * whose values cannot be ordered are reported on any change, and a keyword the
 * classifier does not recognize at all is reported on any change too. The
 * asymmetry is deliberate: a wrong "breaking" costs a reviewer an argument,
 * while a wrong "additive" ships a silent break to every client already
 * depending on the old shape — so nothing unrecognized is ever taken as
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
    detail?: string,
  ): void => {
    const breaks = direction === "input"
      ? change === "tightened"
      : change === "loosened";
    if (breaks) {
      reasons.push(
        `${describe(path)}: ${direction} ${keyword} ${change}${
          detail === undefined ? "" : ` (${detail})`
        }`,
      );
    }
  };

  /** Neither side can be ordered against the other: refuse in both directions. */
  const reportUndecidable = (
    path: readonly string[],
    keyword: string,
    why: string,
  ): void => {
    reasons.push(`${describe(path)}: ${keyword} ${why}`);
  };

  /**
   * The shape shared by every keyword position: one side may be missing, and
   * missing always means unconstrained.
   *
   * Returns `true` when the caller still has two present values to compare.
   */
  const presence = (
    path: readonly string[],
    keyword: string,
    left: unknown,
    right: unknown,
  ): boolean => {
    if (left === undefined && right === undefined) return false;
    if (left === undefined) {
      reportPolarity(path, keyword, "tightened", "constraint added");
      return false;
    }
    if (right === undefined) {
      reportPolarity(path, keyword, "loosened", "constraint removed");
      return false;
    }
    return true;
  };

  const compareType = (
    left: SchemaNode,
    right: SchemaNode,
    path: readonly string[],
  ): void => {
    if (sameScalar(left.type, right.type)) return;
    if (!presence(path, "type", left.type, right.type)) return;
    // Two concrete types: no ordering between them, so refuse both ways.
    reportUndecidable(path, "type", "changed between two types");
  };

  const compareEnumeration = (
    left: SchemaNode,
    right: SchemaNode,
    path: readonly string[],
  ): void => {
    const leftValues = enumValues(left);
    const rightValues = enumValues(right);
    if (!presence(path, "enum", leftValues, rightValues)) return;
    const leftSet = jsonSet(leftValues!);
    const rightSet = jsonSet(rightValues!);
    const removed = [...leftSet].filter((value) => !rightSet.has(value));
    const added = [...rightSet].filter((value) => !leftSet.has(value));
    // Fewer allowed values is a tightening; more is a loosening.
    if (removed.length > 0) {
      reportPolarity(path, "enum", "tightened", `dropped ${removed.join(", ")}`);
    }
    if (added.length > 0) {
      reportPolarity(path, "enum", "loosened", `added ${added.join(", ")}`);
    }
  };

  const compareRequired = (
    left: SchemaNode,
    right: SchemaNode,
    path: readonly string[],
  ): void => {
    const leftNames = stringSet(left.required);
    const rightNames = stringSet(right.required);
    const added = [...rightNames].filter((name) => !leftNames.has(name));
    const removed = [...leftNames].filter((name) => !rightNames.has(name));
    if (added.length > 0) {
      reportPolarity(
        path,
        "required",
        "tightened",
        `now requires ${added.join(", ")}`,
      );
    }
    if (removed.length > 0) {
      reportPolarity(
        path,
        "required",
        "loosened",
        `no longer guarantees ${removed.join(", ")}`,
      );
    }
  };

  const comparePropertyMap = (
    left: SchemaNode,
    right: SchemaNode,
    path: readonly string[],
  ): void => {
    // Absent means "no members described", so a vanished map removes them all.
    const leftMembers = isObject(left.properties) ? left.properties : {};
    const rightMembers = isObject(right.properties) ? right.properties : {};
    for (const name of Object.keys(leftMembers)) {
      if (!Object.hasOwn(rightMembers, name)) {
        // Fail closed: whether this tightens or loosens depends on the
        // surrounding openness, so it is refused in both directions.
        reasons.push(`${describe([...path, name])}: property removed`);
        continue;
      }
      compare(leftMembers[name], rightMembers[name], [...path, name]);
    }
    // A newly described member is additive on its own; `required` decides
    // whether the caller now has to send it.
  };

  const compareOpenness = (
    keyword: string,
    left: unknown,
    right: unknown,
    path: readonly string[],
  ): void => {
    const from = openness(left);
    const to = openness(right);
    if (from === to) {
      if (from === "constrained" && !sameScalar(left, right)) {
        compare(left, right, [...path, keyword]);
      }
      return;
    }
    if (from === "constrained" || to === "constrained") {
      reportUndecidable(path, keyword, "changed to or from a schema");
      return;
    }
    reportPolarity(path, keyword, to === "closed" ? "tightened" : "loosened");
  };

  const compareSubschema = (
    keyword: string,
    left: unknown,
    right: unknown,
    path: readonly string[],
  ): void => {
    if (sameScalar(left, right)) return;
    if (!presence(path, keyword, left, right)) return;
    if (isObject(left) && isObject(right)) {
      compare(left, right, [...path, keyword]);
      return;
    }
    // A boolean schema against an object schema, or two different booleans.
    reportUndecidable(path, keyword, "changed between incomparable schemas");
  };

  const compareArms = (
    keyword: string,
    conjunctive: boolean,
    left: unknown,
    right: unknown,
    path: readonly string[],
  ): void => {
    if (sameScalar(left, right)) return;
    if (!presence(path, keyword, left, right)) return;
    if (!Array.isArray(left) || !Array.isArray(right)) {
      reportUndecidable(path, keyword, "is not a list of schemas on both sides");
      return;
    }
    if (right.length !== left.length) {
      // Conjunctive arms narrow as they multiply; disjunctive arms widen.
      const grew = right.length > left.length;
      reportPolarity(
        path,
        keyword,
        (conjunctive ? grew : !grew) ? "tightened" : "loosened",
        `${left.length} arms became ${right.length}`,
      );
    }
    const shared = Math.min(left.length, right.length);
    for (let index = 0; index < shared; index++) {
      compare(left[index], right[index], [...path, `${keyword}[${index}]`]);
    }
  };

  /** Keywords compared as a group, because they interact. */
  const GROUPED: ReadonlySet<string> = new Set([
    "type",
    "enum",
    "const",
    "required",
    "properties",
  ]);

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

    compareType(left, right, path);
    compareEnumeration(left, right, path);
    compareRequired(left, right, path);
    comparePropertyMap(left, right, path);

    for (const keyword of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (GROUPED.has(keyword)) continue;
      const from = left[keyword];
      const to = right[keyword];
      const disposition = SCHEMA_KEYWORD_DISPOSITIONS[keyword];

      switch (disposition) {
        case "annotation":
        case "reference":
          // Documentation carries no contract, and pointers were resolved
          // before this node was reached.
          continue;

        case "openness":
          compareOpenness(keyword, from, to, path);
          continue;

        case "subschema":
          compareSubschema(keyword, from, to, path);
          continue;

        case "disjunction":
          compareArms(keyword, false, from, to, path);
          continue;

        case "conjunction":
          compareArms(keyword, true, from, to, path);
          continue;

        default:
          break;
      }

      if (sameScalar(from, to)) continue;

      if (disposition === "lowerBound" || disposition === "upperBound") {
        const lower = disposition === "lowerBound";
        const unconstrained = lower ? -Infinity : Infinity;
        const start = typeof from === "number" ? from : unconstrained;
        const end = typeof to === "number" ? to : unconstrained;
        if (start === end) continue;
        const raised = end > start;
        reportPolarity(
          path,
          keyword,
          (lower ? raised : !raised) ? "tightened" : "loosened",
        );
        continue;
      }

      if (disposition === "tighteningFlag") {
        reportPolarity(path, keyword, to === true ? "tightened" : "loosened");
        continue;
      }

      reportUndecidable(
        path,
        keyword,
        disposition === "unorderable"
          ? "changed, and no ordering between two values of it can be decided"
          : "is not a keyword this classifier recognizes, so any change to it is refused",
      );
    }
  };

  compare(before, after, []);
  return reasons.length === 0
    ? { kind: "additive" }
    : { kind: "breaking", reasons: Object.freeze(reasons) };
};
