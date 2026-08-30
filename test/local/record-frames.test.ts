import { setDefaultTimeout } from "bun:test";
import { localUrls } from "./fixtures.ts";
import { registerFrameRecorder } from "./record-frames.ts";

setDefaultTimeout(90_000);

registerFrameRecorder({ urls: localUrls });
