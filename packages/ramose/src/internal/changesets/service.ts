import { sha256Hex } from "../core/bytes.ts";
import { RevisionStore } from "../storage/revisions.ts";
import { readQueryView } from "../authorization/query-view.ts";
import * as Effect from "effect/Effect";
import { canonicalizeJson } from "../authorization/canonical-json.ts";
import type { JsonValue } from "../authorization/json.ts";
import { constructAuthorizedRequestContext, type AuthenticatedCaller } from "../authorization/request.ts";
import type { AuthoritativeOperationInvocation, OperationRuntime } from "../authorization/index.ts";
import { opaqueOperationDenial } from "../authorization/index.ts";
import { MAX_CHANGESET_DATOMS, MAX_CHANGESET_BYTES, changesetReadContext, appendChangeset, decodeStoredChangeset, authorizeChangeset, changesetConflict, changesetDiff, changesetSubject, prepareChangeset, type StoredChangeset as ChangesetData } from "../authorization/changesets.ts";
import { parseQueryDocument } from "../../mcp/contract.ts";
import { runEntityQueryDocument } from "../../mcp/kernel.ts";
import type { CatalogId, CatalogUnitHash } from "../authorization/identities.ts";
import { Connection } from "../core/conn.ts";
import type { LogEntry } from "../core/log.ts";
import { toJson } from "../core/json.ts";
import { DB_TX_INSTANT, isTxEid } from "../core/schema.ts";
import { BadRequest } from "../transactor/errors.ts";
import type { SqlLike } from "../transactor/host.ts";
import { decodeChangesetRequest, decodeCommandEnvelope, type ChangesetRequest } from "./protocol.ts";
import { decodeOperationInvocation } from "../authorization/invocation-codec.ts";

type StoredChangeset = ChangesetData & { readonly baseRevision: string };

type Command = Exclude<ChangesetRequest, { action: "prepare" | "append" }> |
  { readonly action: "prepare"; readonly id: string; readonly revision?: string; readonly title: string; readonly reviewers?: readonly string[]; readonly operations: readonly AuthoritativeOperationInvocation[] } |
  { readonly action: "append"; readonly id: string; readonly revision: string; readonly operations: readonly AuthoritativeOperationInvocation[] };
export type ChangesetCommand = Command & {
  readonly catalogKey: CatalogId;
  readonly unitHash: CatalogUnitHash;
  readonly database: string;
  readonly caller: AuthenticatedCaller;
  readonly maxCells?: number;
  readonly approval?: boolean;
};

export const decodeChangesetCommand = (raw: unknown): ChangesetCommand => {
  const request = decodeChangesetRequest(raw);
  const envelope = decodeCommandEnvelope(raw);
  if (request.action === "prepare" || request.action === "append") {
    return { ...request, ...envelope, operations: request.operations.map(decodeOperationInvocation) };
  }
  return { ...request, ...envelope };
};

type ChangesetHost = {
  readonly sql: SqlLike;
  readonly database: string;
  readonly transactionSync: <A>(run: () => A) => A;
  readonly reserve: (next: number) => void;
  readonly resolve: (operations: readonly AuthoritativeOperationInvocation[], caller: AuthenticatedCaller) => Promise<readonly AuthoritativeOperationInvocation[]>;
  readonly serialized: <A>(run: () => Promise<A>) => Promise<A>;
  readonly current: () => Connection;
  readonly schedule: (deadline: number) => Promise<void>;
  readonly checkpoint: () => Promise<void>;
  readonly commit: (entry: LogEntry, caller: AuthenticatedCaller, persist: () => void) => Promise<void>;
};

export class ChangesetService {
  readonly revisions: RevisionStore;
  constructor(private readonly host: ChangesetHost) { this.revisions = new RevisionStore(host.sql); }

