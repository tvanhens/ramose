/**
 * The v1 expression standard-library manifest (#507).
 *
 * This file is the single source of truth. Validation, capability cards,
 * `describe`, the documentation site, and — once #486 lands — compiler
 * dispatch all read it; none of them restate a signature of their own.
 *
 * The manifest is plain data with no function values in it, so a card is
 * JSON-projectable as written and cannot smuggle an implementation reference
 * to a caller. Implementations live in `./implementations.ts` and are joined
 * to these cards by public name in `./registry.ts`.
 *
 * What is deliberately absent, and stays absent in v1: `now`, `rand`, any
 * clock or randomness, caller-supplied regular expressions, lambdas and
 * higher-order functions, recursion, environment/filesystem/network access,
 * database- or catalog-aware functions, and any function that produces query
 * rows. A function may *return* a collection as one value; it can never fan
 * one row out into several.
 *
 * Two commitments run through the `text.*` cards and are stated once here.
 * Case mapping is ASCII only and whitespace is a pinned set, because the
 * host's Unicode tables move with the engine's Unicode version and a v1
 * document must mean the same thing wherever it runs; a wider mapping can
 * arrive later under its own name. And text is well-formed Unicode: a string
 * carrying an unpaired surrogate is outside the value domain, which is what
 * makes the code-point indices in `length`, `slice` and `indexOf` total.
 */

import type {
  ExpressionContext,
  FunctionCard,
  StdlibManifest,
} from "./types.ts";
import { QUERY_STDLIB_VERSION } from "./types.ts";
import { MAX_PRODUCED_TEXT_UNITS } from "./values.ts";

/**
 * Admitted everywhere an expression is admitted. Only for calls whose
 * declared result type is totally ordered, so the value can be a sort key.
 */
const ANY_CONTEXT: readonly ExpressionContext[] = ["let", "where", "select", "orderBy"];

/**
 * Everywhere except `orderBy`. Collections have no total order, so a call
 * that can yield one is rejected as a sort key at validation time rather than
 * producing an arbitrary ordering at execution time.
 *
 * This covers two cases, not one. A call declaring `collection` obviously
 * qualifies. So does a call declaring `any`, because `any` cannot statically
 * exclude a collection — `logic.coalesce(null, [])` and `collection.first`
 * over a collection of collections both return one. Keeping them out now is
 * the two-way door: admitting a context later is additive, withdrawing a
 * published one is a language break.
 */
const NOT_ORDER_BY: readonly ExpressionContext[] = ["let", "where", "select"];

