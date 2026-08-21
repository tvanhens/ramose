/**
 * Session-gated shell: Better Auth session → workspace picker → board.
 * Paths are the pages (`/`, `/:slug`, `/:slug/issues/:id`) so refresh and a
 * shared URL land on the same screen. A slug mounts `<RamoseProvider
 * key={slug}>` immediately — first paint is hydrate, not `get-session` or
 * a JWT loader. Token is lazy (`mintWorkspace`). When the session settles:
 * a user `bindSelf`s after paint; no user bounces to Auth. `/` (no slug)
 * still waits on session. Switching workspaces changes the key, which
 * closes the old client and connects the next one. `cls` / org name fill
 * in after claims.
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
  const session = authClient.useSession();
  const toast = useToast();
  const { route, navigate } = useRoute();
  const user = session.data?.user;
  const userId = user?.id;
  const wantedSlug = route.kind === "board" ? route.slug : null;
  // Token is lazy. A slug mounts the Provider now — do not await
  // get-session / claims / listWorkspaces before first paint.
  const workspace = useMemo(
    () => (wantedSlug === null ? null : mintWorkspace(wantedSlug)),
    [wantedSlug],
  );
  const [name, setName] = useState(wantedSlug ?? "");
  const [cls, setCls] = useState<RamoseClass>("viewer");

  useEffect(() => {
    if (wantedSlug === null || workspace === null) {
      setName("");
      setCls("viewer");
      return;
    }
    setName(wantedSlug);
    setCls("viewer");
    if (userId === undefined) return;
    let cancelled = false;
    void (async () => {
      const orgs = await listWorkspaces().catch(() => []);
      if (cancelled) return;
      const org = orgs.find((o) => o.slug === wantedSlug);
      if (org !== undefined) setName(org.name);
      try {
        const claims = await workspace.token.claims();
        if (cancelled) return;
        setCls((claims.ramose?.class ?? "viewer") as RamoseClass);
      } catch (err) {
        if (cancelled) return;
        toast("error", errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantedSlug, workspace, userId, toast]);

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

  if (wantedSlug !== null && workspace !== null) {
    // Session settled with no user — bounce. Pending still paints the
    // board so hydrate can run; Auth is the only other slug loader.
    if (!session.isPending && user === undefined) return <AuthScreen />;
    const me =
      user === undefined
        ? undefined
        : { id: user.id, name: user.name, email: user.email };
    return (
      <RamoseProvider
        key={wantedSlug}
        url={RAMOSE_URL}
        token={workspace.token}
      >
        <BoardScreen
          workspace={{ ...workspace, cls }}
          name={name === "" ? wantedSlug : name}
          user={me}
          onLeave={() => navigate({ kind: "home" })}
        />
      </RamoseProvider>
    );
  }

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
