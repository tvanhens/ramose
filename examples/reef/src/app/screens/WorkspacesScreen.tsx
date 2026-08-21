/**
 * Pick, create or join a workspace. Creating one is the multi-tenancy demo:
 * a Better Auth org + `db.install()` on a brand-new database name — no
 * provisioning, no deploy, ready in one round trip.
 */

import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../App.tsx";
import {
  acceptInvitation,
  authClient,
  createWorkspace,
  listMyInvitations,
  listWorkspaces,
  type Invitation,
  type OrgSummary,
  type SessionUser,
} from "../auth.ts";
import { Link } from "../route.tsx";
import { isWorkspaceSlug, slugify } from "../../domain/shared.ts";
import { colors, radii, space, type } from "../theme/tokens.stylex";
import {
  Avatar,
  Button,
  Code,
  Empty,
  Field,
  Icon,
  IconButton,
  Input,
  Loading,
  Logo,
  Spinner,
  Tag,
  hueOf,
  initialsOf,
  useToast,
} from "../ui.tsx";

const styles = stylex.create({
  page: {
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  topbar: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.xl,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.bgRaised,
  },
  spacer: { flexGrow: 1 },
  who: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    fontSize: type.sm,
    color: colors.textMuted,
  },
  whoName: { color: colors.text, fontWeight: 600 },
  content: {
    width: "min(600px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
    paddingTop: "7vh",
    paddingBottom: space.xxl,
    paddingInline: space.xl,
  },
  headerText: { display: "flex", flexDirection: "column", gap: space.xs },
  hello: {
    margin: 0,
    fontSize: type.xxl,
    fontWeight: 800,
    letterSpacing: "-0.02em",
  },
  sub: { margin: 0, color: colors.textMuted, fontSize: type.md, lineHeight: 1.5 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.lg,
    boxShadow: colors.shadowSm,
    padding: space.xl,
  },
  cardHead: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    marginBottom: space.md,
  },
  cardTitle: {
    margin: 0,
    fontSize: type.xs,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: colors.textMuted,
    flexGrow: 1,
  },
  list: { display: "flex", flexDirection: "column", gap: space.sm },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    width: "100%",
    textAlign: "left",
    paddingBlock: "10px",
    paddingInline: space.md,
    borderRadius: radii.md,
    backgroundColor: { default: colors.bgRaised, ":hover": colors.surfaceHover },
    backgroundImage: "none",
    textDecoration: "none",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": colors.borderStrong },
    cursor: { default: "pointer", ":disabled": "default" },
    color: colors.text,
    outline: "none",
    boxShadow: { default: "none", ":focus-visible": `0 0 0 3px ${colors.ring}` },
    transition: "background-color 120ms ease, border-color 120ms ease",
  },
  tile: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "34px",
    height: "34px",
    borderRadius: radii.sm,
    color: "#fff",
    fontWeight: 700,
    fontSize: type.sm,
    flexShrink: 0,
    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)",
  },
  rowText: { display: "flex", flexDirection: "column", gap: "2px", flexGrow: 1, minWidth: 0 },
  rowName: { fontWeight: 600, fontSize: type.md },
  rowSlug: {
    color: colors.textFaint,
    fontFamily: type.mono,
    fontSize: type.xs,
  },
  rowAction: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    color: colors.textMuted,
    fontSize: type.sm,
    fontWeight: 600,
  },
  createRow: { display: "flex", gap: space.md, alignItems: "flex-start" },
  grow: { flexGrow: 1 },
  slugPreview: {
    marginTop: "-6px",
    fontSize: type.xs,
    color: colors.textFaint,
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    minHeight: "20px",
  },
  createBtnWrap: { paddingTop: "22px" },
});

