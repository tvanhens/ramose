import { useState } from "react";
import { useDb, useSuspenseQuery } from "ramose/react";
import { workspaces } from "../../domain/queries.ts";
import { isWorkspaceSlug, slugify } from "../../domain/shared.ts";
import type { ReefMutations } from "../ramose.ts";

export const WorkspacesScreen = () => {
  const db = useDb<ReefMutations>();
  const rows = useSuspenseQuery(workspaces(db));
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    const slug = slugify(name);
    if (!isWorkspaceSlug(slug)) {
      setError("Pick a name with a few letters or digits in it.");
      return;
    }
    setError(undefined);
    setName("");
    db.mutate.createWorkspace({ slug, name: name.trim() });
    location.hash = `#/w/${slug}`;
  };

  return (
    <main className="workspaces">
      <h2>Workspaces</h2>
      {rows.status === "error" && (
        <div className="error">{String(rows.error)}</div>
      )}
      <div className="workspace-grid">
        {(rows.status === "ready" || rows.status === "stale") &&
          rows.data.map((workspace) => (
            <a
              key={String(workspace.id)}
              className="workspace-card"
              href={`#/w/${workspace.data.slug}`}
            >
              <span className="workspace-name">
                {String(workspace.data.name ?? workspace.data.slug)}
              </span>
              <span className="workspace-slug">/{workspace.data.slug}</span>
            </a>
          ))}
        <form className="workspace-card workspace-new" onSubmit={create}>
          <input
            placeholder="New workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <button type="submit">Create</button>
          {error && <div className="error">{error}</div>}
        </form>
      </div>
      <p className="hint">
        A workspace is a child database of the reef root. You only see the
        workspaces whose member list includes you — that is the read policy,
        not a UI filter.
      </p>
    </main>
  );
};
