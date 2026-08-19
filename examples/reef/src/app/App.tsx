/**
 * Session-gated shell: Better Auth session → workspace picker → board.
 * Plain state routing (SPA, no RSC). The active workspace's Ramose client is
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
  useLayoutEffect,
  useState,
} from "react";
import { authClient, type SessionUser } from "./auth.ts";
import { openWorkspace, RAMOSE_URL, type Workspace } from "./ramose.ts";
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
          <Root />
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
  const [open, setOpen] = useState<Open | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const enter = useCallback(
    async (slug: string, name: string, user: SessionUser, provision = false) => {
      setOpening(slug);
      try {
        setOpen({ workspace: await openWorkspace(slug, user, provision), name });
      } catch (err) {
        toast("error", errorMessage(err));
      } finally {
        setOpening(null);
      }
    },
    [toast],
  );

  if (session.isPending) return <Loading />;
  const user = session.data?.user;
  if (user === undefined) return <AuthScreen />;
  const me: SessionUser = { id: user.id, name: user.name, email: user.email };

  if (open !== null) {
    return (
      <RamoseProvider
        key={open.workspace.slug}
        url={RAMOSE_URL}
        token={open.workspace.token}
      >
        <BoardScreen
          workspace={open.workspace}
          name={open.name}
          user={me}
          onLeave={() => setOpen(null)}
        />
      </RamoseProvider>
    );
  }
  return (
    <WorkspacesScreen
      user={me}
      opening={opening}
      onOpen={(slug, name) => void enter(slug, name, me)}
      onCreate={(slug, name) => void enter(slug, name, me, true)}
    />
  );
};
