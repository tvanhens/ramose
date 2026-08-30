/**
 * Result-shape derivation.
 *
 * A typed client generates its row type from this, and a capability card
 * describes the answer with it — both without executing anything. It is
 * derived from the same resolved document lowering consumes, so the shape
 * and the plan cannot drift.
 */

import type { AnyComposer } from "../../Composer.ts";
import { valueTypeOf } from "./catalog.ts";
import { isCursorPaged } from "./lower.ts";
import type { FieldStepV1, ResolvedQueryDocumentV1, ResolvedSelectionV1 } from "./validate.ts";
import type { QueryResultShapeV1, ResultShapeV1 } from "./types.ts";

const list = (element: ResultShapeV1): ResultShapeV1 => ({ kind: "list", element });

const referenceShape = (
  target: AnyComposer | undefined,
  optional: boolean,
): ResultShapeV1 => ({
  kind: "reference",
  entity: target?.ns ?? null,
  optional,
});

const leafShape = (
  step: FieldStepV1,
  target: AnyComposer | undefined,
): ResultShapeV1 => {
  const { field } = step;
  if (field.type === "ref" && field.key !== "id") {
    const cell = referenceShape(target, field.many ? false : field.optional);
    return field.many ? list(cell) : cell;
  }
  const scalar: ResultShapeV1 = {
    kind: "scalar",
    type: field.type,
    optional: field.many ? false : field.optional,
  };
  return field.many ? list(scalar) : scalar;
};

/** The full-entity row a select-less document answers with. */
const defaultRowShape = (
  root: AnyComposer,
  targetOf: (owner: AnyComposer, step: FieldStepV1) => AnyComposer | undefined,
  describe: (owner: AnyComposer, key: string) => FieldStepV1 | undefined,
): ResultShapeV1 => {
  const fields: Record<string, ResultShapeV1> = {
    id: { kind: "scalar", type: "ref", optional: false },
  };
  for (const key of Object.keys(root.fields as Record<string, unknown>)) {
    const step = describe(root, key);
    if (step === undefined) continue;
    fields[key] = leafShape(step, targetOf(root, step));
  }
  return { kind: "object", fields, optional: false };
};

const projectionShape = (
  selections: readonly ResolvedSelectionV1[],
  targetOf: (owner: AnyComposer, step: FieldStepV1) => AnyComposer | undefined,
): ResultShapeV1 => {
  const fields: Record<string, ResultShapeV1> = {};
  for (const sel of selections) {
    if (sel.kind === "nested") {
      const object = projectionShape(sel.select, targetOf);
      fields[sel.key] = sel.step.field.many
        ? list(object)
        : { ...(object as { kind: "object"; fields: Record<string, ResultShapeV1> }), optional: true };
      continue;
    }
    if (sel.expr.kind === "field") {
      const step = sel.expr.steps[sel.expr.steps.length - 1]!;
      fields[sel.key] = leafShape(step, targetOf(step.owner, step));
      continue;
    }
    // A derived column: its type is the one its binding or its function's
    // signature declares. Deriving a value never makes it absent.
    fields[sel.key] = { kind: "scalar", type: sel.expr.type, optional: false };
  }
  return { kind: "object", fields, optional: false };
};

/** @internal `compile.ts` is the public door. */
export const resultShapeOf = (
  resolved: ResolvedQueryDocumentV1,
  targetOf: (owner: AnyComposer, step: FieldStepV1) => AnyComposer | undefined,
  describe: (owner: AnyComposer, key: string) => FieldStepV1 | undefined,
): QueryResultShapeV1 => ({
  row:
    resolved.select === null
      ? defaultRowShape(resolved.root, targetOf, describe)
      : projectionShape(resolved.select, targetOf),
  cardinality: resolved.cardinality,
  paged: isCursorPaged(resolved),
});

/** The document value vocabulary for a stored field type — re-exported so a
 * capability card can classify a field without importing the catalog. */
export { valueTypeOf };
