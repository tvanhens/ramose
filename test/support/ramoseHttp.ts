/**
 * The ops HTTP harness — **not** a client SDK and not a package.
 *
 * There is no separate client package: the typed surface is `ramose/db`
 * (`Ramose.layer` + `Databases` + `Db<C>`), and HTTP is Worker internals.
 * What is left here is the *ops* half that no public API names — raw datalog
 * strings, the metrics response headers, and the admin routes the server
 * reference documents (https://ramose.ai/reference/server/ — `/info`,
 * `/admin/index`, `/admin/gc`, `/admin/replica/reconnect`).
 *
 * Its only consumers are `test/e2e` and `bench/`, both of which run against a
 * real deployment and assert on exactly those internals. Nothing in
 * `packages/**` imports it.
 */

import { fromJson, toJson } from "../../packages/ramose/src/internal/core/json.ts";
import type { TxData } from "../../packages/ramose/src/internal/core/tx.ts";

export interface PeerOptions {
  /** Explicitly `undefined` is fine here (e.g. `target.token?.()`) — only absence, not presence-of-undefined, is checked (`if (this.opts.token)`). */
  token?: string | undefined;
  fetch?: typeof fetch;
  /** Extra request headers, e.g. `x-ramose-replica-hint: enam`, `x-ramose-cache-basis: 1`, `x-ramose-cache-mode: peer` (read-path knobs). */
  headers?: Record<string, string>;
  /**
   * How long (ms) to keep retrying transient Cloudflare platform errors
   * (workers.dev HTML 404, 1042/1104, "Worker not found", 503, empty-body
   * 502 from workerd/miniflare, Durable Object storage timeout reset,
   * fetch-level ECONNRESET). A
   * fresh workers.dev hostname is eventually
   * consistent across the edge, so a colo can serve the placeholder well after
   * /health passes; this is the budget for waiting that out. Application
   * errors never retry. Default 0.
   */
  retryTransientMs?: number;
}

export interface Ack {
  t: number;
  txEid: number;
  tempids: Record<string, number>;
  datoms: unknown[];
}

export interface QueryReply<T = unknown> {
  t: number;
  root: number;
  result: T;
  explain?: unknown[];
  meta: { ms: number | null; r2Gets: number | null; cacheHits: number | null; colo?: string; replicaHint?: string; basisT?: number | null; basisHit?: boolean; basisReason?: string; basisBehind?: boolean };
}

export class HttpError extends Error {
  constructor(
    msg: string,
    readonly status: number,
    readonly code?: string | undefined,
    /** Worker JSON `tag` when the 5xx is an application body, not a gateway drop. */
    readonly tag?: string | undefined,
  ) {
    super(msg);
  }
}

/** Drop undefined fields (JSON encoding would otherwise send them as null). */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export class Peer {
  readonly base: string;
  private readonly f: typeof fetch;
  constructor(base: string, readonly opts: PeerOptions = {}) {
    this.base = base.replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch.bind(globalThis);
  }

  db(name: string): PeerDb {
    return new PeerDb(this, name);
  }

  async health(): Promise<{ ok: boolean; stage: string }> {
    return this.request("GET", "/health");
  }

  async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const deadline = Date.now() + Math.max(0, this.opts.retryTransientMs ?? 0);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce<T>(method, path, body, extraHeaders, attempt > 0);
      } catch (e) {
        if (!isTransientCf(e) || Date.now() >= deadline) throw e;
        // Jittered backoff so a concurrent burst does not retry in lockstep.
        const base = Math.min(2000, 150 * 2 ** attempt);
        await Bun.sleep(Math.round(base * (0.5 + Math.random())));
      }
    }
  }

  private async requestOnce<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>, fresh = false): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json", ...(this.opts.headers ?? {}), ...(extraHeaders ?? {}) };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    // A platform 404/1042 is often pinned to one pooled socket (one edge
    // server behind the anycast IP keeps serving the placeholder). Retries
    // send `Connection: close`, which evicts that socket from Bun's pool so
    // the attempt after it dials a fresh server. Verified: Bun honors this.
    if (fresh) headers.connection = "close";
    const res = await this.f(this.base + path, { method, headers, ...(body !== undefined && { body: JSON.stringify(toJson(body)) }) });
    const text = await res.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: text };
    }
    if (!res.ok) {
      const { message, code } = httpErrorMessage(res.status, text, parsed);
      const tag = typeof parsed?.tag === "string" ? parsed.tag : undefined;
      throw new HttpError(message, res.status, code, tag);
    }
    const out = fromJson(parsed) as any;
    if (out && typeof out === "object" && !Array.isArray(out)) {
      out.meta = { ms: num(res.headers.get("x-ramose-ms")), r2Gets: num(res.headers.get("x-ramose-r2-gets")), cacheHits: num(res.headers.get("x-ramose-cache-hits")), colo: res.headers.get("x-ramose-colo") ?? undefined, replicaHint: res.headers.get("x-ramose-replica-hint") ?? undefined, basisT: num(res.headers.get("x-ramose-basis-t")), basisHit: res.headers.get("x-ramose-basis-hit") === "1", basisReason: res.headers.get("x-ramose-basis-reason") ?? undefined, basisBehind: res.headers.get("x-ramose-basis-behind") === "1" };
    }
    return out as T;
  }
}

