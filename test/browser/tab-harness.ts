/**
 * Real tabs for the browser lane. Each tab is an iframe running a module in
 * its own realm, with its own Web Locks client and IndexedDB connections, and
 * removing the frame destroys that browsing context the way closing or
 * crashing a tab does. The two sides talk over a BroadcastChannel named for
 * the tab, which is harness plumbing that nothing under test reads.
 */

type TabRequest = {
  readonly seq: number;
  readonly command: string;
  readonly payload: unknown;
};

type TabReply =
  | { readonly ready: true }
  | { readonly seq: number; readonly ok: true; readonly value: unknown }
  | { readonly seq: number; readonly ok: false; readonly error: string };

const CALL_TIMEOUT_MS = 5_000;

const channelName = (id: string): string => `ramose-tab-${id}`;

export type TabHandle = {
  readonly id: string;
  /** Run a command in the tab and wait for its reply. */
  readonly call: <A>(command: string, payload?: unknown) => Promise<A>;
  /** Destroy the browsing context with no chance to clean up. */
  readonly crash: () => void;
  /** Let the tab shut down, then destroy it. */
  readonly close: () => Promise<void>;
};

export const openTab = async (moduleUrl: string): Promise<TabHandle> => {
  const id = crypto.randomUUID();
  const channel = new BroadcastChannel(channelName(id));
  const pending = new Map<number, (reply: TabReply) => void>();
  let loaded: () => void;
  const ready = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  channel.addEventListener("message", (event) => {
    const reply = event.data as TabReply;
    if ("ready" in reply) {
      loaded();
      return;
    }
    const settle = pending.get(reply.seq);
    pending.delete(reply.seq);
    settle?.(reply);
  });
  const frame = document.createElement("iframe");
  frame.dataset.tab = id;
  frame.srcdoc = `<script type="module">import { serve } from ${
    JSON.stringify(moduleUrl)
  }; serve(${JSON.stringify(id)});<\/script>`;
  document.body.appendChild(frame);
  await ready;

  let seq = 0;
  const call = <A>(command: string, payload: unknown = {}): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      const request: TabRequest = { seq: ++seq, command, payload };
      const timer = setTimeout(() => {
        pending.delete(request.seq);
        reject(new Error(`tab ${command} did not reply`));
      }, CALL_TIMEOUT_MS);
      pending.set(request.seq, (reply) => {
        clearTimeout(timer);
        if ("ok" in reply && reply.ok) resolve(reply.value as A);
        else reject(new Error("error" in reply ? reply.error : "tab failed"));
      });
      channel.postMessage(request);
    });

  const destroy = (): void => {
    frame.remove();
    channel.close();
  };
  return {
    id,
    call,
    crash: destroy,
    close: async () => {
      await call("close").catch(() => undefined);
      destroy();
    },
  };
};

export type TabHandlers = Readonly<
  Record<string, (payload: never) => unknown | Promise<unknown>>
>;

/** Answer the parent's commands. Called by a tab module's own `serve`. */
export const serveTab = (id: string, handlers: TabHandlers): void => {
  const channel = new BroadcastChannel(channelName(id));
  channel.addEventListener("message", (event) => {
    const request = event.data as TabRequest;
    const handler = handlers[request.command];
    void (async () => {
      if (handler === undefined) {
        channel.postMessage({
          seq: request.seq,
          ok: false,
          error: `unknown command ${request.command}`,
        } satisfies TabReply);
        return;
      }
      try {
        const value = await handler(request.payload as never);
        channel.postMessage({ seq: request.seq, ok: true, value } satisfies TabReply);
      } catch (error) {
        channel.postMessage({
          seq: request.seq,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies TabReply);
      }
    })();
  });
  channel.postMessage({ ready: true } satisfies TabReply);
};
