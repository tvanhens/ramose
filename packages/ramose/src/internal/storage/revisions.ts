import { captureRevision, restoreRevision, type DatabaseRevision } from "../core/revision.ts";
import type { Connection } from "../core/conn.ts";
import type { NodeStore } from "../core/tree.ts";
import { fromJson, stringifyJson } from "../core/json.ts";
import type { SqlLike } from "../transactor/host.ts";

export type RevisionOwner = { readonly namespace: string; readonly name: string };

export class RevisionStore {
  private readonly leases = new Map<string, number>();

  constructor(private readonly sql: SqlLike) {}

  initialize(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS database_revisions (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS revision_references (namespace TEXT NOT NULL, name TEXT NOT NULL, revision TEXT NOT NULL REFERENCES database_revisions(id), PRIMARY KEY(namespace, name))");
    this.sql.exec("CREATE INDEX IF NOT EXISTS revision_reference_target ON revision_references(revision)");
  }

  save(connection: Connection, catalog: DatabaseRevision["catalog"] = null): string {
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO database_revisions (id, body) VALUES (?, ?)", id, stringifyJson(captureRevision(connection, catalog)));
    return id;
  }

  reference(owner: RevisionOwner, revision: string): void {
    if (this.sql.exec("SELECT id FROM database_revisions WHERE id = ?", revision).toArray().length === 0) throw new Error("database revision missing");
    this.sql.exec("INSERT INTO revision_references(namespace, name, revision) VALUES (?, ?, ?) ON CONFLICT(namespace, name) DO UPDATE SET revision = excluded.revision", owner.namespace, owner.name, revision);
  }

  release(owner: RevisionOwner): void {
    this.sql.exec("DELETE FROM revision_references WHERE namespace = ? AND name = ?", owner.namespace, owner.name);
  }

  resolve(owner: RevisionOwner): string | undefined {
    return this.sql.exec("SELECT revision FROM revision_references WHERE namespace = ? AND name = ?", owner.namespace, owner.name).toArray()[0]?.revision as string | undefined;
  }

  async open(id: string, store: NodeStore): Promise<Connection> {
    const row = this.sql.exec("SELECT body FROM database_revisions WHERE id = ?", id).toArray()[0];
    if (row === undefined) throw new Error("database revision missing");
    const revision = fromJson(JSON.parse(row.body as string)) as DatabaseRevision;
    if (revision.composition === undefined || revision.catalog === undefined) throw new Error("database revision definition missing");
    return restoreRevision(store, revision);
  }

  roots() {
    return this.sql.exec("SELECT body FROM database_revisions").toArray().map((row) =>
      (JSON.parse(row.body as string) as DatabaseRevision).roots);
  }

  retain(id: string): () => void {
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = this.leases.get(id)! - 1;
      if (remaining > 0) this.leases.set(id, remaining);
      else { this.leases.delete(id); this.collectOne(id); }
    };
  }

  private collectOne(id: string): void {
    if (this.leases.has(id)) return;
    this.sql.exec("DELETE FROM database_revisions WHERE id = ? AND NOT EXISTS (SELECT 1 FROM revision_references WHERE revision = database_revisions.id)", id);
  }

  collect(): number {
    let removed = 0;
    for (const row of this.sql.exec("SELECT id FROM database_revisions WHERE NOT EXISTS (SELECT 1 FROM revision_references WHERE revision = database_revisions.id)").toArray()) {
      if (this.leases.has(row.id as string)) continue;
      this.sql.exec("DELETE FROM database_revisions WHERE id = ?", row.id);
      removed++;
    }
    return removed;
  }
}
