/** Shared fixture catalog for the schema tests / compile-time fixtures. */

import * as Schema from "effect/Schema";
import {
  Attr,
  Catalog,
  Instant,
  Long,
  Namespace,
  Ref,
} from "../../src/db/internal.ts";

export const User = Namespace("user", {
  name: Attr(Schema.String, { unique: "identity" }),
  age: Attr(Long),
  friends: Attr(Ref, { cardinality: "many" }),
  bestFriend: Attr(Ref),
});

export const Movie = Namespace("movie", {
  title: Attr(Schema.String, { index: true }),
  year: Attr(Long),
  released: Attr(Instant),
});

export const Meta = Namespace("meta", {
  source: Attr(Schema.String),
});

export const Movies = Catalog({ user: User, movie: Movie, meta: Meta });
