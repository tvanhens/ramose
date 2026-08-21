/**
 * One open workspace: header, live kanban, issue panel, time travel.
 *
 * Everything on screen is derived from three `useLive(db, query)` reads
 * against the session overlay; every write goes through `useTransact` so
 * the pending layer paints before the Transactor acks. The peer's policy
 * may still deny a write — the layer drops, the board snaps back, and the
 * denial becomes a toast (enforcement is server-side; the UI is a hint).
 */

import {
  errorMessage,
  useBasis,
  useDb,
  useLive,
  useQuery,
  useTransact,
} from "ramose/react";
import * as stylex from "@stylexjs/stylex";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  boardQuery,
  everyIssueEverQuery,
  labelsQuery,
  peopleQuery,
  type BoardRow,
  type ReefDb,
} from "../../domain/queries.ts";
import {
  PRIORITIES,
  Reef,
  STATUS_LABELS,
  type Status,
} from "../../domain/schema.ts";
import { ThemeToggle } from "../App.tsx";
import { authClient, inviteMember, listWorkspaces, type SessionUser } from "../auth.ts";
import { Board, COLUMN_TINTS } from "../components/Board.tsx";
import { IssueDetail } from "../components/IssueDetail.tsx";
import { TimeTravelBar } from "../components/TimeTravel.tsx";
import { createIssue, moveIssue, seedSampleIssues, type NewIssue } from "../mutations.ts";
import { bindSelf, type Workspace } from "../ramose.ts";
import { useBoardSelection } from "../route.tsx";
import { INVITABLE_ROLES } from "../../domain/roles.ts";
import { colors, radii, space, type } from "../theme/tokens.stylex";
import {
  Avatar,
  Button,
  Code,
  Dialog,
  DialogFooter,
  Empty,
  Field,
  Icon,
  IconButton,
  Input,
  Loading,
  LogoMark,
  PriorityIcon,
  Select,
  Tag,
  TextArea,
  useEscape,
  useToast,
} from "../ui.tsx";

const pulse = stylex.keyframes({
  "0%": { boxShadow: "0 0 0 0 rgba(63, 185, 112, 0.6)" },
  "100%": { boxShadow: "0 0 0 8px rgba(63, 185, 112, 0)" },
});

const styles = stylex.create({
  screen: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    height: "100dvh",
    overflow: "hidden",
    overscrollBehavior: "none",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: "52px",
    paddingInline: space.md,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.bgRaised,
    flexShrink: 0,
    overflowX: "auto",
    scrollbarWidth: "none",
  },
  // Secondary header chrome that can go on narrow screens.
  wide: {
    display: { default: "inline-flex", "@media (max-width: 760px)": "none" },
  },
  crumbSep: { color: colors.textFaint, display: "inline-flex", marginInline: "2px" },
  wsName: { fontWeight: 700, fontSize: type.md, color: colors.text },
  wsSlug: {
    fontFamily: type.mono,
    fontSize: type.xs,
    color: colors.textFaint,
    marginLeft: space.xs,
  },
  spacer: { flexGrow: 1 },
  live: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    fontSize: type.xs,
    fontWeight: 600,
    color: colors.textMuted,
    paddingInline: space.sm,
    paddingBlock: "3px",
    borderRadius: radii.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontVariantNumeric: "tabular-nums",
    marginRight: space.xs,
  },
  liveDot: {
    width: "7px",
    height: "7px",
    borderRadius: radii.full,
    backgroundColor: colors.ok,
  },
  liveDotPaused: { backgroundColor: colors.warn },
  liveDotPulse: {
    animationName: pulse,
    animationDuration: "700ms",
    animationTimingFunction: "ease-out",
  },
  liveMono: { fontFamily: type.mono, color: colors.textFaint, fontWeight: 500 },
  divider: {
    width: "1px",
    height: "20px",
    backgroundColor: colors.border,
    marginInline: space.xs,
  },
  main: { display: "flex", flexGrow: 1, minHeight: 0, position: "relative" },
  boardWrap: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    position: "relative",
  },
  emptyOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
    paddingTop: "48px",
  },
  emptyCard: {
    pointerEvents: "auto",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.borderStrong,
    borderRadius: radii.lg,
    boxShadow: colors.shadow,
    width: "min(420px, calc(100% - 32px))",
    paddingBlock: space.md,
  },
  pastNotice: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    marginInline: space.lg,
    marginTop: space.sm,
    fontSize: type.xs,
    color: colors.textMuted,
  },
  segmented: {
    display: "flex",
    gap: "4px",
    padding: "3px",
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.sm,
  },
  segment: {
    flexGrow: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    paddingBlock: "5px",
    paddingInline: "6px",
    borderRadius: radii.xs,
    borderWidth: 0,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    backgroundImage: "none",
    color: colors.textMuted,
    fontSize: type.xs,
    fontWeight: 600,
    cursor: "pointer",
    outline: "none",
    boxShadow: { default: "none", ":focus-visible": `0 0 0 3px ${colors.ring}` },
    transition: "background-color 120ms ease, color 120ms ease",
    whiteSpace: "nowrap",
  },
  segmentOn: {
    backgroundColor: { default: colors.surfaceActive, ":hover": colors.surfaceActive },
    color: colors.text,
    boxShadow: colors.shadowSm,
  },
  statusDot: { width: "8px", height: "8px", borderRadius: radii.full, display: "inline-block" },
});

