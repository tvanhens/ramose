/**
 * Compile-time pin: types a consumer needs are on the public barrels,
 * so nobody has a reason to deep-import. `bun run typecheck` compiles this.
 */

import type {
  AnyEntity,
  AnyField,
  AnySchema,
  DatabasesShape,
  DbValueType,
  Entity,
  Field,
  FieldOptions,
  Schema,
  ValueOf,
} from "ramose/db";
import type { ReadDatabasesShape } from "ramose";
import type { RamoseEnv } from "ramose/worker";

type _entityAny = Entity.Any;
type _fieldAny = Field.Any;
type _schemaAny = Schema.Any;

const _anyEntity: AnyEntity = null as unknown as _entityAny;
const _anyField: AnyField = null as unknown as _fieldAny;
const _anySchema: AnySchema = null as unknown as _schemaAny;

type _value = ValueOf<AnyField>;
type _opts = FieldOptions;
type _vt: DbValueType = "string";
type _dbs = DatabasesShape;
type _read = ReadDatabasesShape;
type _env = RamoseEnv;

void _anyEntity;
void _anyField;
void _anySchema;
void (null as unknown as _value);
void (null as unknown as _opts);
void _vt;
void (null as unknown as _dbs);
void (null as unknown as _read);
void (null as unknown as _env);
