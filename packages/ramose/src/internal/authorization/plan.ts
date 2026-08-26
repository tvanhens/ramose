/** Rule access plans: the complete facts and index lookups a decision needs. */

import type { RelativeEntityRef, RelativeFieldRef, RuleId } from "./identity.ts";

export type FactNeed =
  | {
      readonly _tag: "resourceField";
      readonly field: RelativeFieldRef;
    }
  | {
      readonly _tag: "principalRow";
    }
  | {
      readonly _tag: "claim";
      readonly key: string;
    }
  | {
      readonly _tag: "input";
      readonly key: string;
    }
  | {
      readonly _tag: "subject";
    };

export interface IndexNeed {
  readonly _tag: "entityScan";
  readonly entity: RelativeEntityRef;
  readonly fields: readonly RelativeFieldRef[];
}

export interface ExistsNeed {
  readonly entity: RelativeEntityRef;
  readonly bind: string;
}

export interface RuleAccessPlan {
  readonly ruleId: RuleId;
  readonly facts: readonly FactNeed[];
  readonly indexes: readonly IndexNeed[];
  readonly exists: readonly ExistsNeed[];
  readonly maxTraversalDepth: number;
  readonly usesMe: boolean;
  readonly usesResource: boolean;
  readonly usesInput: boolean;
}

export interface DecisionAccessPlan {
  readonly kind: "row" | "trait" | "field" | "operation";
  readonly key: string;
  readonly rules: readonly RuleAccessPlan[];
}