export const BoardScreen = ({
  workspace,
  name,
  user,
  onLeave,
}: {
  workspace: Workspace;
  name: string;
  /** Set once `get-session` settles; `bindSelf` waits for it. */
  user: SessionUser | undefined;
  onLeave: () => void;
}) => {
  const { cls, slug } = workspace;
  const toast = useToast();
  const db = useDb(slug, Reef);
  const [myEid, setMyEid] = useState<number | undefined>(undefined);

  const userId = user?.id;
  const userName = user?.name;
  const userEmail = user?.email;
  // After paint. Hydrate / first columns do not wait on the session user.
  // Do not bindSelf with a guessed class — wait for claims.
  useEffect(() => {
    if (
      cls === undefined ||
      userId === undefined ||
      userName === undefined ||
      userEmail === undefined
    ) {
      return;
    }
    let cancelled = false;
    void Effect.runPromise(
      bindSelf(db, { id: userId, name: userName, email: userEmail }, cls),
    ).then(
      (eid) => {
        if (cancelled) return;
        setMyEid(eid);
      },
      (err) => {
        if (cancelled) return;
        toast("error", errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [db, userId, userName, userEmail, cls, toast]);

  const board = useLive(db, boardQuery);
  const people = useLive(db, peopleQuery);
  const labels = useLive(db, labelsQuery);

  const [selected, setSelected] = useBoardSelection(slug);
  const lastSelected = useRef<BoardRow | undefined>(undefined);
  const [draftStatus, setDraftStatus] = useState<Status | null>(null);
  const [invite, setInvite] = useState(false);
  const [timeTraveling, setTimeTraveling] = useState(false);

  // Every write is one `run(...)`; a policy denial (or any DbError) becomes
  // a toast — enforcement is server-side, the UI is only a hint.
  const { run } = useTransact({
    onError: (error) => toast("error", errorMessage(error)),
  });

  useEscape(
    useCallback(() => {
      setSelected(null);
      setDraftStatus(null);
      setInvite(false);
    }, [setSelected]),
  );

  const liveRows = board.rows;
  // `ticks` counts overlay emissions after the first — local apply, ack,
  // or an inbound filtered `tx` — and the pulse makes that visible.
  const ticks = board.ticks;
  useEffect(() => {
    if (typeof console === "undefined" || typeof console.info !== "function") {
      return;
    }
    const t =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    console.info("[ramose] board.rows", {
      t,
      rows: liveRows?.length,
      ticks,
    });
  }, [liveRows, ticks]);
  // Derived from the live rows, so a deleted issue closes its own panel.
  // An optimistic create remaps its eid on ack; rebind by the facts that
  // survived (title / column / rank / creator) so the panel stays open.
  const prior = lastSelected.current;
  const selectedRow =
    liveRows === undefined || selected === null
      ? undefined
      : (liveRows.find((r) => r.id === selected) ??
        liveRows.find(
          (r) =>
            prior !== undefined &&
            r.title === prior.title &&
            r.status === prior.status &&
            r.rank === prior.rank &&
            r.creator.id === prior.creator.id,
        ));
  if (selectedRow !== undefined) lastSelected.current = selectedRow;
  else if (selected === null) lastSelected.current = undefined;
  useEffect(() => {
    if (selectedRow !== undefined && selectedRow.id !== selected) {
      setSelected(selectedRow.id);
    } else if (
      selected !== null &&
      liveRows !== undefined &&
      selectedRow === undefined
    ) {
      setSelected(null);
    }
  }, [selected, selectedRow, liveRows, setSelected]);
  const canWrite = myEid !== undefined;

  if (board.error !== undefined) {
    return (
      <div {...stylex.props(styles.screen)}>
        <Loading text="connection lost — retrying on reload…" />
      </div>
    );
  }
  // First cards are the hydrated emission. `undefined` is not `[]` —
  // do not paint empty columns before that. `[]` after hydrate is honest.
  if (liveRows === undefined) {
    return <Loading text={`opening ${slug}…`} />;
  }

  return (
    <div {...stylex.props(styles.screen)}>
      <header {...stylex.props(styles.header)}>
        <IconButton icon="chevronLeft" label="Back to workspaces" onClick={onLeave} />
        <LogoMark size={22} />
        <span {...stylex.props(styles.wsName)}>{name}</span>
        <span {...stylex.props(styles.wsSlug, styles.wide)}>db/{slug}</span>
        {cls !== undefined && (
          <Tag
            tone={cls === "admin" ? "accent" : cls === "member" ? "ok" : "neutral"}
            title="your ramose.class in this workspace"
          >
            {cls}
          </Tag>
        )}
        <span {...stylex.props(styles.spacer)} />
        <span
          {...stylex.props(styles.live, styles.wide)}
          title="Live: your writes paint on the local overlay; other sessions arrive as filtered transactions"
        >
          <span
            key={ticks}
            {...stylex.props(
              styles.liveDot,
              timeTraveling && styles.liveDotPaused,
              ticks > 0 && !timeTraveling && styles.liveDotPulse,
            )}
          />
          {timeTraveling ? "paused" : "live"}
          {ticks > 0 && (
            <span {...stylex.props(styles.liveMono)}>
              {ticks} {ticks === 1 ? "tick" : "ticks"}
            </span>
          )}
        </span>
        {!timeTraveling && (
          <Button
            size="sm"
            onClick={() => {
              setSelected(null);
              setTimeTraveling(true);
            }}
          >
            <Icon name="history" size={13} /> Time travel
          </Button>
        )}
        {cls === "admin" && (
          <Button size="sm" onClick={() => setInvite(true)}>
            <Icon name="userPlus" size={13} /> Invite
          </Button>
        )}
        <span {...stylex.props(styles.divider, styles.wide)} />
        <ThemeToggle />
        {user !== undefined && (
          <span {...stylex.props(styles.wide)}>
            <Avatar name={user.name} size="md" title={`${user.name} · ${user.email}`} />
          </span>
        )}
        <IconButton icon="logout" label="Sign out" onClick={() => void authClient.signOut()} />
      </header>

      {timeTraveling ? (
        <TimeTravelView
          db={db}
          liveRows={liveRows}
          onExit={() => setTimeTraveling(false)}
        />
      ) : (
        <div {...stylex.props(styles.main)}>
          <div {...stylex.props(styles.boardWrap)}>
            <Board
              rows={liveRows}
              readOnly={false}
              canCreate={canWrite}
              selectedId={selected}
              onSelect={(id) => setSelected(id)}
              onNew={(status) => setDraftStatus(status)}
              onMove={(id, status, rank) =>
                void run(moveIssue(db, id, status, rank))
              }
            />
            {liveRows.length === 0 && board.ticks > 0 && (
              <div {...stylex.props(styles.emptyOverlay)}>
                <div {...stylex.props(styles.emptyCard)}>
                  <Empty
                    icon="sparkles"
                    title="This board is empty"
                    hint={
                      canWrite ? (
                        <>
                          Add your first issue, or start from a sample board —
                          nine issues in one <Code>db.transact</Code>.
                        </>
                      ) : cls === "viewer" ? (
                        "You are a viewer here — issues will appear as members add them."
                      ) : undefined
                    }
                    actions={
                      canWrite ? (
                        <>
                          <Button
                            variant="primary"
                            onClick={() =>
                              void run(
                                seedSampleIssues(db, myEid, labels.rows ?? []),
                              )
                            }
                          >
                            <Icon name="sparkles" size={14} /> Add sample issues
                          </Button>
                          <Button onClick={() => setDraftStatus("todo")}>
                            <Icon name="plus" size={14} /> New issue
                          </Button>
                        </>
                      ) : undefined
                    }
                  />
                </div>
              </div>
            )}
          </div>
          {selectedRow !== undefined && (
            <IssueDetail
              db={db}
              row={selectedRow}
              myEid={myEid}
              cls={cls}
              labels={labels.rows ?? []}
              people={people.rows ?? []}
              onClose={() => setSelected(null)}
            />
          )}
        </div>
      )}

      {draftStatus !== null && (
        <NewIssueDialog
          status={draftStatus}
          people={people.rows ?? []}
          onClose={() => setDraftStatus(null)}
          onSubmit={(draft) => {
            if (myEid === undefined) {
              toast("error", "viewers cannot create issues");
              return;
            }
            const column = liveRows.filter((r) => r.status === draft.status);
            void run(
              createIssue(db, myEid, column[column.length - 1]?.rank, draft),
            );
            setDraftStatus(null);
          }}
        />
      )}

      {invite && user !== undefined && (
        <InviteDialog slug={slug} user={user} onClose={() => setInvite(false)} />
      )}
    </div>
  );
};

// ── time travel ──────────────────────────────────────────────────────────────

/**
 * The immutability demo, hooks-shaped: `useBasis(db)` is the slider's
 * ceiling, every scrub is `useQuery(db.asOf(t), boardQuery)` — the view is
 * structural, so the inline `db.asOf(t)` re-runs per `t`, not per render —
 * and the graveyard is `useQuery(db.history, everyIssueEverQuery)` minus the
 * issues still alive.
 */
const TimeTravelView = ({
  db,
  liveRows,
  onExit,
}: {
  db: ReefDb;
  liveRows: readonly BoardRow[];
  onExit: () => void;
}) => {
  const maxT = useBasis(db);
  const [scrubbed, setScrubbed] = useState<number | null>(null);
  const t = scrubbed ?? maxT;
  // Until the basis lands, read the live view — the same rows the board
  // already shows — so the hook order never varies.
  const past = useQuery(t === undefined ? db : db.asOf(t), boardQuery);
  const everything = useQuery(db.history, everyIssueEverQuery);

  if (t === undefined || maxT === undefined) {
    return <Loading text="reading basis…" />;
  }
  const live = new Set(liveRows.map((r) => r.id));
  const deleted = (everything.data ?? []).filter((r) => !live.has(r.id));
  return (
    <>
      <TimeTravelBar
        t={t}
        maxT={maxT}
        deleted={deleted}
        onScrub={setScrubbed}
        onExit={onExit}
      />
      <div {...stylex.props(styles.pastNotice)}>
        <Icon name="eye" size={12} />
        Read-only view as of transaction {t}. Same queries, pinned basis —
        nothing was copied.
      </div>
      <div {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.boardWrap)}>
          <Board
            rows={past.data ?? liveRows}
            readOnly
            canCreate={false}
            selectedId={null}
            onSelect={() => {}}
            onNew={() => {}}
            onMove={() => {}}
          />
        </div>
      </div>
    </>
  );
};

// ── new issue ────────────────────────────────────────────────────────────────

const NewIssueDialog = ({
  status,
  people,
  onClose,
  onSubmit,
}: {
  status: Status;
  people: readonly { id: number; name: string }[];
  onClose: () => void;
  onSubmit: (draft: NewIssue) => void;
}) => {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(0);
  const [assignee, setAssignee] = useState("");
  return (
    <Dialog
      title={
        <>
          New issue
          <Tag>
            <span
              {...stylex.props(styles.statusDot)}
              style={{ backgroundColor: COLUMN_TINTS[status] }}
            />
            {STATUS_LABELS[status]}
          </Tag>
        </>
      }
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() === "") return;
          onSubmit({
            title: title.trim(),
            description: description.trim(),
            status,
            priority,
            assigneeId: assignee === "" ? undefined : Number(assignee),
          });
        }}
      >
        <Field label="Title">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            autoFocus
            required
          />
        </Field>
        <Field label="Description">
          <TextArea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="optional"
          />
        </Field>
        <Field label="Priority">
          <div {...stylex.props(styles.segmented)} role="radiogroup" aria-label="Priority">
            {PRIORITIES.map((p, i) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={priority === i}
                title={p}
                {...stylex.props(styles.segment, priority === i && styles.segmentOn)}
                onClick={() => setPriority(i)}
              >
                <PriorityIcon level={i} size={14} />
                {i === 0 ? "None" : p}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Assignee">
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Create issue
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
};

// ── invite ───────────────────────────────────────────────────────────────────

const InviteDialog = ({
  slug,
  user,
  onClose,
}: {
  slug: string;
  user: SessionUser;
  onClose: () => void;
}) => {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("member");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const orgs = await listWorkspaces();
      const org = orgs.find((o) => o.slug === slug);
      if (org === undefined) throw new Error(`no organization for ${slug}`);
      await inviteMember(org.id, email.trim(), role);
      toast("success", `Invited ${email.trim()} as ${role} — they accept from their workspace screen`);
      onClose();
    } catch (err) {
      toast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Invite to this workspace" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            autoFocus
            required
          />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {INVITABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {r === "viewer"
                  ? "viewer — read-only by policy"
                  : r === "member"
                    ? "member — can edit issues"
                    : r}
              </option>
            ))}
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            <Icon name="send" size={13} /> Send invite
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
};
