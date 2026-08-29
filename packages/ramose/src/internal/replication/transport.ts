/** Browser transport primitives for the versioned replication stream. */

import * as Result from "effect/Result";
import type { ReadCompatibilityHash } from "../authorization/identities.ts";
import {
  MAX_REPLICATION_FRAME_BYTES,
  REPLICATION_PROTOCOL_VERSION,
  decodeReplicationFrame,
  encodeActivationRequest,
  type OpaqueReplicationId,
  type ReplicationFrame,
  type TerminalError,
} from "./protocol.ts";

const CREDENTIAL_BINDING_DOMAIN = "ramose:replication:credential-binding:v1";
const NDJSON_CONTENT_TYPE = "application/x-ndjson";
const utf8 = new TextEncoder();

export type ReplicationActivationAddress = {
  readonly origin: string;
  readonly root: string;
  readonly graphPath: readonly string[];
  readonly endpoint: string;
};

export type ReplicationActivationInput = {
  readonly server: string;
  readonly root: string;
  readonly graphPath: readonly string[];
};

export class ReplicationTransportError extends Error {
  override readonly name = "ReplicationTransportError";
}

const fail = (message: string): never => {
  throw new ReplicationTransportError(message);
};

const localhost = (url: URL): boolean =>
  url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

/** Canonicalize every client-selected dimension of one activation. */
export const replicationActivationAddress = (
  input: ReplicationActivationInput,
): ReplicationActivationAddress => {
  const server = new URL(input.server);
  if (server.username !== "" || server.password !== "") {
    return fail("replication server URL must not contain credentials");
  }
  if (
    (server.pathname !== "" && server.pathname !== "/") ||
    server.search !== "" || server.hash !== ""
  ) {
    return fail("replication server URL must be an origin");
  }
  if (server.protocol !== "https:" && !(server.protocol === "http:" && localhost(server))) {
    return fail("replication requires HTTPS outside localhost");
  }
  if (input.root.length === 0 || input.root.includes("/")) {
    return fail("replication root must be one non-empty database name");
  }
  const graphPath = Object.freeze([...input.graphPath]);
  const origin = server.origin;
  return Object.freeze({
    origin,
    root: input.root,
    graphPath,
    endpoint: `${origin}/db/${encodeURIComponent(input.root)}/replicate`,
  });
};

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/**
 * Full SHA-256 binding for an exact credential and activation address. The raw
 * credential is used only as digest input and is never returned or persisted.
 */
export const replicationCredentialFingerprint = async (
  credential: string,
  activation: ReplicationActivationAddress,
): Promise<string> => {
  const material = JSON.stringify({
    domain: CREDENTIAL_BINDING_DOMAIN,
    credential,
    activation: {
      origin: activation.origin,
      root: activation.root,
      graphPath: activation.graphPath,
    },
  });
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(material));
  return base64Url(new Uint8Array(digest));
};

export type OpenReplicationInput = {
  readonly activation: ReplicationActivationAddress;
  readonly credential: string;
  readonly readCompatibilityHash: ReadCompatibilityHash;
  readonly resumeRevision?: OpaqueReplicationId;
  readonly signal: AbortSignal;
};

/** Open only the production endpoint; redirects cannot receive the credential. */
export const openReplicationResponse = (
  input: OpenReplicationInput,
): Promise<Response> => fetch(input.activation.endpoint, {
  method: "POST",
  redirect: "error",
  headers: {
    authorization: `Bearer ${input.credential}`,
    accept: NDJSON_CONTENT_TYPE,
    "content-type": "application/json",
  },
  body: encodeActivationRequest({
    type: "Activate",
    protocol: REPLICATION_PROTOCOL_VERSION,
    graphPath: input.activation.graphPath,
    scope: { type: "database" },
    readCompatibilityHash: input.readCompatibilityHash,
    ...(input.resumeRevision === undefined
      ? {}
      : { resumeRevision: input.resumeRevision }),
  }),
  signal: input.signal,
});

const validateResponse = (response: Response): void => {
  if (response.status !== 200 && response.status !== 409) {
    fail("replication response was not successful");
  }
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== NDJSON_CONTENT_TYPE) fail("replication response has the wrong content type");
  const cacheControl = response.headers.get("cache-control")
    ?.split(",").map((part) => part.trim().toLowerCase()) ?? [];
  if (!cacheControl.includes("no-store")) fail("replication response is cacheable");
};

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
};

const decodeLine = (bytes: Uint8Array): ReplicationFrame => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REPLICATION_FRAME_BYTES) {
    return fail("replication frame is empty or oversized");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("replication frame is not valid UTF-8");
  }
  const decoded = decodeReplicationFrame(text);
  if (Result.isFailure(decoded)) throw decoded.failure;
  return decoded.success;
};

/**
 * Decode one newline-terminated frame at a time. The next body read occurs
 * only after the consumer has finished processing the previous frame.
 */
export async function* readReplicationFrames(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<ReplicationFrame, void, undefined> {
  validateResponse(response);
  const body = response.body;
  if (body === null) return fail("replication response has no body");
  const reader = body.getReader();
  const chunks = (async function* (): AsyncGenerator<Uint8Array, void, undefined> {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  })();
  try {
    const decoded = decodeReplicationNdjson(chunks, signal);
    if (response.status === 409) {
      let terminal: TerminalError | undefined;
      for await (const frame of decoded) {
        if (terminal !== undefined) {
          fail("replication conflict must contain exactly one allowed terminal frame");
        }
        if (frame.type !== "TerminalError" || !("code" in frame)) {
          fail("replication conflict must contain exactly one allowed terminal frame");
        }
        const candidate = frame as TerminalError;
        if (candidate.identity !== undefined || candidate.code === "closed") {
          fail("replication conflict must contain exactly one allowed terminal frame");
        }
        terminal = candidate;
      }
      if (terminal === undefined) {
        fail("replication conflict must contain exactly one allowed terminal frame");
      }
      // Do not expose even the terminal until EOF proves that no data frame follows it.
      yield terminal as ReplicationFrame;
      return;
    }
    yield* decoded;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A fetch abort commonly errors the reader before cleanup.
    } finally {
      reader.releaseLock();
    }
  }
}

/** Pure bounded decoder for arbitrary transport byte chunks. */
export async function* decodeReplicationNdjson(
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ReplicationFrame, void, undefined> {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index++) {
      if (chunk[index] !== 0x0a) continue;
      const part = chunk.subarray(start, index);
      const line = pending.byteLength === 0 ? part : concat(pending, part);
      pending = new Uint8Array();
      start = index + 1;
      yield decodeLine(line);
    }
    const remainder = chunk.subarray(start);
    if (remainder.byteLength > 0) {
      pending = pending.byteLength === 0 ? remainder.slice() : concat(pending, remainder);
      if (pending.byteLength > MAX_REPLICATION_FRAME_BYTES) {
        fail("replication frame is oversized");
      }
    }
  }
  if (pending.byteLength !== 0) fail("replication stream ended without a newline");
}