const functions: readonly FunctionCard[] = [
  // ── logic ────────────────────────────────────────────────────────────────
  {
    name: "logic.and",
    namespace: "logic",
    signature: {
      parameters: [
        { name: "left", type: "boolean", doc: "First operand." },
        { name: "right", type: "boolean", doc: "Second operand." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "explicit",
    doc: "Three-valued conjunction: false wins over unknown, unknown wins over true.",
    examples: [
      { args: [true, true], result: true },
      { args: [false, null], result: false, note: "A known false decides the result." },
      { args: [true, null], result: null, note: "Otherwise unknown propagates." },
    ],
  },
  {
    name: "logic.or",
    namespace: "logic",
    signature: {
      parameters: [
        { name: "left", type: "boolean", doc: "First operand." },
        { name: "right", type: "boolean", doc: "Second operand." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "explicit",
    doc: "Three-valued disjunction: true wins over unknown, unknown wins over false.",
    examples: [
      { args: [false, true], result: true },
      { args: [true, null], result: true },
      { args: [false, null], result: null },
    ],
  },
  {
    name: "logic.not",
    namespace: "logic",
    signature: {
      parameters: [{ name: "value", type: "boolean", doc: "Operand to invert." }],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "explicit",
    doc: "Three-valued negation; unknown stays unknown.",
    examples: [
      { args: [true], result: false },
      { args: [null], result: null },
    ],
  },
  {
    name: "logic.eq",
    namespace: "logic",
    signature: {
      parameters: [
        { name: "left", type: "any", doc: "First value." },
        { name: "right", type: "any", doc: "Second value." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Structural equality over JSON values; use logic.isNull to test absence.",
    examples: [
      { args: ["open", "open"], result: true },
      { args: [[1, 2], [1, 2]], result: true, note: "Collections compare element-wise." },
      { args: [null, null], result: null, note: "Comparing an absent value is unknown." },
    ],
  },
  {
    name: "logic.ne",
    namespace: "logic",
    signature: {
      parameters: [
        { name: "left", type: "any", doc: "First value." },
        { name: "right", type: "any", doc: "Second value." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Structural inequality over JSON values.",
    examples: [
      { args: ["open", "closed"], result: true },
      { args: [1, 1], result: false },
    ],
  },
  {
    name: "logic.isNull",
    namespace: "logic",
    signature: {
      parameters: [{ name: "value", type: "any", doc: "Value to test." }],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "explicit",
    doc: "True when the value is absent; never returns unknown.",
    examples: [
      { args: [null], result: true },
      { args: [""], result: false, note: "Empty text is present, not absent." },
    ],
  },
  {
    name: "logic.coalesce",
    namespace: "logic",
    signature: {
      parameters: [
        { name: "value", type: "any", doc: "Preferred value." },
        { name: "fallback", type: "any", doc: "Used when the preferred value is absent." },
      ],
      result: "any",
    },
    contexts: NOT_ORDER_BY,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "explicit",
    doc: "Return the first value unless it is absent, then the fallback.",
    examples: [
      { args: [null, "unassigned"], result: "unassigned" },
      { args: ["ada", "unassigned"], result: "ada" },
    ],
  },
  {
    name: "logic.if",
    namespace: "logic",
    signature: {
      parameters: [
        { name: "condition", type: "boolean", doc: "Selector." },
        { name: "whenTrue", type: "any", doc: "Result when the condition is true." },
        {
          name: "whenFalse",
          type: "any",
          doc: "Result when the condition is false or unknown.",
        },
      ],
      result: "any",
    },
    contexts: NOT_ORDER_BY,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "explicit",
    doc: "Choose between two values; an unknown condition takes the false branch.",
    examples: [
      { args: [true, "yes", "no"], result: "yes" },
      { args: [null, "yes", "no"], result: "no" },
    ],
  },

  // ── number ───────────────────────────────────────────────────────────────
  {
    name: "number.add",
    namespace: "number",
    signature: {
      parameters: [
        { name: "left", type: "number", doc: "First addend." },
        { name: "right", type: "number", doc: "Second addend." },
      ],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Add two numbers; a result that is not finite is absent.",
    examples: [
      { args: [2, 3], result: 5 },
      { args: [1e308, 1e308], result: null, note: "Overflow is absent, not infinity." },
    ],
  },
  {
    name: "number.subtract",
    namespace: "number",
    signature: {
      parameters: [
        { name: "left", type: "number", doc: "Minuend." },
        { name: "right", type: "number", doc: "Subtrahend." },
      ],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Subtract the second number from the first.",
    examples: [{ args: [5, 3], result: 2 }],
  },
  {
    name: "number.multiply",
    namespace: "number",
    signature: {
      parameters: [
        { name: "left", type: "number", doc: "First factor." },
        { name: "right", type: "number", doc: "Second factor." },
      ],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Multiply two numbers; a result that is not finite is absent.",
    examples: [
      { args: [4, 2.5], result: 10 },
      { args: [1e308, 10], result: null },
    ],
  },
  {
    name: "number.divide",
    namespace: "number",
    signature: {
      parameters: [
        { name: "dividend", type: "number", doc: "Value to divide." },
        { name: "divisor", type: "number", doc: "Value to divide by." },
      ],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Divide two numbers; dividing by zero is absent rather than an error.",
    examples: [
      { args: [7, 2], result: 3.5 },
      { args: [1, 0], result: null },
    ],
  },
  {
    name: "number.abs",
    namespace: "number",
    signature: {
      parameters: [{ name: "value", type: "number", doc: "Value." }],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Absolute value.",
    examples: [{ args: [-3.5], result: 3.5 }],
  },
  {
    name: "number.negate",
    namespace: "number",
    signature: {
      parameters: [{ name: "value", type: "number", doc: "Value." }],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Arithmetic negation.",
    examples: [{ args: [3], result: -3 }],
  },
  {
    name: "number.min",
    namespace: "number",
    signature: {
      parameters: [
        { name: "left", type: "number", doc: "First value." },
        { name: "right", type: "number", doc: "Second value." },
      ],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "The smaller of two numbers.",
    examples: [{ args: [3, 8], result: 3 }],
  },
  {
    name: "number.max",
    namespace: "number",
    signature: {
      parameters: [
        { name: "left", type: "number", doc: "First value." },
        { name: "right", type: "number", doc: "Second value." },
      ],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "The larger of two numbers.",
    examples: [{ args: [3, 8], result: 8 }],
  },
  {
    name: "number.round",
    namespace: "number",
    signature: {
      parameters: [{ name: "value", type: "number", doc: "Value to round." }],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Round to the nearest integer, halves away from zero.",
    examples: [
      { args: [2.5], result: 3 },
      { args: [-2.5], result: -3, note: "Symmetric, unlike host rounding." },
    ],
  },
  {
    name: "number.floor",
    namespace: "number",
    signature: {
      parameters: [{ name: "value", type: "number", doc: "Value." }],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Largest integer less than or equal to the value.",
    examples: [{ args: [-1.2], result: -2 }],
  },
  {
    name: "number.ceil",
    namespace: "number",
    signature: {
      parameters: [{ name: "value", type: "number", doc: "Value." }],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Smallest integer greater than or equal to the value.",
    examples: [{ args: [-1.2], result: -1 }],
  },
  {
    name: "number.gt",
    namespace: "number",
    signature: {
      parameters: [
        { name: "left", type: "number", doc: "First value." },
        { name: "right", type: "number", doc: "Second value." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Strictly greater than.",
    examples: [{ args: [3, 2], result: true }],
  },
  {
    name: "number.gte",
    namespace: "number",
    signature: {
      parameters: [
        { name: "left", type: "number", doc: "First value." },
        { name: "right", type: "number", doc: "Second value." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Greater than or equal to.",
    examples: [{ args: [3, 3], result: true }],
  },
  {
    name: "number.lt",
    namespace: "number",
    signature: {
      parameters: [
        { name: "left", type: "number", doc: "First value." },
        { name: "right", type: "number", doc: "Second value." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Strictly less than.",
    examples: [{ args: [2, 3], result: true }],
  },
  {
    name: "number.lte",
    namespace: "number",
    signature: {
      parameters: [
        { name: "left", type: "number", doc: "First value." },
        { name: "right", type: "number", doc: "Second value." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Less than or equal to.",
    examples: [{ args: [3, 3], result: true }],
  },
  {
    name: "number.toText",
    namespace: "number",
    signature: {
      parameters: [{ name: "value", type: "number", doc: "Number to render." }],
      result: "text",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Render a number in its canonical JSON text form.",
    examples: [
      { args: [3.5], result: "3.5" },
      { args: [1000000], result: "1000000" },
    ],
  },
  {
    name: "number.parse",
    namespace: "number",
    signature: {
      parameters: [{ name: "value", type: "text", doc: "Text in JSON number form." }],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Parse strict JSON number text; anything else is absent.",
    examples: [
      { args: ["-12.5e2"], result: -1250 },
      { args: [" 12 "], result: null, note: "No surrounding space, no loose forms." },
      { args: ["0x10"], result: null },
    ],
  },

  // ── text ─────────────────────────────────────────────────────────────────
  {
    name: "text.lower",
    namespace: "text",
    signature: {
      parameters: [{ name: "value", type: "text", doc: "Text to fold." }],
      result: "text",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Lowercase the ASCII letters A-Z; every other character is unchanged.",
    examples: [
      { args: ["Refund"], result: "refund" },
      {
        args: ["ÄÖÜ"],
        result: "ÄÖÜ",
        note: "Case mapping is ASCII only, so it cannot drift with a Unicode version.",
      },
    ],
  },
  {
    name: "text.upper",
    namespace: "text",
    signature: {
      parameters: [{ name: "value", type: "text", doc: "Text to fold." }],
      result: "text",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Uppercase the ASCII letters a-z; every other character is unchanged.",
    examples: [
      { args: ["refund"], result: "REFUND" },
      { args: ["straße"], result: "STRAßE", note: "Non-ASCII characters pass through." },
    ],
  },
  {
    name: "text.trim",
    namespace: "text",
    signature: {
      parameters: [{ name: "value", type: "text", doc: "Text to trim." }],
      result: "text",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Remove leading and trailing whitespace from a pinned character set.",
    examples: [
      { args: ["  hi \n"], result: "hi" },
      { args: [" hi　"], result: "hi", note: "The set is fixed, not the host's." },
      { args: ["   "], result: "", note: "All-whitespace text trims to empty, not absent." },
    ],
  },
  {
    name: "text.length",
    namespace: "text",
    signature: {
      parameters: [{ name: "value", type: "text", doc: "Text to measure." }],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Length in Unicode code points.",
    examples: [
      { args: ["abc"], result: 3 },
      { args: ["\u{1F600}"], result: 1, note: "An astral character counts once." },
      { args: [""], result: 0 },
    ],
  },
  {
    name: "text.concat",
    namespace: "text",
    signature: {
      parameters: [
        { name: "left", type: "text", doc: "First part." },
        { name: "right", type: "text", doc: "Second part." },
      ],
      result: "text",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Join two pieces of text end to end.",
    examples: [{ args: ["re", "fund"], result: "refund" }],
    outputLimit: MAX_PRODUCED_TEXT_UNITS,
  },
  {
    name: "text.contains",
    namespace: "text",
    signature: {
      parameters: [
        { name: "value", type: "text", doc: "Text to search." },
        { name: "needle", type: "text", doc: "Literal substring to find." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Literal substring test; there is no caller-supplied pattern syntax.",
    examples: [
      { args: ["refund issued", "fund"], result: true },
      { args: ["refund", ""], result: true, note: "Empty text is contained everywhere." },
    ],
  },
  {
    name: "text.startsWith",
    namespace: "text",
    signature: {
      parameters: [
        { name: "value", type: "text", doc: "Text to test." },
        { name: "prefix", type: "text", doc: "Literal prefix." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Literal prefix test.",
    examples: [{ args: ["refund", "re"], result: true }],
  },
  {
    name: "text.endsWith",
    namespace: "text",
    signature: {
      parameters: [
        { name: "value", type: "text", doc: "Text to test." },
        { name: "suffix", type: "text", doc: "Literal suffix." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Literal suffix test.",
    examples: [{ args: ["refund", "und"], result: true }],
  },
  {
    name: "text.equalsIgnoreCase",
    namespace: "text",
    signature: {
      parameters: [
        { name: "left", type: "text", doc: "First text." },
        { name: "right", type: "text", doc: "Second text." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Exact match ignoring ASCII letter case only; logic.eq is the exact one.",
    examples: [
      { args: ["Refund", "REFUND"], result: true },
      { args: ["Ä", "ä"], result: false, note: "Only A-Z and a-z fold." },
    ],
  },
  {
    name: "text.compare",
    namespace: "text",
    signature: {
      parameters: [
        { name: "left", type: "text", doc: "First text." },
        { name: "right", type: "text", doc: "Second text." },
      ],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Compare in code-unit order: -1, 0, or 1. Not a locale collation.",
    // Code-unit order is fixed by the language, not by a Unicode table, so
    // this ordering is the same on every engine and every version of one.
    examples: [
      { args: ["a", "b"], result: -1 },
      { args: ["b", "a"], result: 1 },
      { args: ["a", "a"], result: 0 },
    ],
  },
  {
    name: "text.slice",
    namespace: "text",
    signature: {
      parameters: [
        { name: "value", type: "text", doc: "Text to cut." },
        { name: "start", type: "number", doc: "Inclusive code-point start, clamped." },
        { name: "end", type: "number", doc: "Exclusive code-point end, clamped." },
      ],
      result: "text",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Code-point substring; indices clamp, and a reversed range is empty.",
    examples: [
      { args: ["refund", 0, 2], result: "re" },
      { args: ["refund", -5, 99], result: "refund", note: "Indices clamp; no wrap-around." },
      { args: ["refund", 4, 2], result: "" },
    ],
  },
  {
    name: "text.indexOf",
    namespace: "text",
    signature: {
      parameters: [
        { name: "value", type: "text", doc: "Text to search." },
        { name: "needle", type: "text", doc: "Literal substring to find." },
      ],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "First code-point index of a literal substring, or -1.",
    examples: [
      { args: ["refund", "fund"], result: 2 },
      { args: ["refund", "zz"], result: -1 },
      { args: ["refund", ""], result: 0 },
    ],
  },
  {
    name: "text.replace",
    namespace: "text",
    signature: {
      parameters: [
        { name: "value", type: "text", doc: "Text to rewrite." },
        { name: "search", type: "text", doc: "Literal text to replace." },
        { name: "replacement", type: "text", doc: "Literal replacement text." },
      ],
      result: "text",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Replace every occurrence literally; an empty search changes nothing.",
    examples: [
      { args: ["a-b-c", "-", "+"], result: "a+b+c" },
      { args: ["ab", "", "!"], result: "ab" },
      { args: ["ab", "a", "$&"], result: "$&b", note: "Replacement text is literal." },
    ],
    outputLimit: MAX_PRODUCED_TEXT_UNITS,
  },
  {
    name: "text.split",
    namespace: "text",
    signature: {
      parameters: [
        { name: "value", type: "text", doc: "Text to split." },
        { name: "separator", type: "text", doc: "Literal separator." },
      ],
      result: "collection",
    },
    contexts: NOT_ORDER_BY,
    deterministic: true,
    cardinality: "collection",
    cost: "linear",
    nulls: "propagate",
    doc: "Split on a literal separator into one collection value, never into rows.",
    examples: [
      { args: ["a,b,c", ","], result: ["a", "b", "c"] },
      { args: ["abc", ""], result: ["abc"], note: "An empty separator does not fan out." },
    ],
  },
  {
    name: "text.join",
    namespace: "text",
    signature: {
      parameters: [
        { name: "value", type: "collection", doc: "Collection of text." },
        { name: "separator", type: "text", doc: "Literal separator." },
      ],
      result: "text",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "propagate",
    doc: "Join a collection of text; absent when any element is not well-formed text.",
    examples: [
      { args: [["a", "b"], "-"], result: "a-b" },
      { args: [[], "-"], result: "" },
      { args: [["a", 1], "-"], result: null },
    ],
    outputLimit: MAX_PRODUCED_TEXT_UNITS,
  },

  // ── collection ───────────────────────────────────────────────────────────
  {
    name: "collection.size",
    namespace: "collection",
    signature: {
      parameters: [{ name: "value", type: "collection", doc: "Collection to measure." }],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Number of elements.",
    examples: [
      { args: [[1, 2, 3]], result: 3 },
      { args: [[]], result: 0 },
    ],
  },
  {
    name: "collection.isEmpty",
    namespace: "collection",
    signature: {
      parameters: [{ name: "value", type: "collection", doc: "Collection to test." }],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "True when the collection has no elements.",
    examples: [
      { args: [[]], result: true },
      { args: [[null]], result: false, note: "One absent element is still an element." },
    ],
  },
  {
    name: "collection.contains",
    namespace: "collection",
    signature: {
      parameters: [
        { name: "value", type: "collection", doc: "Collection to search." },
        { name: "item", type: "any", doc: "Value to look for." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "linear",
    nulls: "explicit",
    doc: "Membership by structural equality; searching for an absent value is allowed.",
    examples: [
      { args: [["a", "b"], "b"], result: true },
      { args: [[null], null], result: true },
      { args: [null, "b"], result: null, note: "An absent collection gives an absent answer." },
    ],
  },
  {
    name: "collection.first",
    namespace: "collection",
    signature: {
      parameters: [{ name: "value", type: "collection", doc: "Collection." }],
      result: "any",
    },
    contexts: NOT_ORDER_BY,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "First element, or absent when the collection is empty.",
    examples: [
      { args: [["a", "b"]], result: "a" },
      { args: [[]], result: null },
    ],
  },
  {
    name: "collection.last",
    namespace: "collection",
    signature: {
      parameters: [{ name: "value", type: "collection", doc: "Collection." }],
      result: "any",
    },
    contexts: NOT_ORDER_BY,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Last element, or absent when the collection is empty.",
    examples: [
      { args: [["a", "b"]], result: "b" },
      { args: [[]], result: null },
    ],
  },
  {
    name: "collection.at",
    namespace: "collection",
    signature: {
      parameters: [
        { name: "value", type: "collection", doc: "Collection." },
        { name: "index", type: "number", doc: "Zero-based index." },
      ],
      result: "any",
    },
    contexts: NOT_ORDER_BY,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Element at a zero-based index; out of range or non-integer is absent.",
    examples: [
      { args: [["a", "b"], 1], result: "b" },
      { args: [["a", "b"], -1], result: null, note: "Negative does not mean from the end." },
      { args: [["a", "b"], 5], result: null },
    ],
  },
  {
    name: "collection.distinct",
    namespace: "collection",
    signature: {
      parameters: [{ name: "value", type: "collection", doc: "Collection to deduplicate." }],
      result: "collection",
    },
    contexts: NOT_ORDER_BY,
    deterministic: true,
    cardinality: "collection",
    cost: "linear",
    nulls: "propagate",
    doc: "Remove structural duplicates, keeping first-occurrence order.",
    examples: [
      { args: [["b", "a", "b"]], result: ["b", "a"] },
      { args: [[[1], [1], [2]]], result: [[1], [2]] },
    ],
  },
  {
    name: "collection.slice",
    namespace: "collection",
    signature: {
      parameters: [
        { name: "value", type: "collection", doc: "Collection to cut." },
        { name: "start", type: "number", doc: "Inclusive start index, clamped." },
        { name: "end", type: "number", doc: "Exclusive end index, clamped." },
      ],
      result: "collection",
    },
    contexts: NOT_ORDER_BY,
    deterministic: true,
    cardinality: "collection",
    cost: "linear",
    nulls: "propagate",
    doc: "Contiguous sub-collection; indices clamp and a reversed range is empty.",
    examples: [
      { args: [["a", "b", "c"], 1, 3], result: ["b", "c"] },
      { args: [["a", "b", "c"], -4, 99], result: ["a", "b", "c"] },
      { args: [["a", "b", "c"], 2, 1], result: [] },
    ],
  },
  {
    name: "collection.concat",
    namespace: "collection",
    signature: {
      parameters: [
        { name: "left", type: "collection", doc: "First collection." },
        { name: "right", type: "collection", doc: "Second collection." },
      ],
      result: "collection",
    },
    contexts: NOT_ORDER_BY,
    deterministic: true,
    cardinality: "collection",
    cost: "linear",
    nulls: "propagate",
    doc: "Append one collection to another as a single value.",
    examples: [{ args: [["a"], ["b"]], result: ["a", "b"] }],
  },

  // ── time ─────────────────────────────────────────────────────────────────
  {
    name: "time.before",
    namespace: "time",
    signature: {
      parameters: [
        { name: "left", type: "timestamp", doc: "Instant in epoch milliseconds." },
        { name: "right", type: "timestamp", doc: "Instant in epoch milliseconds." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "True when the first instant is strictly earlier. Both must be supplied.",
    examples: [
      { args: [1000, 2000], result: true },
      { args: [2000, 2000], result: false },
    ],
  },
  {
    name: "time.after",
    namespace: "time",
    signature: {
      parameters: [
        { name: "left", type: "timestamp", doc: "Instant in epoch milliseconds." },
        { name: "right", type: "timestamp", doc: "Instant in epoch milliseconds." },
      ],
      result: "boolean",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "True when the first instant is strictly later. Both must be supplied.",
    examples: [{ args: [2000, 1000], result: true }],
  },
  {
    name: "time.addMillis",
    namespace: "time",
    signature: {
      parameters: [
        { name: "instant", type: "timestamp", doc: "Instant in epoch milliseconds." },
        { name: "millis", type: "number", doc: "Whole milliseconds to add; may be negative." },
      ],
      result: "timestamp",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Shift an instant by whole milliseconds; leaving the instant range is absent.",
    examples: [
      { args: [1000, -250], result: 750 },
      { args: [0, 0.5], result: null, note: "Fractional milliseconds are absent." },
      { args: [0, 8_640_000_000_000_001], result: null },
    ],
  },
  {
    name: "time.diffMillis",
    namespace: "time",
    signature: {
      parameters: [
        { name: "from", type: "timestamp", doc: "Earlier instant." },
        { name: "to", type: "timestamp", doc: "Later instant." },
      ],
      result: "number",
    },
    contexts: ANY_CONTEXT,
    deterministic: true,
    cardinality: "one",
    cost: "constant",
    nulls: "propagate",
    doc: "Milliseconds from the first instant to the second; negative when reversed.",
    examples: [
      { args: [1000, 2500], result: 1500 },
      { args: [2500, 1000], result: -1500 },
    ],
  },
];

/** The v1 manifest. Additive growth only; never edit a published entry. */
export const standardLibraryManifestV1: StdlibManifest = {
  version: QUERY_STDLIB_VERSION,
  functions,
};
