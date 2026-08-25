/**
 * Session-gated shell: Better Auth session → workspace picker → board.
 * Paths are the pages (`/`, `/:slug`, `/:slug/issues/:id`) so refresh and a
 * shared URL land on the same screen. The active workspace's Ramose client is
 * owned by `<RamoseProvider key={slug}>`: switching workspaces changes the
 * key, which closes the old client and connects the next one.
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
  useState,
} from "react";
import { authClient, listWorkspaces, type SessionUser } from "./auth.ts";
import { openWorkspace, RAMOSE_URL, type Workspace } from "./ramose.ts";
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

type Theme = "dark" | "light";

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

const useTheme = () => useContext(ThemeContext);

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

interface Open {
  readonly workspace: Workspace;
  /** Display name (the Better Auth organization name); the slug is the db. */
  readonly name: string;
}

const Root = () => {
  const session = authClient.useSession();
  const toast = useToast();
  const { route, navigate } = useRoute();
  const [open, setOpen] = useState<Open | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const user = session.data?.user;
  const userId = user?.id;
  const userName = user?.name;
  const userEmail = user?.email;
  const wantedSlug = route.kind === "board" ? route.slug : null;
  const loadedSlug = open?.workspace.slug ?? null;

  useEffect(() => {
    if (wantedSlug === null) {
      setOpen(null);
      return;
    }
    if (userId === undefined || userName === undefined || userEmail === undefined) {
      return;
    }
    if (loadedSlug === wantedSlug) return;
    let cancelled = false;
    setOpening(wantedSlug);
    void (async () => {
      try {
        const orgs = await listWorkspaces().catch(() => []);
        if (cancelled) return;
        const org = orgs.find((o) => o.slug === wantedSlug);
        const workspace = await openWorkspace(wantedSlug, false);
        if (cancelled) return;
        setOpen({ workspace, name: org?.name ?? wantedSlug });
      } catch (err) {
        if (cancelled) return;
        toast("error", errorMessage(err));
        setOpen(null);
        navigate({ kind: "home" }, { replace: true });
      } finally {
        if (!cancelled) setOpening(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantedSlug, loadedSlug, userId, userName, userEmail, toast, navigate]);

  const createAndOpen = useCallback(
    async (slug: string) => {
      try {
        await openWorkspace(slug, true);
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

  if (wantedSlug !== null) {
    if (open !== null && open.workspace.slug === wantedSlug) {
      return (
        <>
          {/* docs:ramose-provider */}
          <RamoseProvider
            key={open.workspace.slug}
            url={RAMOSE_URL}
            token={open.workspace.token}
          >
          {/* enddocs:ramose-provider */}
            <BoardScreen
              workspace={open.workspace}
              name={open.name}
              user={me}
              onLeave={() => navigate({ kind: "home" })}
            />
          </RamoseProvider>
        </>
      );
    }
    return <Loading text={`opening ${wantedSlug}…`} />;
  }

  return (
    <WorkspacesScreen
      user={me}
      opening={opening}
      onOpen={(slug) => navigate({ kind: "board", slug })}
      onCreate={(slug) => createAndOpen(slug)}
    />
  );
};
