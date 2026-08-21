/**
 * SharedWorker entry — one follower host per origin. Tabs connect with
 * `new SharedWorker(followerWorkerUrl(), { type: "module", name: "ramose" })`
 * and speak the port protocol. The package ships this file; apps do not
 * copy it.
 */

import { defaultStore, openFollowerHost } from "./follower.ts";

const boot = async (): Promise<void> => {
  const store = await defaultStore();
  const host = openFollowerHost({ store });
  const scope = globalThis as typeof globalThis & {
    onconnect: ((ev: MessageEvent) => void) | null;
  };
  scope.onconnect = (ev: MessageEvent) => {
    const port = ev.ports[0];
    if (port === undefined) return;
    host.attach(port);
  };
};

void boot();
