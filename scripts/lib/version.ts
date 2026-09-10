const NUMERIC = "(?:0|[1-9][0-9]*)";
const PRERELEASE = `(?:${NUMERIC}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const VERSION = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE}(?:\\.${PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export const isReleaseVersion = (version: string): boolean => version.trim() === version && VERSION.test(version);

export const VERSION_FILES = ["package.json", "packages/ramose/package.json", "bun.lock"] as const;

export const updateLockfileVersion = (contents: string, version: string): string => {
  if (!isReleaseVersion(version)) throw new Error(`invalid version: ${version}`);
  const updated = contents.replace(
    /("packages\/ramose"\s*:\s*\{[^}]*?"version"\s*:\s*")[^"]*(")/,
    (_, prefix: string, suffix: string) => `${prefix}${version}${suffix}`,
  );
  const lock = Bun.JSONC.parse(updated) as { workspaces: Record<string, { version?: string }> };
  if (lock.workspaces["packages/ramose"]?.version !== version) {
    throw new Error("cannot update the ramose workspace version in bun.lock");
  }
  return updated;
};
