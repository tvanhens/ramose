import { expect, test } from "bun:test";
import { isReleaseVersion } from "./version.ts";

test.each(["0.3.0", "1.0.0-rc.1", "1.0.0-0", "1.0.0-01a", "1.0.0+build.01", "1.0.0-rc.1+sha.abc"])(
  "accepts release version %s", (version) => expect(isReleaseVersion(version)).toBe(true),
);

test.each(["v1.0.0", "01.0.0", "1.01.0", "1.0.01", "1.0", "1.0.0-01", "1.0.0-rc..1", "1.0.0-", "1.0.0+", "1.0.0 ", "1.0.0\n"])(
  "rejects malformed release version %s", (version) => expect(isReleaseVersion(version)).toBe(false),
);
