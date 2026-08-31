import {
  isAuthPath,
  isJsonScalar,
  isPathCarrier,
  stepFromCarrier,
  type AuthExpr,
  type AuthOperandInput,
  type BoxedOperand,
} from "./types.ts";

export const allow = { _tag: "const", value: true } as const satisfies AuthExpr;
export const deny = { _tag: "const", value: false } as const satisfies AuthExpr;

export const me = { _tag: "me" } as const;
export const subject = { _tag: "subject" } as const;

export const claim = (key: string): BoxedOperand => ({ _tag: "claim", key });

export const lit = (value: string | number | boolean | null): BoxedOperand => ({
  _tag: "lit",
  value,
});

export const hasClass = (className: string): AuthExpr => ({
  _tag: "hasClass",
  class: typeof className === "string" ? className : "",
});

export const all = (...exprs: readonly AuthExpr[]): AuthExpr => ({
  _tag: "and",
  exprs,
});

export const any = (...exprs: readonly AuthExpr[]): AuthExpr => ({
  _tag: "or",
  exprs,
});

export const not = (expr: AuthExpr): AuthExpr => ({
  _tag: "not",
  expr,
});

const knownOperandTags = new Set(["me", "subject", "claim", "lit", "resource", "path"]);

export const boxOperand = (input: AuthOperandInput | unknown): unknown => {
  if (isAuthPath(input)) {
    return input.steps.length === 0
      ? { _tag: "resource" as const }
      : { _tag: "path" as const, steps: input.steps };
  }
  if (isPathCarrier(input)) return { _tag: "path" as const, steps: [stepFromCarrier(input)] };
  if (isJsonScalar(input)) return { _tag: "lit" as const, value: input };
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { readonly _tag?: unknown })._tag === "string" &&
    knownOperandTags.has((input as { readonly _tag: string })._tag)
  ) {
    return input;
  }
  return input;
};

export const eq = (left: AuthOperandInput | unknown, right: AuthOperandInput | unknown): AuthExpr => ({
  _tag: "eq",
  left: boxOperand(left),
  right: boxOperand(right),
});

export const contains = (
  collection: AuthOperandInput | unknown,
  value: AuthOperandInput | unknown,
): AuthExpr => ({
  _tag: "in",
  value: boxOperand(value),
  collection: boxOperand(collection),
});
