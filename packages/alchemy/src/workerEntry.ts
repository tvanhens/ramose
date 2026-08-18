/**
 * `Ramose.workerEntry()` — where `@ramose/worker` actually lives on disk.
 *
 * `Cloudflare.Worker`'s `main` is a **path**, not a module specifier: Alchemy
 * `realpath`s it before handing it to the bundler. So the obvious spelling
 *
 * ```typescript
 * Cloudflare.Worker("Peer", { main: "@ramose/worker" })   // ✗ never resolves
 * ```
 *
 * resolves against the working directory (`./@ramose/worker`), which does not
 * exist. Inside this repository nobody noticed, because every runnable stack
 * points `main` at `./packages/worker/src/index.ts`; from npm it is the only
 * spelling a reader has. Worse, the failure is silent — Alchemy's bundle
 * watcher runs in a forked fiber, so under `alchemy dev` the Worker's proxy
 * still binds its port and logs `ready`, and every request to it hangs.
 *
 * ```typescript
 * import * as Ramose from "@ramose/alchemy/workerEntry";
 *
 * Cloudflare.Worker("Peer", { main: Ramose.workerEntry() })   // ✓
 * ```
 *
 * `import.meta.resolve("@ramose/worker")` is the same thing written inline and
 * is equally correct; this exists so the resolution has one home, one error
 * message worth reading, and a test.
 *
 * @module
 *
 * Deliberately **not** on the `@ramose/alchemy` barrel. That barrel is imported
 * by Worker and browser code (`ReadWriteDatabases`, `ServerHttp`, `Policy`),
 * and `import.meta.resolve` is a host API with no meaning in either — keeping
 * it on its own subpath keeps it out of every bundle that is not a deploy
 * script.
 */

/** The package whose entry this resolves — the Ramose peer Worker. */
const PEER_PACKAGE = "@ramose/worker";

/**
 * The absolute `file://` URL of the `@ramose/worker` entry module, ready to
 * hand to `Cloudflare.Worker`'s `main`.
 *
 * Which file that is depends on the host's export conditions — `src/index.ts`
 * under Bun, `dist/index.js` under Node — and either bundles identically.
 *
 * @throws when `@ramose/worker` is not installed. It is a peer of the deploy
 * script, not of this package: `@ramose/alchemy` is also what a Worker and a
 * browser import, and neither should drag the server's code in behind them.
 */
export const workerEntry = (): string => {
  try {
    return import.meta.resolve(PEER_PACKAGE);
  } catch (cause) {
    throw new Error(
      `ramose: cannot resolve ${PEER_PACKAGE} — the Ramose server Worker is a separate package. Install it next to @ramose/alchemy (\`npm install ${PEER_PACKAGE}\`), or point \`main\` at your own module that re-exports it.`,
      { cause },
    );
  }
};
