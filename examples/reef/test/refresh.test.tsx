/**
 * Refresh must not wait on get-session or the first `useLive` emission.
 * A slug mounts the Provider / board tree immediately; `rows === undefined`
 * paints the shell, not `opening ${slug}`. `/` can still wait on session.
 *
 * Reef styles are StyleX (`defineVars`) and only compile under Vite, so
 * these pins read the source the App actually ships — same shape as the
 * follower specifier pin — rather than rendering the tree in bun:test.
 */

import { describe, expect, test } from "bun:test";

const appSrc = () =>
  Bun.file(new URL("../src/app/App.tsx", import.meta.url)).text();
const boardSrc = () =>
  Bun.file(new URL("../src/app/screens/BoardScreen.tsx", import.meta.url)).text();

describe("refresh does not wait on session or the first live emission", () => {
  test("a slug mounts the Provider / board tree without awaiting get-session", async () => {
    const src = await appSrc();
    const slugBranch = src.indexOf(
      "if (wantedSlug !== null && workspace !== null)",
    );
    const pendingLoader = src.indexOf(
      "if (session.isPending) return <Loading />",
    );
    expect(slugBranch).toBeGreaterThan(-1);
    expect(pendingLoader).toBeGreaterThan(slugBranch);
    expect(src.slice(0, slugBranch)).not.toMatch(
      /if \(session\.isPending\) return <Loading \/>/,
    );
    expect(src).toMatch(/mintWorkspace\(wantedSlug\)/);
    expect(src).toMatch(/<RamoseProvider/);
    expect(src).toMatch(/<BoardScreen/);
    // Token / org name fill in after paint; first paint does not await them.
    expect(src).toMatch(/if \(userId === undefined\) return;/);
  });

  test("BoardScreen with rows === undefined does not render opening ${slug}", async () => {
    const src = await boardSrc();
    expect(src).not.toMatch(/opening \$\{slug\}/);
    expect(src).not.toMatch(/if \(liveRows === undefined\)/);
    expect(src).toMatch(/liveRows \?\? \[\]/);
    expect(src).toMatch(/liveRows !== undefined && liveRows\.length === 0/);
    expect(src).toMatch(/bindSelf/);
  });

  test("a first visit to / still waits on session; no user on a slug bounces to Auth", async () => {
    const src = await appSrc();
    const slugBranch = src.indexOf(
      "if (wantedSlug !== null && workspace !== null)",
    );
    const pendingLoader = src.indexOf(
      "if (session.isPending) return <Loading />",
    );
    expect(pendingLoader).toBeGreaterThan(slugBranch);
    expect(src).toMatch(
      /if \(!session\.isPending && user === undefined\) return <AuthScreen \/>/,
    );
  });
});
