/**
 * Operations registered on the local open / policy peers.
 *
 * Combines the e2e registry (session + reef board), the todos writes, and
 * the movie/user fixtures the operations contract drives.
 */

import * as Schema from "effect/Schema";
import * as Ramose from "ramose/db";
import {
  addReefIssue,
  addReefUser,
  addSession,
  moveReefIssue,
} from "../../e2e-ops.ts";
import {
  addTodoOp,
  deleteTodoOp,
  setDoneOp,
} from "../../examples/todos/src/todos.ts";

export const User = Ramose.Entity("user", {
  name: Ramose.Field.unique(Ramose.string(), "upsert"),
  age: Ramose.int({ optional: true }),
  bestFriend: Ramose.Field(Ramose.Ref.self, { optional: true }),
});

export const Movie = Ramose.Entity("movie", {
  title: Ramose.Field(Ramose.string(), { index: true }),
});

export const Movies = Ramose.Schema({ user: User, movie: Movie });

export const setTitle = Ramose.Operation(
  "movie/set-title",
  {
    on: Movie,
    input: Schema.Struct({ title: Schema.String }),
    output: Schema.Struct({ title: Schema.String }),
  },
  (op, input) => {
    op.set(op.self, Movie.title, input.title);
    return { title: input.title };
  },
);

export const ping = Ramose.Operation(
  "ping",
  {
    input: Schema.Struct({}),
    output: Schema.Struct({ n: Schema.Finite }),
  },
  async (op) => {
    const n = await op.effect("count", () => 1);
    return { n };
  },
);

export const createNamed = Ramose.Operation(
  "user/create",
  {
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    const e = op.entity();
    e.set(User.name, input.name);
    return {};
  },
);

export const setName = Ramose.Operation(
  "user/set-name",
  {
    on: User,
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({ name: Schema.String }),
  },
  (op, input) => {
    op.set(op.self, User.name, input.name);
    return { name: input.name };
  },
);

export const createCoded = Ramose.Operation(
  "user/create-coded",
  {
    schema: Movies,
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({
      id: Ramose.EntityId,
      code: Schema.FiniteFromString,
    }),
  },
  (op, input) => {
    const created = op.put(User, { name: input.name });
    return { id: created, code: 5 };
  },
);

export const createByPut = Ramose.Operation(
  "user/create-put",
  {
    schema: Movies,
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    op.put(User, { name: input.name });
    return {};
  },
);

export const createShort = Ramose.Operation(
  "user/create-short",
  {
    schema: Movies,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.put(User, { age: 1 } as never);
    return {};
  },
);

export const updateGhost = Ramose.Operation(
  "user/update-ghost",
  {
    schema: Movies,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.update(User, 999_999, { age: 1 });
    return {};
  },
);

export const putOnBootstrap = Ramose.Operation(
  "user/put-bootstrap",
  {
    schema: Movies,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.put(User, 10, { age: 1 });
    return {};
  },
);

export const putOnMovie = Ramose.Operation(
  "user/put-on-movie",
  {
    schema: Movies,
    input: Schema.Struct({ eid: Schema.Finite }),
    output: Schema.Struct({}),
  },
  (op, input) => {
    op.put(User, input.eid, { name: "nope" });
    return {};
  },
);

export const putMissingEid = Ramose.Operation(
  "user/put-missing-eid",
  {
    schema: Movies,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.put(User, 1008, { name: "squatter" });
    return {};
  },
);

export const putDanglingRef = Ramose.Operation(
  "user/put-dangling-ref",
  {
    schema: Movies,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
  },
  (op) => {
    op.put(User, { name: "Ada", bestFriend: 888888 as never });
    return {};
  },
);

export const operations = Ramose.Operations({
  addSession,
  addReefUser,
  addReefIssue,
  moveReefIssue,
  addTodoOp,
  setDoneOp,
  deleteTodoOp,
  setTitle,
  ping,
  createNamed,
  setName,
  createCoded,
  createByPut,
  createShort,
  updateGhost,
  putOnBootstrap,
  putOnMovie,
  putMissingEid,
  putDanglingRef,
});

export const OPERATION_IDS = operations.names();
