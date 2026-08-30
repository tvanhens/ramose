export const RANK_GAP = 1024;

export const rankAfter = (last: number | undefined): number =>
  last === undefined ? RANK_GAP : last + RANK_GAP;

export const rankBetween = (
  before: number | undefined,
  after: number | undefined,
): number => {
  if (before === undefined && after === undefined) return RANK_GAP;
  if (before === undefined) return (after as number) - RANK_GAP;
  if (after === undefined) return before + RANK_GAP;
  return (before + after) / 2;
};

export const rankAt = (ranks: readonly number[], index: number): number =>
  rankBetween(ranks[index - 1], ranks[index]);
