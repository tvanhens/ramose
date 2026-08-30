/**
 * Stable serialization.
 *
 * One normalized document has exactly one byte sequence: document members
 * in the grammar's own order, expression nodes with their tag first,
 * projection keys in the order the caller wrote them (a projection is an
 * ordered row description), and plain JSON object values keyed in sorted
 * order. Two peers that normalize the same query serialize the same bytes,
 * which is what makes a document usable as a cache key, a live-query
 * identity, or a fixture.
 */

import type {
  ExpressionV1,
  NestedSelectionV1,
  NormalizedQueryDocumentV1,
  ProjectionV1,
  QueryJsonValue,
  SelectionV1,
} from "./types.ts";

const json = (value: QueryJsonValue): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
  const entries = Object.keys(value as Record<string, QueryJsonValue>).sort();
  return `{${entries
    .map((k) => `${JSON.stringify(k)}:${json((value as Record<string, QueryJsonValue>)[k]!)}`)
    .join(",")}}`;
};

const expression = (node: ExpressionV1): string => {
  if ("field" in node) return `{"field":${json([...node.field])}}`;
  if ("value" in node) return `{"value":${json(node.value)}}`;
  if ("param" in node) return `{"param":${JSON.stringify(node.param)}}`;
  if ("var" in node) return `{"var":${JSON.stringify(node.var)}}`;
  return `{"call":${JSON.stringify(node.call)},"args":[${node.args.map(expression).join(",")}]}`;
};

const isNested = (selection: SelectionV1): selection is NestedSelectionV1 =>
  Object.hasOwn(selection as object, "select");

const projection = (select: ProjectionV1): string => {
  const parts = Object.keys(select).map((key) => {
    const node = select[key]!;
    const body = isNested(node)
      ? `{"path":${json([...node.path])},"select":${projection(node.select)}}`
      : expression(node);
    return `${JSON.stringify(key)}:${body}`;
  });
  return `{${parts.join(",")}}`;
};

/** The canonical text of a normalized document. */
export const serializeQueryDocument = (document: NormalizedQueryDocumentV1): string => {
  const from =
    "entity" in document.from
      ? `{"entity":${JSON.stringify(document.from.entity)}}`
      : `{"trait":${JSON.stringify(document.from.trait)}}`;
  const params = json(document.params as QueryJsonValue);
  const bindings = document.let
    .map((b) => `{"as":${JSON.stringify(b.as)},"expr":${expression(b.expr)}}`)
    .join(",");
  const orderBy = document.orderBy
    .map(
      (o) =>
        `{"expr":${expression(o.expr)},"direction":${JSON.stringify(o.direction)},"empty":${JSON.stringify(o.empty)}}`,
    )
    .join(",");
  const page = `{"first":${json(document.page.first)},"after":${json(
    document.page.after,
  )},"offset":${json(document.page.offset)}}`;
  return [
    `{"version":${document.version}`,
    `"from":${from}`,
    `"params":${params}`,
    `"let":[${bindings}]`,
    `"where":${document.where === null ? "null" : expression(document.where)}`,
    `"select":${document.select === null ? "null" : projection(document.select)}`,
    `"orderBy":[${orderBy}]`,
    `"page":${page}`,
    `"cardinality":${JSON.stringify(document.cardinality)}}`,
  ].join(",");
};
