import type { ClientDatabase } from "ramose/client";
import { useQuery } from "ramose/react";
import { people } from "../../domain/queries.ts";
import type { ReefMutations } from "../ramose.ts";
import { personLabel, type PersonRow } from "../screens/BoardScreen.tsx";

type ReefDb = ClientDatabase<ReefMutations>;

type WorkspaceRow = {
  readonly id: unknown;
  readonly data: {
    readonly slug: string;
    readonly name?: string | undefined;
    readonly members?: readonly { readonly id: string }[] | undefined;
  };
  readonly mutate: {
    readonly addMember: (input: { person: string }) => unknown;
    readonly removeMember: (input: { person: string }) => unknown;
    readonly renameWorkspace: (input: { name: string }) => unknown;
  };
};

export const MembersPanel = (props: {
  readonly root: ReefDb;
  readonly workspace: unknown;
  readonly onClose: () => void;
}) => {
  const workspace = props.workspace as WorkspaceRow;
  const directory = useQuery(people(props.root), props.root);
  const everyone = directory.status === "ready" || directory.status === "stale"
    ? (directory.data as unknown as readonly PersonRow[])
    : [];
  const memberIds = new Set(
    (workspace.data.members ?? []).map((member) => member.id),
  );
  const members = everyone.filter((person) => memberIds.has(String(person.id)));
  const invitable = everyone.filter(
    (person) => !memberIds.has(String(person.id)),
  );

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="detail-head">
          <h3>Members of {String(workspace.data.name ?? workspace.data.slug)}</h3>
          <button className="ghost" onClick={props.onClose}>
            ✕
          </button>
        </header>
        <ul className="member-list">
          {members.map((person) => (
            <li key={String(person.id)}>
              <span className="avatar">
                {personLabel(person).slice(0, 1).toUpperCase()}
              </span>
              <span>{personLabel(person)}</span>
              <button
                className="ghost"
                disabled={members.length <= 1}
                onClick={() =>
                  workspace.mutate.removeMember({ person: String(person.id) })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <h4>Invite</h4>
        {invitable.length === 0 && (
          <p className="hint">
            Everyone in the directory is already a member. New accounts appear
            here after their first sign-in.
          </p>
        )}
        <ul className="member-list">
          {invitable.map((person) => (
            <li key={String(person.id)}>
              <span className="avatar">
                {personLabel(person).slice(0, 1).toUpperCase()}
              </span>
              <span>{personLabel(person)}</span>
              <button
                onClick={() =>
                  workspace.mutate.addMember({ person: String(person.id) })}
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
