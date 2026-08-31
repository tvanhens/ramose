import {
  Entity,
  Schema,
  string,
  type CodeDefinition,
  type Equal,
  type Expect,
} from "../../src/db/internal.ts";
import { merge } from "../../src/db/internal.ts";

const Todo = Entity("todo", { title: string(), createdAt: string() });
const Label = Entity("label", { name: string() });

const ByObject = Schema("by-object", { todo: Todo, label: Label });
const ByArray = Schema("by-array", [Todo, Label]);
export const _definition: CodeDefinition = ByObject;
export type _key = Expect<Equal<typeof ByObject.key, "by-object">>;
export type _applyPolicyReturn = Expect<
  Equal<ReturnType<typeof ByObject.applyPolicy>, void>
>;
export type _arrayKeys = Expect<
  Equal<keyof (typeof ByArray)["entities"], "todo" | "label">
>;
export type _objectKeys = Expect<
  Equal<keyof (typeof ByObject)["entities"], "todo" | "label">
>;
export type _sameTodo = Expect<
  Equal<(typeof ByArray)["entities"]["todo"], typeof Todo>
>;

// @ts-expect-error
Entity("post", { id: string() });
// @ts-expect-error
Entity("post", { ns: string() });
// @ts-expect-error
Entity("post", { fields: string() });
// @ts-expect-error
Entity("post", { _tag: string() });
// @ts-expect-error
Entity("post", { traits: string() });
const DocField = Entity("postWithDoc", { doc: string() }, { doc: "Entity docs." });
DocField.doc.ident;
const OperationsField = Entity("postWithOperations", { operations: string() });
OperationsField.operations.ident;

// @ts-expect-error
Entity("my ns/x", { title: string() });
// @ts-expect-error
Entity("1todo", { title: string() });
// @ts-expect-error
Entity("todo", { "a b": string() });
// @ts-expect-error
Entity("todo", { "has/slash": string() });

// @ts-expect-error
Schema("drifted", { todos: Todo });
// @ts-expect-error
Schema({ todo: Todo });

const OtherTodo = Entity("todo", { done: string() });
// @ts-expect-error
Schema("duplicate-todos", [Todo, OtherTodo]);

// @ts-expect-error
merge("duplicate-merge", ByObject, Schema("other-todo", { todo: OtherTodo }));
// @ts-expect-error
merge(ByObject, ByArray);

declare const anyLeft: Schema.Any;
declare const anyRight: Schema.Any;
const _wideMerge = merge("wide", anyLeft, anyRight);
export type _wideMergeKey = Expect<Equal<typeof _wideMerge.key, "wide">>;

const Ctor = Entity("constructor", { title: string() });
const CtorSchema = Schema("constructors", [Ctor]);
export type _ctorKey = Expect<
  Equal<keyof (typeof CtorSchema)["entities"], "constructor">
>;
