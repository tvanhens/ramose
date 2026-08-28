import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Entity,
  Operation,
  checkOperationsCoverage,
  decodeInput,
  defineOperations,
  int,
  operationCards,
  operationNames,
  OperationsCoverageError,
  Schema as Catalog,
  string,
} from "../../src/db/internal.ts";

const Todo = Entity("todo", { title: string(), rank: int() });
const Todos = Catalog({ todo: Todo });
const Op = Operation.for(Todos);

const rename = Op(
  "todo/rename",
  { on: Todo, input: Schema.Struct({ title: Schema.String }), doc: "Rename a todo" },
  (op, input) => {
    op.update(Todo, op.self, { title: input.title });
    return {};
  },
);

const operations = defineOperations(Todos, { rename });

describe("portable operation authoring", () => {
  test("registry names and cards are inert declaration metadata", () => {
    expect(operationNames(operations)).toEqual(["todo/rename"]);
    expect(operationCards(operations)).toEqual([
      { name: "todo/rename", doc: "Rename a todo", on: "todo" },
    ]);
  });

  test("discovery cards omit normalized empty documentation", () => {
    const blank = Op(
      "todo/blank",
      { on: Todo, input: Schema.Struct({}), doc: " \n\t" },
      () => ({}),
    );
    expect(operationCards(defineOperations(Todos, { blank }))).toEqual([
      { name: "todo/blank", on: "todo" },
    ]);
  });

  test("Schema-backed input decoding remains available to authoritative execution", async () => {
    expect(await Effect.runPromise(decodeInput(rename.input, { title: "next" }))).toEqual({ title: "next" });
    await expect(Effect.runPromise(decodeInput(rename.input, { title: 1 }))).rejects.toMatchObject({ _tag: "InvalidRequest" });
  });

  test("coverage compares declarations without a client runtime", () => {
    expect(() => checkOperationsCoverage(operations, ["todo/rename", "todo/delete"])).not.toThrow();
    expect(() => checkOperationsCoverage(operations, [])).toThrow(OperationsCoverageError);
  });
});
