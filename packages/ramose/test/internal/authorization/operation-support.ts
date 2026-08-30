import {
  OperationVersion,
  type CatalogDescriptor,
  type EntityId,
} from "../../../src/internal/authorization/index.ts";
import { digestHex } from "./fixtures.ts";

/** Complete inert metadata for hand-authored authorization fixtures. */
export const operationMetadata = (
  composers: readonly EntityId[] = [],
): Omit<CatalogDescriptor["operations"][number], "id" | "input"> => ({
  output: { _tag: "struct", fields: [] },
  version: OperationVersion.make(digestHex(0xa0)),
  revision: 1,
  inputSchemaHash: digestHex(0xa1),
  outputSchemaHash: digestHex(0xa2),
  bodyHash: digestHex(0xa3),
  composers,
  writes: [],
});
