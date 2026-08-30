export const REEF_DOMAIN = process.env.REEF_DOMAIN || undefined;

export const REEF_ORIGIN = REEF_DOMAIN ? `https://${REEF_DOMAIN}` : undefined;

export const zoneOf = (host: string): string => host.split(".").slice(-2).join(".");

export const pinned = (suffix: string): { name?: string } =>
  REEF_DOMAIN ? { name: `ramose-reef-${suffix}` } : {};
