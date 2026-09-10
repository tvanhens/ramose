export const REEF_DOMAIN = process.env.REEF_DOMAIN || undefined;

export const pinned = (suffix: string): { name?: string } =>
  REEF_DOMAIN ? { name: `ramose-reef-${suffix}` } : {};
