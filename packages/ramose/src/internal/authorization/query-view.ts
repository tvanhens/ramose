import type { Db } from "../core/db.ts";
import { query } from "../core/query/engine.ts";
import { fromJson } from "../core/json.ts";

export type QueryViewResult = { readonly result: unknown; readonly entities: readonly number[] };

export const readQueryView = async (db: Db, raw: Record<string, unknown>, maxCells: number): Promise<QueryViewResult> => {
  const entities: number[] = [];
  const mapped = new Map<number, number>();
  const result = await query(db, fromJson(raw) as object, [], { maxCells, reference: (eid) => {
    let index = mapped.get(eid);
    if (index === undefined) { entities.push(eid); index = entities.length; mapped.set(eid, index); }
    return index;
  } });
  return { result, entities };
};
