/**
 * Opt-in stress entry — `bun run test:stress`. Never part of `test:conformance`.
 *
 * It shares `fixtures.ts`, so it deploys its own Alchemy stack rather than
 * borrowing the conformance one. Cases registered here measure the local
 * runtime under conditions the conformance lane only hits by accident; they
 * are slow by construction and report rather than assert, so a run is evidence
 * and never a gate.
 */
import { setDefaultTimeout } from "bun:test";
import { localUrls } from "./fixtures.ts";
import { registerTransportForensics } from "./transport-forensics.ts";

setDefaultTimeout(3_600_000);

registerTransportForensics({ urls: localUrls });
