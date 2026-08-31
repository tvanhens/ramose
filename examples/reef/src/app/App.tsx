import { Suspense, useEffect, useMemo, useState } from "react";
import { RamoseProvider, useSyncState } from "ramose/react";
import {
  authClient,
  clearCachedUser,
  dropToken,
  readCachedUser,
  writeCachedUser,
  type CachedUser,
} from "./auth.ts";
import { openReef, type ReefClient } from "./ramose.ts";
import { AuthScreen } from "./screens/AuthScreen.tsx";
import { BoardScreen } from "./screens/BoardScreen.tsx";
import { WorkspacesScreen } from "./screens/WorkspacesScreen.tsx";

type Route = { readonly screen: "workspaces" } | {
  readonly screen: "board";
  readonly slug: string;
};

const routeOf = (hash: string): Route => {
  const match = /^#\/w\/([a-z0-9][a-z0-9-]*)$/.exec(hash);
  return match ? { screen: "board", slug: match[1]! } : { screen: "workspaces" };
};

const useRoute = (): Route => {
  const [route, setRoute] = useState<Route>(() => routeOf(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(routeOf(location.hash));
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return route;
};

const SYNC_LABELS: Record<string, string> = {
  idle: "Idle",
  connecting: "Connecting",
  live: "Live",
  stale: "Stale",
  offline: "Offline",
  "update-required": "Update required",
  "authentication-required": "Sign in again",
  closed: "Closed",
};

const SyncBadge = () => {
  const sync = useSyncState();
  return (
    <span className={`sync sync-${sync.status}`} title={`Sync: ${sync.status}`}>
      <span className="sync-dot" />
      {SYNC_LABELS[sync.status] ?? sync.status}
    </span>
  );
};

const Shell = (props: {
  readonly client: ReefClient;
  readonly userName: string;
  readonly onSignOut: () => void;
}) => {
  const route = useRoute();
  useEffect(() => {
    props.client.open().mutate.ensureMe({}).queued.catch(() => undefined);
  }, [props.client]);
  return (
    <RamoseProvider client={props.client}>
      <div className="shell">
        <header className="topbar">
          <a className="brand" href="#/">
            Reef
          </a>
          <div className="topbar-right">
            <SyncBadge />
            <span className="whoami">{props.userName}</span>
            <button className="ghost" onClick={props.onSignOut}>
              Sign out
            </button>
          </div>
        </header>
        <Suspense fallback={<div className="loading">Loading…</div>}>
          {route.screen === "board"
            ? <BoardScreen key={route.slug} slug={route.slug} />
            : <WorkspacesScreen />}
        </Suspense>
      </div>
    </RamoseProvider>
  );
};

export const App = () => {
  const session = authClient.useSession();
  const [cached] = useState(readCachedUser);

  const settledOut = !session.isPending && session.data == null &&
    session.error == null;
  const user: CachedUser | undefined = session.data?.user ??
    (settledOut ? undefined : cached);
  const userId = user?.id;

  useEffect(() => {
    if (session.data?.user !== undefined) {
      const { id, name, email } = session.data.user;
      writeCachedUser({
        id,
        ...(name ? { name } : {}),
        ...(email ? { email } : {}),
      });
    } else if (settledOut) {
      clearCachedUser();
    }
  }, [session.data?.user, settledOut]);

  const client = useMemo(
    () => (userId === undefined ? undefined : openReef(userId)),
    [userId],
  );
  useEffect(() => {
    if (client === undefined) return;
    return () => {
      client.close().catch(() => undefined);
    };
  }, [client]);

  if (client === undefined || userId === undefined) {
    return session.isPending
      ? <div className="loading">Loading…</div>
      : <AuthScreen />;
  }
  return (
    <Shell
      client={client}
      userName={user?.name || user?.email || "Signed in"}
      onSignOut={() => {
        dropToken(userId);
        clearCachedUser();
        void authClient.signOut().finally(() => {
          location.hash = "";
          location.reload();
        });
      }}
    />
  );
};
