/**
 * Compile-time pin: types a consumer needs are on the public barrels,
 * so nobody has a reason to deep-import. `bun run typecheck` compiles this.
 */

import type {
  AnyEntity,
  AnyField,
  AnySchema,
  AnyTrait,
  DatabasesShape,
  DbValueType,
  Entity,
  Field,
  FieldOptions,
  Schema,
  Trait,
  ValueOf,
} from "ramose/db";
import type { ReadDatabasesShape } from "ramose";
import type { RamoseEnv } from "ramose/worker";

type _entityAny = Entity.Any;
type _fieldAny = Field.Any;
type _schemaAny = Schema.Any;
type _traitAny = Trait.Any;

const _anyEntity: AnyEntity = null as unknown as _entityAny;
const _anyField: AnyField = null as unknown as _fieldAny;
const _anySchema: AnySchema = null as unknown as _schemaAny;
const _anyTrait: AnyTrait = null as unknown as _traitAny;

type _value = ValueOf<AnyField>;
type _opts = FieldOptions;
const _vt: DbValueType = "string";
type _dbs = DatabasesShape;
type _read = ReadDatabasesShape;
type _env = RamoseEnv;

void _anyEntity;
void _anyField;
void _anySchema;
void _anyTrait;
void (null as unknown as _value);
void (null as unknown as _opts);
void _vt;
void (null as unknown as _dbs);
void (null as unknown as _read);
void (null as unknown as _env);
