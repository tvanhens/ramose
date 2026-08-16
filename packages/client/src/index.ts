/**
 * Ripple client SDK (thin). Works in browsers, Bun, Node, Workers.
 *
 *   const ripple = new RippleClient("https://ripple.example.workers.dev", { token });
 *   const db = ripple.db("app");
 *   await db.transact([{ ":user/name": "Ada" }]);
 *   await db.q(`[:find ?n :where [?e :user/name ?n]]`);
 *   await db.asOf(42).q(...);   await db.history().q(...);
 *   await db.pull(eid, "[*]");
 */

import { fromJson, toJson } from "@ripple/core";
import type { TxData } from "@ripple/core";

export interface ClientOptions {
  token?: string;
  fetch?: typeof fetch;
  /** Extra request headers, e.g. `x-ripple-replica-hint: enam`, `x-ripple-cache-basis: 1`, `x-ripple-cache-mode: peer` (read-path knobs). */
  headers?: Record<string, string>;
}

export interface TxAck {
  t: number;
  txEid: number;
  tempids: Record<string, number>;
  datoms: number;
}

export interface QueryResponse<T = unknown> {
  t: number;
  root: number;
  result: T;
  explain?: unknown[];
  meta: { ms: number | null; r2Gets: number | null; cacheHits: number | null; colo?: string; replicaHint?: string; basisT?: number | null; basisHit?: boolean; basisReason?: string; basisBehind?: boolean };
}

export class RippleError extends Error {
  constructor(msg: string, readonly status: number, readonly code?: string) {
    super(msg);
  }
}

/** Drop undefined fields (JSON encoding would otherwise send them as null). */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export class RippleClient {
  readonly base: string;
  private readonly f: typeof fetch;
  constructor(base: string, readonly opts: ClientOptions = {}) {
    this.base = base.replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch.bind(globalThis);
  }

  db(name: string): RippleDb {
    return new RippleDb(this, name);
  }

  async health(): Promise<{ ok: boolean; stage: string }> {
    return this.request("GET", "/health");
  }

  async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json", ...(this.opts.headers ?? {}), ...(extraHeaders ?? {}) };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    const res = await this.f(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(toJson(body)) });
    const text = await res.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: text };
    }
    if (!res.ok) throw new RippleError(parsed?.error ?? `HTTP ${res.status}`, res.status, parsed?.code);
    const out = fromJson(parsed) as any;
    if (out && typeof out === "object" && !Array.isArray(out)) {
      out.meta = { ms: num(res.headers.get("x-ripple-ms")), r2Gets: num(res.headers.get("x-ripple-r2-gets")), cacheHits: num(res.headers.get("x-ripple-cache-hits")), colo: res.headers.get("x-ripple-colo") ?? undefined, replicaHint: res.headers.get("x-ripple-replica-hint") ?? undefined, basisT: num(res.headers.get("x-ripple-basis-t")), basisHit: res.headers.get("x-ripple-basis-hit") === "1", basisReason: res.headers.get("x-ripple-basis-reason") ?? undefined, basisBehind: res.headers.get("x-ripple-basis-behind") === "1" };
    }
    return out as T;
  }
}

/** The read fence, as the header the peer reads it from. */
function minTHeader(opts: { minT?: number }): Record<string, string> | undefined {
  return opts.minT !== undefined ? { "x-ripple-min-t": String(opts.minT) } : undefined;
}

function num(s: string | null): number | null {
  return s === null ? null : Number(s);
}

export class RippleDb {
  constructor(
    readonly client: RippleClient,
    readonly name: string,
    private readonly asOfT?: number,
    private readonly hist = false,
  ) {}

  private path(p: string): string {
    return `/db/${encodeURIComponent(this.name)}${p}`;
  }

  /** Read-only view as of transaction `t`. */
  asOf(t: number): RippleDb {
    return new RippleDb(this.client, this.name, t, this.hist);
  }
  /** History view (asserts and retracts, with tx and op). */
  history(): RippleDb {
    return new RippleDb(this.client, this.name, this.asOfT, true);
  }

  transact(tx: TxData): Promise<TxAck> {
    return this.client.request<TxAck>("POST", this.path("/transact"), { tx });
  }

  /** `minT`: read fence — the server refetches its basis if its cached one is older than `t` (e.g. the t of your last transact). */
  async q<T = any>(query: string | object, inputs: unknown[] = [], opts: { explain?: boolean; minT?: number } = {}): Promise<T> {
    const r = await this.query<T>(query, inputs, opts);
    return r.result;
  }

  query<T = any>(query: string | object, inputs: unknown[] = [], opts: { explain?: boolean; minT?: number } = {}): Promise<QueryResponse<T>> {
    return this.client.request<QueryResponse<T>>("POST", this.path("/query"), compact({ query, inputs, asOf: this.asOfT, history: this.hist || undefined, explain: opts.explain }), minTHeader(opts));
  }

  /** `minT`: read fence, same as `q` / `query`. */
  async pull<T = Record<string, unknown> | null>(eid: number | string | [string, unknown], pattern: string | unknown[], opts: { minT?: number } = {}): Promise<T> {
    const r = await this.client.request<{ result: T }>("POST", this.path("/pull"), compact({ eid, pattern, asOf: this.asOfT, history: this.hist || undefined }), minTHeader(opts));
    return r.result;
  }

  /** `minT`: read fence, same as `q` / `query`. */
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

/** Convenience for schema installs. */
export function attribute(ident: string, valueType: string, opts: { cardinality?: "one" | "many"; unique?: "identity" | "value"; index?: boolean; isComponent?: boolean; doc?: string } = {}) {
  const m: Record<string, unknown> = {
    ":db/ident": ident,
    ":db/valueType": valueType.startsWith(":") ? valueType : `:db.type/${valueType}`,
    ":db/cardinality": `:db.cardinality/${opts.cardinality ?? "one"}`,
  };
  if (opts.unique) m[":db/unique"] = `:db.unique/${opts.unique}`;
  if (opts.index) m[":db/index"] = true;
  if (opts.isComponent) m[":db/isComponent"] = true;
  if (opts.doc) m[":db/doc"] = opts.doc;
  return m;
}
