/** Static bounds for the authorization expression language. */

export const POLICY_TEMPLATE_VERSION = "ramose.policy.template.1" as const;
export const INSTALLED_AUTHORIZATION_VERSION =
  "ramose.authorization.installed.1" as const;

export const MAX_RULES = 256;
export const MAX_DECISIONS = 512;
export const MAX_EXPR_NODES = 1024;
export const MAX_EXPR_DEPTH = 24;
export const MAX_TRAVERSAL_DEPTH = 4;
export const MAX_EXISTS_NESTING = 4;
export const MAX_COLLECTION_SIZE = 256;
export const MAX_IDENT_LENGTH = 128;
export const MAX_STRING_LITERAL = 4096;
export const MAX_CLASSES = 64;
export const MAX_CLAIMS = 64;
export const MAX_PATH_STEPS = 4;
export const MAX_INPUT_KEYS = 64;
export const DEFAULT_WORK_BUDGET = 4096;

export type PolicyTemplateVersion = typeof POLICY_TEMPLATE_VERSION;
export type InstalledAuthorizationVersion =
  typeof INSTALLED_AUTHORIZATION_VERSION;
