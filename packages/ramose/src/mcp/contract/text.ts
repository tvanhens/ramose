/**
 * The derived text representation (#485).
 *
 * MCP requires every tool result to carry text `content`. Ramose's
 * authoritative result is `structuredContent`; the text exists so a client
 * that cannot read structured results still gets something useful.
 *
 * The danger with two representations is that they drift and start meaning
 * different things. This module removes that possibility by construction:
 * {@link renderResultText} takes the structured result and *only* the
 * structured result, canonicalizes it, and renders that canonical form. It
 * has no access to the request, the catalog, the receipt store, or anything
 * else — so it cannot say anything the structured result does not already
 * say, and every token it emits came from there.
 *
 * Determinism comes from the same place: the canonical form fixes member
 * order, so the same structured result always renders to the same text, on
 * any host, in any order the projection happened to build the object.
 *
 * The rendering is an indented outline rather than prose. Prose would require
 * choices — which fields matter, how to phrase them — and every one of those
 * choices is a place where the text could come to mean something the
 * structured result does not.
 */

import type { JsonValue } from "../../internal/authorization/json.ts";
import { canonicalizeContractJson } from "./serialization.ts";

/** Lines a rendered result may occupy before it is explicitly cut short. */
export const MAX_TEXT_LINES = 400;

/** Characters one rendered scalar may occupy before it is explicitly elided. */
export const MAX_TEXT_SCALAR_LENGTH = 512;

const INDENT = "  ";

const renderScalar = (value: JsonValue): string => {
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length > MAX_TEXT_SCALAR_LENGTH
      ? `${value.slice(0, MAX_TEXT_SCALAR_LENGTH)}… (elided, see structuredContent)`
      : value;
  }
  return String(value);
};

const isScalar = (value: JsonValue): boolean =>
  value === null || typeof value !== "object";

const isEmptyContainer = (value: JsonValue): boolean =>
  Array.isArray(value)
    ? value.length === 0
    : typeof value === "object" && value !== null &&
      Object.keys(value).length === 0;

const emptyMarker = (value: JsonValue): string =>
  Array.isArray(value) ? "[]" : "{}";

/**
 * Render one canonical JSON node as outline lines.
 *
 * Members arrive in canonical order, so nothing here chooses an ordering.
 */
const renderNode = (
  value: JsonValue,
  depth: number,
  lines: string[],
): void => {
  const pad = INDENT.repeat(depth);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${renderScalar(item)}`);
      } else if (isEmptyContainer(item)) {
        lines.push(`${pad}- ${emptyMarker(item)}`);
      } else {
        lines.push(`${pad}-`);
        renderNode(item, depth + 1, lines);
      }
    }
    return;
  }
  for (const [key, child] of Object.entries(value as { [k: string]: JsonValue })) {
    if (isScalar(child)) {
      lines.push(`${pad}${key}: ${renderScalar(child)}`);
    } else if (isEmptyContainer(child)) {
      lines.push(`${pad}${key}: ${emptyMarker(child)}`);
    } else {
      lines.push(`${pad}${key}:`);
      renderNode(child, depth + 1, lines);
    }
  }
};

/**
 * Render the compact text representation of one structured tool result.
 *
 * The result is a pure function of `structured`. Truncation, if it happens,
 * is stated on its own final line — the text never silently stops.
 */
export const renderResultText = (structured: JsonValue): string => {
  // Canonicalizing first is what makes this derivation total and ordered: a
  // value that is not canonical JSON has no text form either.
  const canonical = JSON.parse(canonicalizeContractJson(structured)) as JsonValue;
  const lines: string[] = [];
  if (isScalar(canonical)) {
    lines.push(renderScalar(canonical));
  } else if (isEmptyContainer(canonical)) {
    lines.push(emptyMarker(canonical));
  } else {
    renderNode(canonical, 0, lines);
  }
  if (lines.length > MAX_TEXT_LINES) {
    const kept = lines.slice(0, MAX_TEXT_LINES);
    kept.push(
      `… ${
        lines.length - MAX_TEXT_LINES
      } more lines omitted; structuredContent is complete`,
    );
    return kept.join("\n");
  }
  return lines.join("\n");
};

/**
 * The MCP text content block for one structured result.
 *
 * `isError` mirrors the result's own `ok` discriminator, so a recoverable
 * failure is a completed tool result flagged as an error — never a protocol
 * error, and never a success a client might mistake for one.
 */
export type ToolResultContentV1 = {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: JsonValue;
  readonly isError: boolean;
};

/**
 * Assemble the complete MCP tool result from the structured result alone.
 *
 * There is deliberately no way to pass separate text: if the text could be
 * supplied independently it could disagree, and then the contract would have
 * two answers.
 */
export const toolResult = (
  structured: JsonValue & { readonly ok?: unknown },
): ToolResultContentV1 =>
  Object.freeze({
    content: Object.freeze([
      Object.freeze({ type: "text" as const, text: renderResultText(structured) }),
    ]) as readonly [{ readonly type: "text"; readonly text: string }],
    structuredContent: structured,
    isError: structured.ok === false,
  });
