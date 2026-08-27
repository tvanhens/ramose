/**
 * Synchronous snapshot basis arithmetic (HIST-1, HIST-2).
 *
 * Application reads keep their requested current / as-of / history
 * collapse. Authorization always names a separate current rule basis.
 * Merge and effective-t are pure so they can be tested without storage.
 *
 * @internal
 */

export type ApplicationBasis = {
  readonly basisT: number;
  readonly asOfT: number | undefined;
  readonly history: boolean;
  readonly effectiveT: number;
};

export type SnapshotBases = {
  readonly application: ApplicationBasis;
  readonly ruleBasisT: number;
};

const requireFiniteT = (value: number, label: string): number => {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`ramose/authorization: ${label} must be a non-negative integer`);
  }
  return value;
};

export const effectiveApplicationT = (basisT: number, asOfT?: number): number => {
  const basis = requireFiniteT(basisT, "basisT");
  if (asOfT === undefined) return basis;
  const asOf = requireFiniteT(asOfT, "asOfT");
  return asOf < basis ? asOf : basis;
};

export const collapseApplicationBasis = (input: {
  readonly basisT: number;
  readonly asOfT?: number | undefined;
  readonly history?: boolean | undefined;
}): ApplicationBasis => ({
  basisT: requireFiniteT(input.basisT, "basisT"),
  asOfT: input.asOfT === undefined ? undefined : requireFiniteT(input.asOfT, "asOfT"),
  history: input.history === true,
  effectiveT: effectiveApplicationT(input.basisT, input.asOfT),
});

export const mergeSnapshotBases = (
  application: ApplicationBasis,
  ruleBasisT: number,
): SnapshotBases => ({
  application,
  ruleBasisT: requireFiniteT(ruleBasisT, "ruleBasisT"),
});
