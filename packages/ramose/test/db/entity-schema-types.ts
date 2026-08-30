import {
  Entity,
  Schema,
  string,
  type AnySchema,
  type Equal,
  type Expect,
} from "../../src/db/internal.ts";
import { merge } from "../../src/db/internal.ts";

const Todo = Entity("todo", { title: string(), createdAt: string() });
const Label = Entity("label", { name: string() });

const ByObject = Schema({ todo: Todo, label: Label });
const ByArray = Schema([Todo, Label]);
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
Schema({ todos: Todo });

const OtherTodo = Entity("todo", { done: string() });
// @ts-expect-error
Schema([Todo, OtherTodo]);

// @ts-expect-error
merge(ByObject, Schema({ todo: OtherTodo }));

declare const anyLeft: AnySchema;
declare const anyRight: AnySchema;
const _wideMerge = merge(anyLeft, anyRight);
export type _wideMergeOk = Expect<Equal<typeof _wideMerge, AnySchema>>;

const Ctor = Entity("constructor", { title: string() });
const CtorSchema = Schema([Ctor]);
export type _ctorKey = Expect<
  Equal<keyof (typeof CtorSchema)["entities"], "constructor">
>;
