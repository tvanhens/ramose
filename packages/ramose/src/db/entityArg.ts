import { isAttrRef } from "./attrRef.ts";

declare const TempidBrand: unique symbol;

/**
 * A named tempid. Not a bare `string` — `add("oops-typo", …)` is a type
 * error. Produce one with {@link tempid} / `op.tempid` / `tx.tempid`.
 */
export type Tempid = string & { readonly [TempidBrand]: true };

/** Brand a string as a tempid. The wire form is the string itself. */
export const tempid = (name: string): Tempid => {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("ramose: tempid() needs a non-empty string");
  }
  return name as Tempid;
};

export const asLookupRef = (
  value: unknown,
): readonly [string, unknown] | undefined => {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const head = value[0];
  const ident =
    typeof head === "string"
      ? head
      : isAttrRef(head)
        ? head.ident
        : typeof head === "object" &&
            head !== null &&
            "ident" in head &&
            typeof (head as { ident: unknown }).ident === "string"
          ? (head as { ident: string }).ident
          : undefined;
  if (ident === undefined || ident[0] !== ":") return undefined;
  return [ident, value[1]];
};

const isTxHandleLike = (e: unknown): e is { readonly eid: unknown } =>
  typeof e === "object" &&
  e !== null &&
  (e as { _tag?: unknown })._tag === "TxHandle";

const isIdRow = (v: unknown): v is { readonly id: number } =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  "id" in v &&
  typeof (v as { id: unknown }).id === "number" &&
  !isTxHandleLike(v);

const isPrincipal = (
  v: unknown,
): v is { readonly eid: number | null; readonly class: string } =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  "eid" in v &&
  "class" in v &&
  typeof (v as { class: unknown }).class === "string" &&
  ((v as { eid: unknown }).eid === null ||
    typeof (v as { eid: unknown }).eid === "number") &&
  !isTxHandleLike(v);

export const lowerEntityArg = (entity: unknown): unknown => {
  if (entity === undefined || entity === null) return entity;
  if (typeof entity === "number" || typeof entity === "string") return entity;
  const lookup = asLookupRef(entity);
  if (lookup !== undefined) return lookup;
  if (isTxHandleLike(entity)) return lowerEntityArg(entity.eid);
  if (isIdRow(entity)) return entity.id;
  if (isPrincipal(entity)) return entity.eid === null ? undefined : entity.eid;
  return entity;
};

const isIdentLookup = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === "string" &&
  value[0][0] === ":";

export const lowerWriteValue = (value: unknown): unknown => {
  if (Array.isArray(value) && !isIdentLookup(value) && asLookupRef(value) === undefined) {
    return value.map(lowerWriteValue);
  }
  return lowerEntityArg(value);
};
