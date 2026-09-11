import { makeCompositionIndex, type CompositionSnapshot } from "./composition.ts";
import { Connection, type ConnectionOptions } from "./conn.ts";
import { Index, type Datom } from "./datom.ts";
import type { Roots } from "./db.ts";
import type { NodeStore } from "./tree.ts";

export type DatabaseRevision = {
  readonly version: 1;
  readonly composition: CompositionSnapshot | null;
  readonly catalog: { readonly key: string; readonly unitHash: string } | null;
  readonly roots: Roots;
  readonly tail: readonly Datom[];
  readonly nextEntityId: number;
};

export const captureRevision = (connection: Connection, catalog: DatabaseRevision["catalog"] = null): DatabaseRevision => {
  const db = connection.db();
  return { version: 1, composition: db.composition?.snapshot ?? null, catalog, roots: db.roots, tail: db.novelty.byIndex[Index.EAVT].all(), nextEntityId: db.nextEid };
};

export const restoreRevision = (store: NodeStore, revision: DatabaseRevision, options: Omit<ConnectionOptions, "composition" | "store"> = {}): Promise<Connection> => {
  if (revision.version !== 1) throw new Error("unsupported database revision version");
  return Connection.restore(store, revision.roots, revision.tail, revision.nextEntityId, { ...options, ...(revision.composition === null ? {} : { composition: makeCompositionIndex(revision.composition) }) });
};
