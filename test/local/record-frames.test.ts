/**
 * Recording entry for the browser lane's replication frame fixture.
 *
 * A separate entry from `integration.test.ts` because it deploys its own stack
 * and writes to the working tree; it is inert unless `RAMOSE_RECORD_FRAMES=1`.
 * Run it through `bun run record:frames`, never as part of `test:local`.
 */
import { setDefaultTimeout } from "bun:test";
import { localUrls } from "./fixtures.ts";
import { registerFrameRecorder } from "./record-frames.ts";

setDefaultTimeout(90_000);

registerFrameRecorder({ urls: localUrls });
