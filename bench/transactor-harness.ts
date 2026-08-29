/**
 * In-process adapter used only by microbenchmarks so measurements exclude
 * network/workerd overhead. Runtime behavior is tested through Alchemy local.
 */

import { Database } from "bun:sqlite";
import {
  type R2Like,
  dbPrefix,
  prefixedBucket,
} from "../packages/ramose/src/internal/storage/index.ts";
import { MemoryBucket } from "../packages/ramose/src/internal/storage/memory.ts";
import {
  DEFAULT_CONFIG,
  type SocketLike,
  type SqlLike,
  type TransactorConfig,
  type TransactorHost,
  Transactor,
} from "../packages/ramose/src/internal/transactor/index.ts";

export class BenchSocket implements SocketLike {
  readonly frames: any[] = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data));
  }

  ofKind(kind: string): any[] {
    return this.frames.filter((frame) => frame.kind === kind);
  }
}

const sqliteLike = (db: Database): SqlLike => {
  const cache = new Map<string, ReturnType<Database["query"]>>();
  return {
    exec(query: string, ...bindings: unknown[]) {
      let statement = cache.get(query);
      if (statement === undefined) {
        statement = db.query(query);
        cache.set(query, statement);
      }
      const args = bindings.map((binding) =>
        binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding
      );
      const rows = statement.all(...(args as any[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
};

export type BenchHarnessOptions = {
  readonly dbName?: string;
  readonly file?: string;
  readonly config?: Partial<TransactorConfig>;
};

export class BenchHarness implements TransactorHost {
  readonly dbName: string;
  readonly db: Database;
  readonly sql: SqlLike;
  readonly raw: MemoryBucket;
  readonly bucket: R2Like;
  readonly config: TransactorConfig;
  readonly subscribers = new Set<BenchSocket>();
  readonly transactor: Transactor;
  writes = 0;
  private alarm: number | null = null;

  constructor(options: BenchHarnessOptions = {}, bucket?: MemoryBucket) {
    this.dbName = options.dbName ?? "bench";
    this.db = new Database(options.file ?? ":memory:");
    this.db.exec(
      options.file
        ? "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;"
        : "PRAGMA synchronous = OFF;",
    );
    this.sql = sqliteLike(this.db);
    this.raw = bucket ?? new MemoryBucket();
    this.bucket = prefixedBucket(this.raw, dbPrefix(this.dbName));
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.transactor = new Transactor(this);
  }

  transactionSync<A>(run: () => A): A {
    this.writes += 1;
    return this.db.transaction(run)();
  }

  sockets(): SocketLike[] {
    return [...this.subscribers];
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }

  abort(reason: string): never {
    throw new Error(`benchmark transactor aborted: ${reason}`);
  }

  now(): number {
    return Date.now();
  }

  subscribe(from: number): BenchSocket {
    const socket = new BenchSocket();
    this.subscribers.add(socket);
    this.transactor.onSubscribe(socket, from);
    return socket;
  }

  logTs(): number[] {
    return this.sql.exec("SELECT t FROM log ORDER BY t").toArray().map((row) =>
      row.t as number
    );
  }
}

export const attribute = (
  ident: string,
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ":db/ident": ident,
  ":db/valueType": `:db.type/${type}`,
  ":db/cardinality": ":db.cardinality/one",
  ...(extra[":db/cardinality"] === ":db.cardinality/many"
    ? {}
    : { ":db/optional": true }),
  ...extra,
});