export const WorkspacesScreen = ({
  user,
  opening,
  onOpen,
  onCreate,
}: {
  user: SessionUser;
  opening: string | null;
  onOpen: (slug: string, name: string) => void;
  onCreate: (slug: string, name: string) => void | Promise<void>;
}) => {
  const toast = useToast();
  const [orgs, setOrgs] = useState<readonly OrgSummary[] | null>(null);
  const [invites, setInvites] = useState<readonly Invitation[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const slug = slugify(name);

  const refresh = async () => {
    // Invitations are best-effort: some Better Auth configurations gate the
    // route (e.g. unverified email → 403) and that must not block the picker.
    const [os, is] = await Promise.all([
      listWorkspaces(),
      listMyInvitations().catch(() => [] as readonly Invitation[]),
    ]);
    setOrgs(os);
    setInvites(is.filter((i) => i.status === "pending"));
  };

  useEffect(() => {
    refresh().catch((err) =>
      toast("error", err instanceof Error ? err.message : String(err)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    if (!isWorkspaceSlug(slug)) {
      // Two failure modes, one check: too short to be a database name, or a
      // slug the deployed demo reserves for its own paths (see RESERVED_SLUGS).
      toast(
        "error",
        slug.length < 2
          ? "workspace names need at least two letters or digits"
          : `"${slug}" is reserved — pick another workspace name`,
      );
      return;
    }
    setBusy(true);
    try {
      await createWorkspace(name.trim(), slug);
      await onCreate(slug, name.trim());
    } catch (err) {
      toast("error", err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const accept = async (invite: Invitation) => {
    setBusy(true);
    try {
      await acceptInvitation(invite.id);
      const all = await listWorkspaces();
      setOrgs(all);
      const org = all.find((o) => o.id === invite.organizationId);
      if (org) onOpen(org.slug, org.name);
      else await refresh();
    } catch (err) {
      toast("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const firstName = user.name.split(/\s+/)[0] ?? user.name;

  return (
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.topbar)}>
        <Logo size={24} />
        <span {...stylex.props(styles.spacer)} />
        <span {...stylex.props(styles.who)}>
          <Avatar name={user.name} size="sm" />
          <span {...stylex.props(styles.whoName)}>{user.name}</span>
        </span>
        <ThemeToggle />
        <IconButton
          icon="logout"
          label="Sign out"
          onClick={() => void authClient.signOut()}
        />
      </div>

      {orgs === null ? (
        <Loading text="loading workspaces…" />
      ) : (
        <div {...stylex.props(styles.content)}>
          <div {...stylex.props(styles.headerText)}>
            <h1 {...stylex.props(styles.hello)}>Hi, {firstName}</h1>
            <p {...stylex.props(styles.sub)}>
              Pick a workspace to open its board. Every workspace is its own
              Ramose database — <Code>ramose.db(slug)</Code> — created on the
              spot, no deploy.
            </p>
          </div>

          {invites.length > 0 && (
            <section {...stylex.props(styles.card)}>
              <div {...stylex.props(styles.cardHead)}>
                <h2 {...stylex.props(styles.cardTitle)}>Invitations</h2>
                <Tag tone="accent">{invites.length}</Tag>
              </div>
              <div {...stylex.props(styles.list)}>
                {invites.map((invite) => (
                  <div key={invite.id} {...stylex.props(styles.row)}>
                    <span
                      {...stylex.props(styles.tile)}
                      style={{
                        backgroundColor: `hsl(${hueOf(invite.organizationName ?? invite.organizationId)} 46% 46%)`,
                      }}
                    >
                      {initialsOf(invite.organizationName ?? invite.organizationId)}
                    </span>
                    <span {...stylex.props(styles.rowText)}>
                      <span {...stylex.props(styles.rowName)}>
                        {invite.organizationName ?? invite.organizationId}
                      </span>
                      <span {...stylex.props(styles.rowSlug)}>
                        invited as {invite.role}
                      </span>
                    </span>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void accept(invite)}
                    >
                      Accept &amp; open
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section {...stylex.props(styles.card)}>
            <div {...stylex.props(styles.cardHead)}>
              <h2 {...stylex.props(styles.cardTitle)}>Your workspaces</h2>
              {orgs.length > 0 && <Tag>{orgs.length}</Tag>}
            </div>
            {orgs.length === 0 ? (
              <Empty
                icon="database"
                title="No workspaces yet"
                hint="Create one below — it is one install() and one transaction."
              />
            ) : (
              <div {...stylex.props(styles.list)}>
                {orgs.map((org) => {
                  const isOpening = opening === org.slug;
                  return (
                    <Link
                      key={org.id}
                      to={{ kind: "board", slug: org.slug }}
                      {...stylex.props(styles.row)}
                      aria-disabled={opening !== null}
                      onClick={(e) => {
                        if (opening !== null) e.preventDefault();
                      }}
                    >
                      <span
                        {...stylex.props(styles.tile)}
                        style={{ backgroundColor: `hsl(${hueOf(org.slug)} 46% 46%)` }}
                      >
                        {initialsOf(org.name)}
                      </span>
                      <span {...stylex.props(styles.rowText)}>
                        <span {...stylex.props(styles.rowName)}>{org.name}</span>
                        <span {...stylex.props(styles.rowSlug)}>db/{org.slug}</span>
                      </span>
                      <span {...stylex.props(styles.rowAction)}>
                        {isOpening ? (
                          <>
                            <Spinner /> opening
                          </>
                        ) : (
                          <>
                            Open <Icon name="chevronRight" size={14} />
                          </>
                        )}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          <section {...stylex.props(styles.card)}>
            <div {...stylex.props(styles.cardHead)}>
              <h2 {...stylex.props(styles.cardTitle)}>New workspace</h2>
            </div>
            <form
              {...stylex.props(styles.createRow)}
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <div {...stylex.props(styles.grow)}>
                <Field label="Name">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Coral Team"
                    required
                  />
                </Field>
                <div {...stylex.props(styles.slugPreview)}>
                  {slug !== "" ? (
                    <>
                      <Icon name="arrowRight" size={11} />
                      <Code>ramose.db(&quot;{slug}&quot;).install()</Code>
                    </>
                  ) : (
                    "the name becomes the database"
                  )}
                </div>
              </div>
              <div {...stylex.props(styles.createBtnWrap)}>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={busy || opening !== null}
                >
                  {busy ? (
                    <Spinner onAccent />
                  ) : (
                    <>
                      <Icon name="plus" size={14} /> Create
                    </>
                  )}
                </Button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
};
