import { ValueTag } from "../datom.ts";

export class QueryReference {
  readonly vt = ValueTag.Ref;
  constructor(readonly v: number) {}
  valueOf(): number { return this.v; }
  toString(): string { return String(this.v); }
}

export const scalarValue = (value: unknown): unknown => value instanceof QueryReference ? value.v : value;

export const mapQueryReferences = (value: unknown, reference: (eid: number) => unknown): unknown => {
  if (value instanceof QueryReference) return reference(value.v);
  if (Array.isArray(value)) return value.map((cell) => mapQueryReferences(cell, reference));
  if (value === null || typeof value !== "object" || value instanceof Date || value instanceof Uint8Array) return value;
  return Object.fromEntries(Object.entries(value).map(([key, cell]) => [key, mapQueryReferences(cell, reference)]));
};
