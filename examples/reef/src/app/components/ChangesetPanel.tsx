import { Issue } from "../../domain/schema.ts";
import type { MutationRef } from "ramose/db";
import { MINT_PATH } from "../../domain/shared.ts";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useChangesets } from "ramose/react";
import { ChangesetError, type Changeset } from "ramose/client";
import type { IssueRow } from "../screens/BoardScreen.tsx";

export const ChangesetPanel = (props: {
  readonly previewReady: boolean;
  readonly issues: readonly IssueRow[];
  readonly proposal: Changeset | undefined;
  readonly onPreview: (proposal: Changeset | undefined) => void;
}) => {
  const changesets = useChangesets();
  const [after, setAfter] = useState<string | undefined>(undefined);
  const list = useMemo(() => changesets.observe(after === undefined ? {} : { after }), [changesets, after]);
  const inbox = useSyncExternalStore(list.subscribe, list.getSnapshot, list.getSnapshot);
  const review = useMemo(() => props.proposal === undefined ? list : changesets.observe({ id: props.proposal.id }), [changesets, list, props.proposal?.id]);
  const reviewed = useSyncExternalStore(review.subscribe, review.getSnapshot, review.getSnapshot);
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); } catch (cause) {
      setError(cause instanceof ChangesetError && cause.code === "changeset_stale"
        ? "The live board changed. Prepare a new proposal and review it again."
        : cause instanceof Error ? cause.message : "Unable to load this proposal.");
    } finally { setBusy(false); }
  };
  const prepare = () => run(async () => {
    const backlog = props.issues.filter((issue) => issue.data.status === "backlog").slice(0, 5);
    if (backlog.length === 0) throw new Error("Add a few backlog issues first.");
    const proposal = await changesets.prepare({
      id: crypto.randomUUID(),
      title: `Move ${backlog.length} backlog ${backlog.length === 1 ? "issue" : "issues"} into Todo`,
      operations: backlog.map((issue, index) => changesets.operations(Issue).moveIssue(issue.id as MutationRef, {
        status: "todo", rank: (index + 1) * 1024,
      })),
    });
    setId(proposal.id);
    props.onPreview(proposal);
  });
  const proposal = props.proposal;
  const current = reviewed.data?.items.find((item) => item.id === proposal?.id);
  useEffect(() => {
    if (proposal === undefined || reviewed.status !== "ready") return;
    const current = (reviewed.data?.items ?? []).find((item) => item.id === proposal.id);
    if (current === undefined || current.status === "expired") { setNotice("This proposal has expired or is no longer available."); props.onPreview(undefined); return; }
    if (current.revision !== proposal.revision) {
      let active = true;
      void changesets.inspect(current.id).then((next) => { if (active) props.onPreview(next); }).catch(() => {});
      return () => { active = false; };
    }
    if (current.status !== proposal.status || current.stale !== proposal.stale) props.onPreview({ ...proposal, ...current });
  }, [reviewed, proposal, changesets, props.onPreview]);
  return (
    <section className="proposal-panel" aria-label="Review proposed changes">
      <div className="proposal-actions">
        <strong>{proposal ? "Proposed board" : "Plan changes before applying them"}</strong>
        <button disabled={busy || proposal !== undefined} onClick={prepare}>Plan next sprint</button>
        <button disabled={busy} onClick={() => void run(async () => {
          const response = await fetch(MINT_PATH, {
            method: "POST", credentials: "include",
            headers: { "content-type": "application/json", "x-reef-agent": "1" }, body: "{}",
          });
          if (!response.ok) throw new Error("Sign in again to create agent access.");
          const credential = await response.json() as { token: string };
          await navigator.clipboard.writeText(credential.token);
          setNotice("Copied a 15-minute agent token. It can prepare proposals but cannot change live data or approve them.");
        })}>Copy agent token</button>
        <form onSubmit={(event) => {
          event.preventDefault();
          void run(async () => props.onPreview(await changesets.inspect(id.trim())));
        }}>
          <input aria-label="Proposal ID" placeholder="Open an agent’s proposal ID" value={id}
            onChange={(event) => setId(event.target.value)} />
          <button disabled={busy || id.trim() === ""}>Review</button>
        </form>
      </div>
      {!proposal && inbox.status === "ready" && (inbox.data?.items ?? []).filter((item) => item.status === "draft").length > 0 && <ul aria-label="Proposals awaiting review">
        {(inbox.data?.items ?? []).filter((item) => item.status === "draft").map((item) => <li key={item.id}>
          <button disabled={busy} onClick={() => void run(async () => { setId(item.id); props.onPreview(await changesets.inspect(item.id)); })}>{item.title}</button>
        </li>)}
      </ul>}
      {!proposal && <div className="proposal-actions">
        {after !== undefined && <button onClick={() => setAfter(undefined)}>First page</button>}
        {inbox.data?.nextCursor && <button onClick={() => setAfter(inbox.data!.nextCursor!)}>More proposals</button>}
      </div>}
      {proposal && <>
        <p>{proposal.title} · {proposal.operations} actions · {proposal.status}</p>
        {proposal.stale ? <p role="alert">The live board changed. This proposal must be prepared again before approval.</p>
          : proposal.status === "draft" && <p>The board below previews this proposal. Your live data stays unchanged until you approve.</p>}
        <details>
          <summary>Inspect all visible changes ({proposal.changes?.length ?? 0})</summary>
          <ul>{proposal.changes?.map((change, index) => <li key={index}>
            {props.issues.find((issue) => String(issue.id) === change.entity)?.data.title ?? "New or related record"}: {change.added ? "Set" : "Remove"} {change.field.split("/").at(-1)}: {String(change.value)}
          </li>)}</ul>
        </details>
        <div className="proposal-actions">
          <button disabled={busy || !props.previewReady || current?.revision !== proposal.revision || current?.status !== "draft" || current.stale || reviewed.status !== "ready" || reviewed.stale || proposal.stale || proposal.status !== "draft"} onClick={() => void run(async () => {
            await changesets.commit(proposal.id, proposal.revision);
            props.onPreview(undefined);
            setNotice("Approved. All changes were applied together.");
          })}>Approve and apply</button>
          <button disabled={busy || proposal.status !== "draft"} onClick={() => void run(async () => {
            await changesets.discard(proposal.id, proposal.revision);
            props.onPreview(undefined);
            setNotice("Proposal discarded.");
          })}>Discard</button>
          <button disabled={busy} onClick={() => props.onPreview(undefined)}>Return to live board</button>
        </div>
        <p className="proposal-id">Proposal: {proposal.id}</p>
      </>}
      {busy && <p role="status">Working…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
};
