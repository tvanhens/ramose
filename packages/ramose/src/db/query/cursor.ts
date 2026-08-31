import { fromJson, toJson } from "../../internal/core/json.ts";
import { inspectPullField } from "../Pull.ts";
import {
  isCursor,
  isPipeline,
  lowerQueryObject,
  symbolicIdentityLowering,
  type AnyQueryObject,
  type Cursor,
  type Pipeline,
} from "./query.ts";

type CursorKeyKind =
  | "instant"
  | "bytes"
  | "uuid"
  | "number"
  | "string"
  | "boolean"
  | "unknown";

const kindOfValueType = (vt: unknown): CursorKeyKind => {
  switch (vt) {
    case "instant":
      return "instant";
    case "bytes":
      return "bytes";
    case "uuid":
      return "uuid";
    case "long":
    case "double":
    case "ref":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    default:
      return "unknown";
  }
};

const kindOfKey = (key: unknown, pipe: Pipeline | undefined): CursorKeyKind => {
  if (typeof key === "object" && key !== null && "valueType" in key) {
    return kindOfValueType((key as { valueType: unknown }).valueType);
  }
  if (typeof key === "string" && pipe !== undefined) {
    const select = [...pipe.stages].reverse().find((s) => s.kind === "select");
    if (select !== undefined && select.kind === "select") {
      const field = (select.shape as Record<string, unknown>)[key];
      if (field !== undefined) {
        const attr = inspectPullField(field).attr as { valueType?: unknown } | undefined;
        if (attr?.valueType !== undefined) return kindOfValueType(attr.valueType);
      }
    }
    const field = pipe.ns.fields[key] as { valueType?: unknown } | undefined;
    if (field?.valueType !== undefined) return kindOfValueType(field.valueType);
    if (key === "id") return "number";
  }
  return "unknown";
};

const pagedQuery = (q: AnyQueryObject): AnyQueryObject =>
  q.seek !== undefined ? q : q.after(null);

const cursorKeyCount = (q: AnyQueryObject): number => {
  const order = lowerQueryObject(
    pagedQuery(q),
    symbolicIdentityLowering().lowering,
  ).query.order as unknown[] | undefined;
  if (order === undefined || order.length === 0) {
    throw new Error(
      "ramose/query: encodeCursor / decodeCursor pages a sorted query — add an orderBy for the cursor to be a position in",
    );
  }
  return order.length;
};

const cursorKeyKinds = (q: AnyQueryObject): readonly CursorKeyKind[] => {
  const n = cursorKeyCount(q);
  const body = q.body();
  const pipe = isPipeline(body) ? body : undefined;
  const kinds: CursorKeyKind[] = [];
  if (pipe !== undefined) {
    for (const st of pipe.stages) {
      if (st.kind === "orderBy") kinds.push(kindOfKey(st.key, pipe));
    }
  }
  for (const o of q.orders) kinds.push(kindOfKey(o.key, pipe));
  while (kinds.length < n) kinds.push("number");
  return kinds.slice(0, n);
};

const retypeKey = (value: unknown, kind: CursorKeyKind): unknown => {
  switch (kind) {
    case "instant": {
      if (value instanceof Date) return value;
      if (typeof value === "number") return new Date(value);
      if (typeof value === "string") {
        const ms = Date.parse(value);
        if (Number.isNaN(ms)) {
          throw new Error("ramose/query: decodeCursor could not read this cursor");
        }
        return new Date(ms);
      }
      return value;
    }
    case "bytes":
      return value instanceof Uint8Array ? value : value;
    default:
      return value;
  }
};

const b64urlEncode = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const b64urlDecode = (s: string): string => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

const CURSOR_PREFIX = "r1.";

/**
 * Pack a page cursor for a URL. The string is opaque; only
 * {@link decodeCursor} against the same query rehydrates Instant / bytes.
 */
export const encodeCursor = (q: AnyQueryObject, cursor: Cursor): string => {
  if (!isCursor(cursor)) {
    throw new Error("ramose/query: encodeCursor takes a Cursor");
  }
  const n = cursorKeyCount(q);
  if (cursor.keys.length !== n) {
    throw new Error(
      `ramose/query: this cursor does not fit — it carries ${cursor.keys.length} sort-key values and the query orders by ${n}; a cursor only continues the query that minted it`,
    );
  }
  return CURSOR_PREFIX + b64urlEncode(JSON.stringify(toJson(cursor.keys)));
};

/**
 * Rehydrate a string {@link encodeCursor} produced. Instant keys come back
 * as `Date`; a JSON-stringified ISO instant is re-typed from the query's
 * sort keys, not left as a string.
 */
export const decodeCursor = (q: AnyQueryObject, encoded: string): Cursor => {
  if (typeof encoded !== "string" || !encoded.startsWith(CURSOR_PREFIX)) {
    throw new Error("ramose/query: decodeCursor takes the string encodeCursor produced");
  }
  let raw: unknown;
  try {
    raw = fromJson(JSON.parse(b64urlDecode(encoded.slice(CURSOR_PREFIX.length))));
  } catch {
    throw new Error("ramose/query: decodeCursor could not read this cursor");
  }
  if (!Array.isArray(raw)) {
    throw new Error("ramose/query: decodeCursor could not read this cursor");
  }
  const n = cursorKeyCount(q);
  if (raw.length !== n) {
    throw new Error(
      `ramose/query: this cursor does not fit — it carries ${raw.length} sort-key values and the query orders by ${n}; a cursor only continues the query that minted it`,
    );
  }
  const kinds = cursorKeyKinds(q);
  return { _tag: "Cursor", keys: raw.map((k, i) => retypeKey(k, kinds[i] ?? "unknown")) };
};
