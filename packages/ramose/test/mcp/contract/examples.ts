/**
 * Executable examples of the public MCP kernel wire contract (#485).
 *
 * These are the values the tracker's JSON sketches describe, written once so
 * every test asserts against the same wire shapes a reader of #484 would
 * expect. They are ordinary domain fixtures — plain data, no substitute for
 * any infrastructure.
 */

import { OperationVersion } from "../../../src/internal/authorization/identities.ts";
import {
  encodeOperationVersionToken,
  pageInfo,
  type DescribeOutputV1,
  type MutateInputV1,
  type MutateOutputV1,
  type OperationCardV1,
  type OperationRefV1,
  type QueryInputV1,
  type QueryOutputV1,
} from "../../../src/mcp/contract/index.ts";

/** A deployed operation-scoped version, as #487 computes it. */
export const closeIssueVersion = OperationVersion.make("1f".repeat(32));

/** Its opaque public projection — what a caller ever sees. */
export const closeIssueVersionToken = encodeOperationVersionToken(
  closeIssueVersion,
);

export const supportPath = Object.freeze(["acme", "support"]);

export const catalogToken = "cat_9dQwErTyUiOp-1";
export const listingCursor = "cur_Zm9vYmFy-2";

export const closeIssue: OperationRefV1 = Object.freeze({
  owner: Object.freeze({ kind: "entity" as const, name: "issue" }),
  name: "close",
  version: closeIssueVersionToken,
});

export const closeIssueCard: OperationCardV1 = Object.freeze({
  kind: "operation",
  ref: closeIssue,
  title: "Close issue",
  description: "Close an open issue with a stated reason.",
  target: "required",
  inputSchema: Object.freeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: Object.freeze({
      reason: Object.freeze({
        type: "string",
        description: "Why the issue is being closed.",
      }),
    }),
    required: Object.freeze(["reason"]),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: Object.freeze({
      closed: Object.freeze({ type: "boolean", description: "Always true." }),
    }),
    required: Object.freeze(["closed"]),
    additionalProperties: false,
  }),
  annotations: Object.freeze({
    title: "Close issue",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }),
  mutateTemplate: Object.freeze({
    tool: "mutate" as const,
    arguments: Object.freeze({ at: supportPath, operation: closeIssue }),
    fill: Object.freeze(["target", "input", "invocationId"] as const),
  }),
  resourceLink: Object.freeze({
    uri: "ramose://capability/8xKq2Vn0-Ab",
    mimeType: "application/json" as const,
  }),
});

export const describeListing: DescribeOutputV1 = Object.freeze({
  ok: true,
  result: "listing",
  at: supportPath,
  catalogToken,
  items: Object.freeze([
    Object.freeze({
      kind: "operation" as const,
      ref: closeIssue,
      title: "Close issue",
      description: "Close an open issue with a stated reason.",
      at: supportPath,
    }),
    Object.freeze({
      kind: "entity" as const,
      ref: Object.freeze({ kind: "entity" as const, name: "issue" }),
      title: "Issue",
      at: supportPath,
    }),
  ]),
  page: pageInfo({ limit: 25, returned: 2, cursor: listingCursor }),
});

export const describeCard: DescribeOutputV1 = Object.freeze({
  ok: true,
  result: "card",
  at: supportPath,
  catalogToken,
  card: closeIssueCard,
});

export const queryRequest: QueryInputV1 = Object.freeze({
  at: supportPath,
  query: Object.freeze({
    version: 1 as const,
    from: Object.freeze({ entity: "issue" }),
    where: Object.freeze({
      call: "logic.eq",
      args: Object.freeze([
        Object.freeze({ field: Object.freeze(["status"]) }),
        Object.freeze({ value: "open" }),
      ]),
    }),
  }),
  ifCatalog: catalogToken,
});

export const queryResult: QueryOutputV1 = Object.freeze({
  ok: true,
  at: supportPath,
  catalogToken,
  rows: Object.freeze([
    Object.freeze({
      values: Object.freeze({ id: "ISSUE-8472", title: "Login loops" }),
      ref: Object.freeze({ entity: "issue", id: "ISSUE-8472" }),
    }),
  ]),
  page: pageInfo({ limit: 25, returned: 1 }),
  delivery: Object.freeze({ mode: "one_shot" as const }),
});

export const mutateRequest: MutateInputV1 = Object.freeze({
  at: supportPath,
  operation: closeIssue,
  target: Object.freeze({ entity: "issue", id: "ISSUE-8472" }),
  input: Object.freeze({ reason: "duplicate" }),
  invocationId: "01K5Q0R7VYX3S6ZB2A9C4D8E1F",
});

export const mutateResult: MutateOutputV1 = Object.freeze({
  ok: true,
  at: supportPath,
  receipt: Object.freeze({
    invocationId: "01K5Q0R7VYX3S6ZB2A9C4D8E1F",
    status: "completed" as const,
  }),
  output: Object.freeze({ closed: true }),
});