  initialize(): void {
    this.revisions.initialize();
    this.host.sql.exec("CREATE TABLE IF NOT EXISTS changesets (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    this.host.sql.exec("CREATE TABLE IF NOT EXISTS changeset_headers (id TEXT PRIMARY KEY, revision TEXT NOT NULL, title TEXT NOT NULL, subject TEXT NOT NULL, basis INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL)");
    this.host.sql.exec("CREATE INDEX IF NOT EXISTS changeset_deadlines ON changeset_headers(status, expires_at)");
    this.host.sql.exec("CREATE INDEX IF NOT EXISTS changeset_author ON changeset_headers(subject, status)");
    this.host.sql.exec("CREATE TABLE IF NOT EXISTS changeset_recipients (subject TEXT NOT NULL, id TEXT NOT NULL REFERENCES changeset_headers(id), PRIMARY KEY(subject, id))");
    this.host.sql.exec("CREATE INDEX IF NOT EXISTS changeset_recipient_proposal ON changeset_recipients(id)");
    for (const row of this.host.sql.exec("SELECT body FROM changesets WHERE id NOT IN (SELECT id FROM changeset_headers)").toArray()) {
      const stored = JSON.parse(row.body as string) as StoredChangeset;
      this.host.transactionSync(() => this.saveChangeset(stored));
    }
    this.revisions.collect();
  }

  expire(now: number): void {
    const expired = this.host.sql.exec("SELECT id FROM changeset_headers WHERE status IN ('draft', 'committed', 'discarded') AND expires_at <= ?", now).toArray();
    this.host.transactionSync(() => {
      for (const { id } of expired) {
        this.revisions.release({ namespace: "changeset", name: id as string });
        this.host.sql.exec("DELETE FROM changesets WHERE id = ?", id);
        this.host.sql.exec("UPDATE changeset_headers SET status = 'expired' WHERE id = ?", id);
      }
    });
    this.revisions.collect();
    if (expired.length > 0) this.notify();
  }

  async schedule(): Promise<void> {
    const deadline = this.host.sql.exec("SELECT MIN(expires_at) AS deadline FROM changeset_headers WHERE status IN ('draft', 'committed', 'discarded')").toArray()[0]?.deadline;
    if (typeof deadline === "number") await this.host.schedule(deadline);
  }

  load(id: string | undefined): StoredChangeset | undefined {
    if (id === undefined) return undefined;
    const row = this.host.sql.exec("SELECT body FROM changesets WHERE id = ?", id).toArray()[0];
    if (row === undefined) return undefined;
    const stored = JSON.parse(row.body as string) as StoredChangeset;
    if (typeof stored.baseRevision !== "string") throw new Error("changeset database revision missing");
    return { ...decodeStoredChangeset(stored), baseRevision: stored.baseRevision };
  }

  private saveChangeset(stored: StoredChangeset): void {
    this.host.sql.exec("INSERT OR REPLACE INTO changesets (id, body) VALUES (?, ?)", stored.id, JSON.stringify(toJson(stored)));
    this.host.sql.exec("INSERT INTO changeset_headers(id, revision, title, subject, basis, expires_at, status, operations) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, title = excluded.title, subject = excluded.subject, basis = excluded.basis, expires_at = excluded.expires_at, status = excluded.status, operations = excluded.operations",
      stored.id, stored.revision, stored.title, stored.subject, stored.basis, stored.expiresAt, stored.status, stored.steps.length);
    this.host.sql.exec("DELETE FROM changeset_recipients WHERE id = ?", stored.id);
    for (const subject of new Set([stored.subject, ...stored.reviewers ?? []])) this.host.sql.exec("INSERT INTO changeset_recipients(subject, id) VALUES (?, ?)", subject, stored.id);
    this.revisions.reference({ namespace: "changeset", name: stored.id }, stored.baseRevision);
  }

  private readonly listeners = new Set<() => void>();

  private changeVersion = 0;

  notify(): void { this.changeVersion++; for (const listener of [...this.listeners]) listener(); }

  private async listing(connection: Connection, subject: string, now: number, page: { readonly after?: string; readonly limit?: number; readonly id?: string }) {
    const limit = page.id === undefined ? page.limit ?? 50 : 1;
    const rows = this.host.sql.exec(`SELECT h.id, h.revision, h.title, h.status, h.basis, h.expires_at AS expiresAt, h.operations
      FROM changeset_recipients r JOIN changeset_headers h ON h.id = r.id
      WHERE r.subject = ? AND r.id > ? ${page.id === undefined ? "" : "AND r.id = ?"}
      ORDER BY r.id LIMIT ?`, subject, page.after ?? "", ...(page.id === undefined ? [] : [page.id]), limit + 1).toArray();
    const items = rows.slice(0, limit).map((row) => ({ id: row.id as string, revision: row.revision as string, title: row.title as string, basis: row.basis as number, expiresAt: row.expiresAt as number, operations: row.operations as number,
      status: (row.expiresAt as number) <= now ? "expired" : row.status,
      stale: row.status === "draft" && (row.expiresAt as number) > now && row.basis !== connection.t,
    }));
    const nextCursor = rows.length > limit ? items.at(-1)!.id as string : null;
    return { items, nextCursor, version: await sha256Hex(new TextEncoder().encode(canonicalizeJson({ items, nextCursor, basis: connection.t } as JsonValue))) };
  }

  private async watch(runtime: OperationRuntime, command: ChangesetCommand & { action: "watch" | "list" }) {
    const subject = changesetSubject(command.caller, runtime.now());
    const capturedVersion = this.changeVersion;
    let result = await this.listing(this.host.current(), subject, runtime.now(), command);
    if (command.action === "watch" && command.version === result.version && capturedVersion === this.changeVersion) {
      const expiry = Math.min(command.caller.exp * 1000, ...result.items.filter((item) => item.status !== "expired").map((item) => item.expiresAt as number));
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); this.listeners.delete(finish); resolve(); };
        const timer = setTimeout(finish, Math.max(1, Math.min(25_000, expiry - runtime.now())));
        this.listeners.add(finish);
      });
      changesetSubject(command.caller, runtime.now());
      result = await this.listing(this.host.current(), subject, runtime.now(), command);
    }
    return result;
  }

  async execute(connection: Connection, runtime: OperationRuntime, command: ChangesetCommand,
    captured?: { readonly stored: StoredChangeset | undefined }): Promise<unknown> {
    const releases: (() => void)[] = [];
    try { return await this.executeRequest(connection, runtime, command, releases, captured); }
    finally { for (const release of releases) release(); if (command.action === "prepare" || command.action === "append" || command.action === "commit" || command.action === "discard") await this.schedule(); }
  }

  private async executeRequest(connection: Connection, runtime: OperationRuntime, command: ChangesetCommand,
    releases: (() => void)[], captured?: { readonly stored: StoredChangeset | undefined }): Promise<unknown> {
    if (command.database !== this.host.database) throw opaqueOperationDenial();
    if (command.action === "list" || command.action === "watch") return this.watch(runtime, command);
    const subject = changesetSubject(command.caller, runtime.now());
    const query = async (connection: Connection) => {
      const context = await Effect.runPromise(constructAuthorizedRequestContext({
        authenticate: Effect.succeed(command.caller), catalogs: runtime.catalogs.catalogs,
        routeDatabase: command.database as import("../authorization/identities.ts").DatabaseId,
        catalogKey: command.catalogKey, unitHash: command.unitHash,
        currentDb: () => Effect.succeed(connection.db()),
      }, command.caller));
      return runEntityQueryDocument(context, command.caller, parseQueryDocument("query" in command ? command.query : undefined), command.maxCells);
    };
    if (command.action === "query" && command.id === undefined) return query(connection);
    if (typeof command.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(command.id)) {
      throw new BadRequest({ message: "invalid changeset id" });
    }
    if (captured === undefined && command.action !== "prepare" && command.action !== "append") this.expire(runtime.now());
    let stored = captured === undefined ? this.load(command.id) : captured.stored;
    if (stored !== undefined && stored.subject !== subject && !stored.reviewers?.includes(subject)) throw opaqueOperationDenial();
    if (command.action === "prepare" || command.action === "append") {
      const requestKey = canonicalizeJson(toJson({ action: command.action, title: ("title" in command ? command.title : undefined),
        reviewers: "reviewers" in command ? command.reviewers : undefined,
        operations: command.operations.map(({ caller: _caller, invocationId: _id, ...operation }) => operation),
      }) as JsonValue);
      const captured = await this.host.serialized(async () => {
        this.expire(runtime.now());
        const previous = this.load(command.id);
        if (previous !== undefined && previous.subject !== subject) throw opaqueOperationDenial();
        if (previous === undefined) {
          const header = this.host.sql.exec("SELECT subject FROM changeset_headers WHERE id = ?", command.id).toArray()[0];
          if (header !== undefined) {
            if (header.subject !== subject) throw opaqueOperationDenial();
            throw changesetConflict("changeset_expired");
          }
        }
        if (command.action === "append" && previous === undefined) throw opaqueOperationDenial();
        if (previous?.requestKey === requestKey && previous.parentRevision === command.revision) {
          releases.push(this.revisions.retain(previous.baseRevision));
          return { retry: previous };
        }
        if (previous !== undefined && (previous.status !== "draft" || previous.revision !== command.revision)) throw changesetConflict("changeset_revision_conflict");
        const count = this.host.sql.exec("SELECT COUNT(*) AS n FROM changeset_headers WHERE subject = ? AND status = 'draft'", subject).toArray()[0]!.n as number;
        if (previous === undefined && count >= 32) throw changesetConflict("changeset_limit");
        const live = this.host.current();
        const base = live.fork();
        const limit = live.nextEntityId + MAX_CHANGESET_DATOMS;
        if (!Number.isSafeInteger(limit) || limit >= 2 ** 42) throw changesetConflict("changeset_limit");
        let baseRevision = previous?.baseRevision;
        this.host.transactionSync(() => {
          if (command.action === "prepare") baseRevision = this.revisions.save(base, { key: command.catalogKey, unitHash: command.unitHash });
          this.host.reserve(limit);
        });
        live.reserveEntityIds(limit);
        return { previous, base, baseRevision: baseRevision!, limit, release: this.revisions.retain(baseRevision!) };
      });
      if ("retry" in captured) stored = captured.retry;
      else {
        const { previous, baseRevision, limit } = captured;
        releases.push(captured.release);
        {
          const base = command.action === "append" ? await this.revisions.open(baseRevision, captured.base.store) : captured.base;
          base.reserveEntityIds(captured.base.nextEntityId);
          const operations = await this.host.resolve(command.operations, command.caller);
          await this.host.checkpoint();
          const prepared = command.action === "append"
            ? await appendChangeset(base, runtime, previous!, operations, command.caller)
            : await prepareChangeset(base, runtime, { id: command.id, title: command.title, operations }, command.caller);
          if (prepared.nextEntityId > limit) throw changesetConflict("changeset_too_large");
          const next = { ...prepared, baseRevision, requestKey,
            ...(command.action === "prepare" ? { reviewers: command.reviewers ?? [] } : {}),
            ...(command.revision === undefined ? {} : { parentRevision: command.revision }) };
          if (new TextEncoder().encode(JSON.stringify(toJson(next))).byteLength > MAX_CHANGESET_BYTES) throw changesetConflict("changeset_too_large");
          stored = await this.host.serialized(async () => {
            changesetSubject(command.caller, runtime.now());
            const current = this.load(command.id);
            if (current?.requestKey === requestKey && current.parentRevision === command.revision) {
              releases.push(this.revisions.retain(current.baseRevision));
              return current;
            }
            if (current?.revision !== previous?.revision || current?.status !== previous?.status) throw changesetConflict("changeset_revision_conflict");
            if (current === undefined) {
              const count = this.host.sql.exec("SELECT COUNT(*) AS n FROM changeset_headers WHERE subject = ? AND status = 'draft'", subject).toArray()[0]!.n as number;
              if (count >= 32) throw changesetConflict("changeset_limit");
            }
            this.host.transactionSync(() => this.saveChangeset(next));
            this.notify();
            return next;
          });
        }
      }
    }
    if (stored === undefined) {
      const row = this.host.sql.exec("SELECT h.id FROM changeset_headers h JOIN changeset_recipients r ON r.id = h.id WHERE h.id = ? AND r.subject = ? AND h.status = 'expired'", command.id, subject).toArray()[0];
      if (row !== undefined) throw changesetConflict("changeset_expired");
      throw opaqueOperationDenial();
    }
    if (stored.expiresAt <= runtime.now()) throw changesetConflict("changeset_expired");
    if (command.action === "prepare" || command.action === "append") connection = this.host.current().fork();
    const base = await this.revisions.open(stored.baseRevision, connection.store);
    if (command.action === "query" || command.action === "read") {
      if (stored.status !== "draft") throw changesetConflict("changeset_closed");
      if (command.revision !== undefined && command.revision !== stored.revision) throw changesetConflict("changeset_revision_conflict");
      const draft = await authorizeChangeset(base, runtime, stored, command.caller);
      const { after } = await changesetReadContext(base, runtime, stored, command.caller, draft, connection);
      const result = command.action === "read"
        ? { ...await readQueryView(after.filteredDb, command.query, Math.min(command.maxCells ?? 100_000, 100_000)), basis: stored.basis, revision: stored.revision }
        : await runEntityQueryDocument(after, command.caller, parseQueryDocument(command.query), command.maxCells);
      changesetSubject(command.caller, runtime.now());
      return result;
    }
    if (command.action === "commit" || command.action === "discard") {
      if (command.revision !== stored.revision) throw changesetConflict("changeset_revision_conflict");
      if (command.action === "commit" && command.approval !== true) throw opaqueOperationDenial();
      if ((stored.status === "committed" && command.action === "commit") ||
        (stored.status === "discarded" && command.action === "discard")) {
        return { id: stored.id, revision: stored.revision, title: stored.title, status: stored.status, basis: stored.basis,
          stale: false, expiresAt: stored.expiresAt, operations: stored.steps.length };
      }
      if (stored.status !== "draft") throw changesetConflict("changeset_closed");
      if (command.action === "discard") {
        stored = { ...stored, status: "discarded" };
        this.host.transactionSync(() => this.saveChangeset(stored!));
        this.notify();
      } else {
        await authorizeChangeset(connection, runtime, stored, command.caller);
        const committedAt = runtime.now();
        const committed: StoredChangeset = { ...stored, status: "committed", committedAt, committedBy: subject };
        const entry: LogEntry = { t: connection.t + 1, txInstant: committedAt,
          datoms: stored.datoms.map((fact) => fact.a === DB_TX_INSTANT && isTxEid(fact.e)
            ? { ...fact, v: committedAt } : fact) };
        await this.host.commit(entry, command.caller, () => this.saveChangeset(committed));
        stored = committed;
        this.notify();
      }
    }
    const result = { id: stored.id, revision: stored.revision, title: stored.title, status: stored.status, basis: stored.basis,
      stale: stored.status === "draft" && stored.basis !== connection.t,
      expiresAt: stored.expiresAt, operations: stored.steps.length };
    if (stored.status !== "draft") return result;
    return { ...result, changes: await changesetDiff(base, runtime, stored, command.caller, connection) };
  }
}
