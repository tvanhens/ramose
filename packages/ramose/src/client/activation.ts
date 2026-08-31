type EventTargetLike = {
  readonly addEventListener: (type: string, listener: () => void) => void;
  readonly removeEventListener: (type: string, listener: () => void) => void;
};

const eventTarget = (value: unknown): EventTargetLike | undefined =>
  value !== null && typeof value === "object" &&
    typeof (value as EventTargetLike).addEventListener === "function" &&
    typeof (value as EventTargetLike).removeEventListener === "function"
    ? value as EventTargetLike
    : undefined;

const hidden = (): boolean =>
  (globalThis as { readonly document?: { readonly visibilityState?: string } })
    .document?.visibilityState === "hidden";

/**
 * Run `wake` when this tab is activated again: brought back to the foreground,
 * refocused, restored from the back/forward cache, or told the device has a
 * network again.
 *
 * This is the durable-truth refresh that owes nothing to a notice. A tab that
 * received no change notice at all — because the channel is unavailable, or
 * because it was suspended while the notice was posted — reads the durable
 * records here instead, which is why a dropped notice costs latency and never
 * correctness.
 *
 * `online` is here because a tab that never lost focus never regains it: a
 * device that dropped its network and picked it up again is activated again in
 * every sense that matters, and reports it that way. A hidden tab is still
 * skipped — it is told again by `visibilitychange` when it is looked at, which
 * is the same trade every other trigger here makes.
 */
export const observeActivation = (wake: () => void): (() => void) => {
  const target = eventTarget(globalThis);
  const document = eventTarget(
    (globalThis as { readonly document?: unknown }).document,
  );
  if (target === undefined && document === undefined) return () => undefined;
  const activated = (): void => {
    if (hidden()) return;
    wake();
  };
  target?.addEventListener("focus", activated);
  target?.addEventListener("pageshow", activated);
  target?.addEventListener("online", activated);
  document?.addEventListener("visibilitychange", activated);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    target?.removeEventListener("focus", activated);
    target?.removeEventListener("pageshow", activated);
    target?.removeEventListener("online", activated);
    document?.removeEventListener("visibilitychange", activated);
  };
};
