import { useMutationFeedback } from "../MutationFeedback.tsx";
import { Workspace } from "../../domain/schema.ts";
import type { ClientDatabase, EntityHandleFor } from "ramose/client";
import { useQuery } from "ramose/react";
import { people } from "../../domain/queries.ts";
import type { ReefMutations } from "../ramose.ts";
import { personLabel } from "../entities.ts";

type ReefDb = ClientDatabase<ReefMutations>;

export const MembersPanel = (props: {
  readonly root: ReefDb;
  readonly workspace: EntityHandleFor<typeof Workspace>;
  readonly onClose: () => void;
}) => {
  const track = useMutationFeedback();
  const workspace = props.workspace;
  const directory = useQuery(people(props.root), props.root);
  const everyone = directory.status === "ready" || directory.status === "stale"
    ? directory.data
    : [];
  const memberIds = new Set(
    (workspace.data.members ?? []).map((member) => member.id),
  );
  const members = everyone.filter((person) => memberIds.has(person.id));
  const invitable = everyone.filter(
    (person) => !memberIds.has(person.id),
  );

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="detail-head">
          <h3>Members of {String(workspace.data.label ?? workspace.data.slug)}</h3>
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
                  track(workspace.mutate.removeMember({ person: person.id }), "Remove member")}
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
                  track(workspace.mutate.addMember({ person: person.id }), "Add member")}
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
