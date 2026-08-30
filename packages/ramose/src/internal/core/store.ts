import { gunzip, gzip, sha256Hex } from "./bytes.ts";
import type { IndexId } from "./datom.ts";
import { type NodeKind, type NodeRef, type NodeSource, type NodeStore, type TreeNode, decodeNode, encodeNode } from "./tree.ts";

export interface Codec {
  readonly name: string;
  compress(data: Uint8Array): Promise<Uint8Array>;
  decompress(data: Uint8Array): Promise<Uint8Array>;
}

export const identityCodec: Codec = {
  name: "identity",
  compress: async (d) => d,
  decompress: async (d) => d,
};

export const gzipCodec: Codec = {
  name: "gzip",
  compress: gzip,
  decompress: gunzip,
};

export function objectKey(kind: NodeKind, hash: string): string {
  return (kind === 0 ? "seg/" : "n/") + hash;
}

function countOf(node: TreeNode): number {
  if (node.kind === 0) return node.datoms.length;
  let n = 0;
  for (const r of node.refs) n += r.count;
  return n;
}

export async function serializeNode(
  index: IndexId,
  node: TreeNode,
  codec: Codec,
): Promise<{ ref: NodeRef; body: Uint8Array }> {
  const raw = encodeNode(index, node);
  const body = await codec.compress(raw);
  const hash = await sha256Hex(body);
  return { ref: { hash, kind: node.kind, count: countOf(node) }, body };
}

export async function deserializeNode(body: Uint8Array, codec: Codec): Promise<TreeNode> {
  const raw = await codec.decompress(body);
  return decodeNode(raw).node;
}

export interface MemStoreStats {
  puts: number;
  objects: number;
  loads: number;
  bytes: number;
}

export class MemStore implements NodeStore {
  readonly nodes = new Map<string, TreeNode>();
  readonly bodies = new Map<string, Uint8Array>();
  readonly stats: MemStoreStats = { puts: 0, objects: 0, loads: 0, bytes: 0 };

  constructor(readonly codec: Codec = identityCodec, private readonly keepDecoded = true) {}

  peek(hash: string): TreeNode | undefined {
    return this.nodes.get(hash);
  }

  async load(ref: NodeRef): Promise<TreeNode> {
    this.stats.loads++;
    const n = this.nodes.get(ref.hash);
    if (n) return n;
    const body = this.bodies.get(ref.hash);
    if (!body) throw new Error(`MemStore: missing node ${ref.hash}`);
    const node = await deserializeNode(body, this.codec);
    if (this.keepDecoded) this.nodes.set(ref.hash, node);
    return node;
  }

  async put(index: IndexId, node: TreeNode): Promise<NodeRef> {
    this.stats.puts++;
    const { ref, body } = await serializeNode(index, node, this.codec);
    if (!this.bodies.has(ref.hash)) {
      this.bodies.set(ref.hash, body);
      this.stats.objects++;
      this.stats.bytes += body.length;
    }
    if (this.keepDecoded) this.nodes.set(ref.hash, node);
    return ref;
  }

  evictDecoded(): void {
    this.nodes.clear();
  }

  sweep(keep: Set<string>): number {
    let n = 0;
    for (const h of [...this.bodies.keys()]) {
      if (!keep.has(h)) {
        this.bodies.delete(h);
        this.nodes.delete(h);
        n++;
      }
    }
    this.stats.objects = this.bodies.size;
    return n;
  }
}

export class CachingSource implements NodeStore {
  private readonly cache = new Map<string, TreeNode>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly backing: NodeSource | NodeStore,
    private readonly maxNodes = 4096,
  ) {}

  peek(hash: string): TreeNode | undefined {
    const n = this.cache.get(hash);
    if (n !== undefined) {
      this.hits++;
      this.cache.delete(hash);
      this.cache.set(hash, n);
      return n;
    }
    const b = this.backing.peek(hash);
    if (b !== undefined) this.remember(hash, b);
    return b;
  }

  async load(ref: NodeRef): Promise<TreeNode> {
    const c = this.peek(ref.hash);
    if (c !== undefined) return c;
    this.misses++;
    const n = await this.backing.load(ref);
    this.remember(ref.hash, n);
    return n;
  }

  async put(index: IndexId, node: TreeNode): Promise<NodeRef> {
    if (!("put" in this.backing)) throw new Error("CachingSource: backing source is read-only");
    const ref = await (this.backing as NodeStore).put(index, node);
    this.remember(ref.hash, node);
    return ref;
  }

  private remember(hash: string, node: TreeNode): void {
    this.cache.set(hash, node);
    if (this.cache.size > this.maxNodes) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }
}
