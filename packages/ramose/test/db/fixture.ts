/** Shared fixture catalog for the schema tests / compile-time fixtures. */

import * as Schema from "effect/Schema";
import {
  Field,
  Schema as DbSchema,
  Instant,
  Long,
  Entity,
  Ref,
} from "../../src/db/internal.ts";

export const User = Entity("user", {
  name: Field.unique(Schema.String, "upsert"),
  age: Field(Long, { optional: true }),
  friends: Field.many(Ref.self),
  bestFriend: Field(Ref.self, { optional: true }),
});

export const Movie = Entity("movie", {
  title: Field(Schema.String, { index: true }),
  year: Field(Long, { optional: true }),
  released: Field(Instant, { optional: true }),
});

export const Meta = Entity("meta", {
  source: Field(Schema.String),
});

export const Movies = DbSchema({ user: User, movie: Movie, meta: Meta });
