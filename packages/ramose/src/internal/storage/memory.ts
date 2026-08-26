/**
 * In-memory `R2Like` for tests and benches (same semantics as the R2 binding
 * as far as Ramose uses it: get/put/head/delete/list with prefix + cursor).
 */
import type { R2Like } from "./index.ts";

/** In-memory R2Like. */
export class MemoryBucket implements R2Like {
  readonly objects = new Map<string, { body: Uint8Array; meta?: unknown }>();
  puts = 0;
  gets = 0;
  /** every key passed to get(), in order (instrumentation) */
  readonly getLog: string[] = [];
  async get(key: string) {
    this.gets++;
    this.getLog.push(key);
    const o = this.objects.get(key);
    if (!o) return null;
    const body = o.body;
    return {
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(body),
      httpMetadata: o.meta,
    };
  }
  async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: any) {
    this.puts++;
    const body = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value.slice() : new Uint8Array(value.slice(0));
    this.objects.set(key, { body, meta: options?.httpMetadata });
    return {};
  }
  async head(key: string) {
    return this.objects.has(key) ? {} : null;
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const prefix = options.prefix ?? "";
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1000;
    const slice = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: slice.map((key) => ({ key, size: this.objects.get(key)!.body.length })),
      truncated,
      ...(truncated && { cursor: String(start + limit) }),
    };
  }
}

