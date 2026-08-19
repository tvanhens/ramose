/**
 * Shared per-file setup: the happy-dom globals (guarded, so file order does
 * not matter) and the one fixture catalog the hook tests share.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll } from "bun:test";
import * as Ramose from "../../src/db/index.ts";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";
import { RamoseProvider } from "../../src/react/index.ts";
import type { FakePeer } from "./peer.ts";

/** Call at file top level, before any test renders. */
export const registerDom = (): void => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  // keep happy-dom's globals out of the rest of the bun test run
  afterAll(() => {
    if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
  });
};

export const Todo = Ramose.Namespace("todo", {
  title: Ramose.Attr(Schema.String),
  slug: Ramose.Attr(Schema.String, { unique: "identity" }),
});
export const Todos = Ramose.Catalog({ todo: Todo });
export const titles = Ramose.query(Todo).select({ title: Todo.title });

/** A provider over the fake peer, as a `renderHook` / `render` wrapper. */
export const wrapperFor =
  (peer: FakePeer, url = "https://peer.example.com") =>
  ({ children }: { children?: ReactNode }) => (
    <RamoseProvider url={url} fetch={peer.fetch} webSocket={peer.webSocket}>
      {children}
    </RamoseProvider>
  );

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
