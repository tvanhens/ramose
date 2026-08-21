/**
 * Session-gated shell: Better Auth session → workspace picker → board.
 * Paths are the pages (`/`, `/:slug`, `/:slug/issues/:id`) so refresh and a
 * shared URL land on the same screen. A slug mounts `<RamoseProvider
 * key={slug}>` immediately — first paint is hydrate, not `get-session` or
 * a JWT loader. `useSession` is a sibling of `BoardScreen` so get-session
 * / mint cannot delay `useLive`. Token is lazy (`mintWorkspace`). When the session settles:
 * a user `bindSelf`s after paint; no user bounces to Auth. `/` (no slug)
 * still waits on session. Switching workspaces changes the key, which
 * closes the old client and connects the next one. `cls` is unknown until
 * claims return — never a `"viewer"` placeholder. Org name fills in after.
 *
 * Theme: the StyleX theme class goes on `<html>` (not the app root) so the
 * token overrides also reach UI portaled to `document.body` — dialogs and
 * toasts — and `color-scheme` follows it so native controls and scrollbars
 * match. The choice is persisted; first visit follows the OS.
 */

import { errorMessage, RamoseProvider } from "ramose/react";
import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { authClient, listWorkspaces, type SessionUser } from "./auth.ts";
import {
  mintWorkspace,
  openWorkspace,
  RAMOSE_URL,
  type Workspace,
} from "./ramose.ts";
import type { RamoseClass } from "../domain/shared.ts";
import { RouteProvider, useRoute } from "./route.tsx";
import { AuthScreen } from "./screens/AuthScreen.tsx";
import { BoardScreen } from "./screens/BoardScreen.tsx";
import { WorkspacesScreen } from "./screens/WorkspacesScreen.tsx";
import { colors, type } from "./theme/tokens.stylex";
import { light } from "./theme/themes.stylex";
import { IconButton, Loading, ToastProvider, useToast } from "./ui.tsx";

const app = stylex.create({
  html: {
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: type.family,
    fontSize: type.md,
  },
  root: {
    minHeight: "100%",
    display: "flex",
    flexDirection: "column",
    backgroundColor: colors.bg,
    color: colors.text,
  },
});

export type Theme = "dark" | "light";

const THEME_KEY = "reef.theme";

const initialTheme = (): Theme => {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // storage unavailable — fall through to the OS preference
  }
  return typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
};

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "dark",
  toggle: () => {},
});

export const useTheme = () => useContext(ThemeContext);

/** The sun/moon toggle, usable on any screen. */
export const ThemeToggle = () => {
  const { theme, toggle } = useTheme();
  return (
    <IconButton
      icon={theme === "dark" ? "sun" : "moon"}
      label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggle}
    />
  );
};

export const App = () => {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const toggle = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [],
  );

  useLayoutEffect(() => {
    const { className } = stylex.props(app.html, theme === "light" && light);
    const html = document.documentElement;
    html.className = className ?? "";
    html.style.colorScheme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore — the theme still applies for this session
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, toggle }}>
      <div {...stylex.props(app.root)}>
        <ToastProvider>
          <RouteProvider>
            <Root />
          </RouteProvider>
        </ToastProvider>
      </div>
    </ThemeContext.Provider>
  );
};

const Root = () => {
  const { route, navigate } = useRoute();
  const wantedSlug = route.kind === "board" ? route.slug : null;
  // A slug mounts the Provider in this component — `useSession` lives
  // in a sibling so get-session / mint cannot suspend or delay
  // `useLive`. First paint is hydrate.
  if (wantedSlug !== null) {
    return (
      <SlugBoard
        slug={wantedSlug}
        onLeave={() => navigate({ kind: "home" })}
      />
    );
  }
  return <Home />;
};

const SlugBoard = ({
  slug,
  onLeave,
}: {
  slug: string;
  onLeave: () => void;
}) => {
  const workspace = useMemo(() => mintWorkspace(slug), [slug]);
  const [name, setName] = useState(slug);
  const [cls, setCls] = useState<RamoseClass | undefined>(undefined);
  const [user, setUser] = useState<SessionUser | undefined>(undefined);
  const [needAuth, setNeedAuth] = useState(false);
  const onNeedAuth = useCallback(() => setNeedAuth(true), []);

  if (needAuth) return <AuthScreen />;

  return (
    <RamoseProvider key={slug} url={RAMOSE_URL} token={workspace.token}>
      <BoardScreen
        workspace={{ ...workspace, cls }}
        name={name}
        user={user}
        onLeave={onLeave}
      />
      <BoardSession
        slug={slug}
        workspace={workspace}
        onName={setName}
        onCls={setCls}
        onUser={setUser}
        onNeedAuth={onNeedAuth}
      />
    </RamoseProvider>
  );
};

/** Session / JWT / org name — after the board is in the tree. */
const BoardSession = ({
  slug,
  workspace,
  onName,
  onCls,
  onUser,
  onNeedAuth,
}: {
  slug: string;
  workspace: Workspace;
  onName: (name: string) => void;
  onCls: (cls: RamoseClass | undefined) => void;
  onUser: (user: SessionUser | undefined) => void;
  onNeedAuth: () => void;
}) => {
  const session = authClient.useSession();
  const toast = useToast();
  const user = session.data?.user;
  const userId = user?.id;

  useEffect(() => {
    if (!session.isPending && user === undefined) onNeedAuth();
  }, [session.isPending, user, onNeedAuth]);

  useEffect(() => {
    if (user === undefined) {
      onUser(undefined);
      return;
    }
    onUser({ id: user.id, name: user.name, email: user.email });
  }, [user, onUser]);

  useEffect(() => {
    if (userId === undefined) return;
    let cancelled = false;
    void (async () => {
      const orgs = await listWorkspaces().catch(() => []);
      if (cancelled) return;
      const org = orgs.find((o) => o.slug === slug);
      if (org !== undefined) onName(org.name);
      try {
        const claims = await workspace.token.claims();
        if (cancelled) return;
        onCls((claims.ramose?.class ?? "viewer") as RamoseClass);
      } catch (err) {
        if (cancelled) return;
        toast("error", errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, workspace, userId, onName, onCls, toast]);

  return null;
};

const Home = () => {
  const session = authClient.useSession();
  const toast = useToast();
  const { navigate } = useRoute();
  const user = session.data?.user;

  const createAndOpen = useCallback(
    async (slug: string, user: SessionUser) => {
      try {
        await openWorkspace(slug, user, true);
        navigate({ kind: "board", slug });
      } catch (err) {
        toast("error", errorMessage(err));
        throw err;
      }
    },
    [toast, navigate],
  );

  if (session.isPending) return <Loading />;
  if (user === undefined) return <AuthScreen />;
  const me: SessionUser = { id: user.id, name: user.name, email: user.email };

  return (
    <WorkspacesScreen
      user={me}
      opening={null}
      onOpen={(slug) => navigate({ kind: "board", slug })}
      onCreate={(slug) => createAndOpen(slug, me)}
    />
  );
};
