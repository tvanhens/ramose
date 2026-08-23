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
  name: Field(Schema.String, { unique: "upsert" }),
  age: Field(Long),
  friends: Field(Ref.self, { cardinality: "many" }),
  bestFriend: Field(Ref.self),
});

export const Movie = Entity("movie", {
  title: Field(Schema.String, { index: true }),
  year: Field(Long),
  released: Field(Instant),
});

export const Meta = Entity("meta", {
  source: Field(Schema.String),
});

export const Movies = DbSchema({ user: User, movie: Movie, meta: Meta });
