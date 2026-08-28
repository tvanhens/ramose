/**
 * Compile-time pin: reserved keys, bad ident names, and Schema key / ns
 * drift are type errors at Entity() / Schema() (issue #184).
 *
 * `bun run typecheck` compiles this file. A mismatch turns `Expect<Equal<…>>`
 * into a type error, or leaves a `@ts-expect-error` unused.
 */

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

// @ts-expect-error reserved field name — id, ns, fields, _tag, and traits are Entity / Trait metadata
Entity("post", { id: string() });
// @ts-expect-error reserved field name — id, ns, fields, _tag, and traits are Entity / Trait metadata
Entity("post", { ns: string() });
// @ts-expect-error reserved field name — id, ns, fields, _tag, and traits are Entity / Trait metadata
Entity("post", { fields: string() });
// @ts-expect-error reserved field name — id, ns, fields, _tag, and traits are Entity / Trait metadata
Entity("post", { _tag: string() });
// @ts-expect-error reserved field name — Entity / Trait metadata
Entity("post", { traits: string() });
const OperationsField = Entity("postWithOperations", { operations: string() });
OperationsField.operations.ident;

// @ts-expect-error invalid name — must match IDENT_NAME_RE
Entity("my ns/x", { title: string() });
// @ts-expect-error invalid name — must match IDENT_NAME_RE
Entity("1todo", { title: string() });
// @ts-expect-error invalid name — must match IDENT_NAME_RE
Entity("todo", { "a b": string() });
// @ts-expect-error invalid name — must match IDENT_NAME_RE
Entity("todo", { "has/slash": string() });

// @ts-expect-error Schema key must equal the Entity name
Schema({ todos: Todo });

const OtherTodo = Entity("todo", { done: string() });
// @ts-expect-error duplicate entity name
Schema([Todo, OtherTodo]);

// @ts-expect-error duplicate entity name
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