/** Cloudflare edge / DO-binding misses — not application JSON. */
export function isCfPlatformText(s: string): boolean {
  return /<!DOCTYPE html>|Page not found|There is nothing here yet|error code:\s*1\d{3}/i.test(s);
}

function httpErrorMessage(
  status: number,
  text: string,
  parsed: { error?: unknown; code?: unknown } | null,
): { message: string; code?: string | undefined } {
  const code = typeof parsed?.code === "string" ? parsed.code : undefined;
  const raw = typeof parsed?.error === "string" ? parsed.error : text;
  if (isCfPlatformText(raw) || isCfPlatformText(text)) {
    const cf = `${raw}\n${text}`.match(/error code:\s*(\d+)/i)?.[1];
    return {
      message: cf
        ? `Cloudflare error ${cf} (HTTP ${status})`
        : `workers.dev edge returned HTML ${status} (transient)`,
      code,
    };
  }
  return { message: typeof parsed?.error === "string" ? parsed.error : `HTTP ${status}`, code };
}

const isTransientSocketReset = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  if ("code" in e && e.code === "ECONNRESET") return true;
  return e instanceof Error && /socket connection was closed unexpectedly/i.test(e.message);
};

export function isTransientCf(e: unknown): boolean {
  if (isTransientSocketReset(e)) return true;
  if (!(e instanceof HttpError)) return false;
  if (e.status === 503 || e.status === 429) return true;
  // Empty / gateway 502 from workerd, miniflare, or the edge. Application 502s
  // (`NetworkError`) carry a Worker JSON `tag` and must not be swallowed.
  if (e.status === 502 && e.tag === undefined && e.code === undefined) return true;
  // Platform errors, as normalized by httpErrorMessage, plus the JSON errors
  // a not-yet-converged deploy answers with ("Worker not found." and
  // "Handler does not export a fetch() function." both clear within seconds).
  return /Worker not found|Handler does not export a fetch|Cloudflare error 1\d{3}|workers\.dev edge|Durable Object storage operation exceeded timeout|object to be reset/i.test(
    e.message,
  );
}

const newClientTxId = (): string =>
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** The read fence, as the header the peer reads it from. */
function minTHeader(opts: { minT?: number }): Record<string, string> | undefined {
  return opts.minT !== undefined ? { "x-ramose-min-t": String(opts.minT) } : undefined;
}

function num(s: string | null): number | null {
  return s === null ? null : Number(s);
}

export class PeerDb {
  constructor(
    readonly client: Peer,
    readonly name: string,
    private readonly asOfT?: number,
    private readonly hist = false,
  ) {}

  private path(p: string): string {
    return `/db/${encodeURIComponent(this.name)}${p}`;
  }

