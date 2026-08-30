import type { AnySchema } from "./Schema.ts";
import type { AnyEntity } from "./Entity.ts";
import type { AnyComposer } from "./Composer.ts";

export type NamespaceEid<N extends AnyComposer> = number & {
  readonly _ns: N;
};

/**
 * The namespace-branded cells a catalog's rows can carry: `Eid<N>` for every
 * namespace in `C`. A `select({ id: N.id })` cell is a `db.pull` subject
 * with no cast; another catalog's cells stay out.
 */
export type SchemaEid<C extends AnySchema> = {
  [K in keyof C["entities"]]: NamespaceEid<C["entities"][K] & AnyEntity>;
}[keyof C["entities"]];

export type Eid<S extends AnySchema | AnyComposer = AnyEntity> = [S] extends [
  AnyComposer,
]
  ? NamespaceEid<S>
  : SchemaEid<Extract<S, AnySchema>>;

export const makeEid = <S extends AnySchema | AnyComposer>(id: number): Eid<S> =>
  id as Eid<S>;
