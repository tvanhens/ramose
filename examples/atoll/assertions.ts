/**
 * Compile-time assertions: the guarantees the design-fiction types make.
 * `bun run typecheck` is the test runner — if an edit to future.ts breaks one
 * of these, the ergonomics loop caught something. Nothing here runs.
 */

import * as Ramose from "./future.ts";
import { addTagOp, Taggable } from "./taggable.ts";
import { createWsOp, Ws } from "./org.ts";
import {
  createIssueOp,
  Issue,
  moveIssueOp,
  workspaceCatalog,
} from "./workspace.ts";

declare const org: Ramose.GraphHandle<Ramose.AnyCatalog>;
declare const ws: Ramose.GraphHandle<typeof workspaceCatalog>;
declare const eid: Ramose.Eid;

// ── #313 rule 1: a trait field is the same attribute on every composer ───────

const tagsOnIssue: typeof Taggable.tags = Issue.tags;
const tagsOnWs: typeof Taggable.tags = Ws.tags;

// ── row types flow from select shapes, trait fields included ─────────────────

const q = Ramose.Query.from(Issue).select({
  title: Issue.title,
  status: Issue.status,
  tags: Issue.tags,
});
const row: Ramose.Row<typeof q> = {
  title: "t",
  status: "todo",
  tags: ["urgent"],
};
// @ts-expect-error — status is the enum's union, not any string
const badRow: Ramose.Row<typeof q> = { title: "t", status: "shipped", tags: [] };

// ── discovery is a trait query ───────────────────────────────────────────────

const discovery = Ramose.Query.from(Ramose.Graph).select({
  name: Ramose.Graph.name,
  doc: Ramose.Graph.doc,
});
const card: Ramose.Row<typeof discovery> = { name: "acme", doc: "Acme Corp" };

// ── operations: targeted vs untargeted arity, payload checking ───────────────

void org.run(createWsOp, { name: "acme", doc: undefined });
// @ts-expect-error — createWsOp takes no target row
void org.run(createWsOp, eid, { name: "acme" });

void ws.run(moveIssueOp, eid, { status: "doing" });
// @ts-expect-error — patch payloads are checked against the entity's fields
void ws.run(moveIssueOp, eid, { status: "shipped" });

void ws.run(createIssueOp, { title: "hello" });
// @ts-expect-error — unknown input keys are rejected
void ws.run(createIssueOp, { title: "hello", status: "todo" });

// A trait-scoped operation runs against any composer's graph handle.
void ws.run(addTagOp, eid, { tag: "urgent" });
void org.run(addTagOp, eid, { tag: "q3" });

void [tagsOnIssue, tagsOnWs, row, badRow, card];
