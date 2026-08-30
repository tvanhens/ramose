export const MAX_TRAVERSAL_DEPTH = 3;

export const DEFAULT_AUTHORIZATION_BUDGET = 10_000;

export const MAX_READ_LEASE_MS = 5_000;

export const MAX_JSON_DEPTH = 64;

export const MAX_COLLECTION_SIZE = 1_024;

export const MAX_STRING_LENGTH = 4_096;

export const MAX_JSON_NODES = 4_096;

export const MAX_JSON_ENCODED_BYTES = 65_536;

export type AuthorizationBudget = {
  readonly limit: number;
  readonly spent: number;
};