  /** Read-only view as of transaction `t`. */
  asOf(t: number): PeerDb {
    return new PeerDb(this.client, this.name, t, this.hist);
  }
  /** History view (asserts and retracts, with tx and op). */
  history(): PeerDb {
    return new PeerDb(this.client, this.name, this.asOfT, true);
  }

  transact(tx: TxData): Promise<Ack> {
    // One id for this call so a transient 502/503 retry is at-most-once.
    return this.client.request<Ack>("POST", this.path("/transact"), {
      tx,
      clientTxId: newClientTxId(),
    });
  }

  /**
   * Unwrap the find result. EDN string queries are ops-harness only — not
   * `ramose/db` (`db.query(QueryObject)`). `q` is the scalar / rows the
   * server's `:find` produced; `queryEnvelope` is the HTTP envelope around them.
   */
  async q<T = any>(query: string | object, inputs: unknown[] = [], opts: { explain?: boolean; minT?: number } = {}): Promise<T> {
    const r = await this.queryEnvelope<T>(query, inputs, opts);
    return r.result;
  }

  /** Envelope (`t`, `root`, `result`, `meta`). Use {@link q} for the find scalar. */
  queryEnvelope<T = any>(query: string | object, inputs: unknown[] = [], opts: { explain?: boolean; minT?: number } = {}): Promise<QueryReply<T>> {
    return this.client.request<QueryReply<T>>("POST", this.path("/query"), compact({ query, inputs, asOf: this.asOfT, history: this.hist || undefined, explain: opts.explain }), minTHeader(opts));
  }

  /** `minT`: read fence, same as `q` / `queryEnvelope`. */
  async pull<T = Record<string, unknown> | null>(eid: number | string | [string, unknown], pattern: string | unknown[], opts: { minT?: number } = {}): Promise<T> {
    const r = await this.client.request<{ result: T }>("POST", this.path("/pull"), compact({ eid, pattern, asOf: this.asOfT, history: this.hist || undefined }), minTHeader(opts));
    return r.result;
  }

  /** `minT`: read fence, same as `q` / `queryEnvelope`. */
  async entity(eid: number, opts: { minT?: number } = {}): Promise<Record<string, unknown> | undefined> {
    const r = await this.client.request<{ entity: Record<string, unknown> | null }>("GET", this.path(`/entity/${eid}${this.asOfT !== undefined ? `?asOf=${this.asOfT}` : ""}`), undefined, minTHeader(opts));
    return r.entity ?? undefined;
  }

  info(): Promise<any> {
    return this.client.request("GET", this.path("/info"));
  }
  /** Chaos/ops: drop the replica's novelty subscription (it must resume with no missed datoms). */
  reconnectReplica(): Promise<{ ok: boolean; t: number }> {
    return this.client.request("POST", this.path("/admin/replica/reconnect"));
  }

  /** Force an index run (admin). */
  index(): Promise<any> {
    return this.client.request("POST", this.path("/admin/index"));
  }
  gc(): Promise<any> {
    return this.client.request("POST", this.path("/admin/gc"));
  }
}

/** Convenience for raw schema installs (the untyped twin of `db.install()`). */
export function attrMap(ident: string, valueType: string, opts: { cardinality?: "one" | "many"; unique?: "upsert" | "strict" | "identity" | "value"; index?: boolean; owned?: boolean; doc?: string } = {}) {
  const m: Record<string, unknown> = {
    ":db/ident": ident,
    ":db/valueType": valueType.startsWith(":") ? valueType : `:db.type/${valueType}`,
    ":db/cardinality": `:db.cardinality/${opts.cardinality ?? "one"}`,
  };
  if (opts.unique) {
    const uniqueWire = {
      upsert: "identity",
      strict: "value",
      identity: "identity",
      value: "value",
    } as const;
    m[":db/unique"] = `:db.unique/${uniqueWire[opts.unique]}`;
  }
  if (opts.index) m[":db/index"] = true;
  if (opts.owned) m[":db/isComponent"] = true;
  if (opts.doc) m[":db/doc"] = opts.doc;
  return m;
}
