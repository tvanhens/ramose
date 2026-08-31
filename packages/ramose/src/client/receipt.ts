import type { InvocationId } from "../db/refs.ts";
import { Store, type Subscription } from "./subscription.ts";

/**
 * Why the authoritative server refused an invocation it had.
 *
 * The code is the server's own opaque classification; it is reported so an
 * application can branch, never interpreted here.
 */
export class MutationRejectedError extends Error {
  readonly _tag = "MutationRejectedError" as const;
  readonly code: string;

  constructor(code: string) {
    super(`ramose/client: the server rejected this invocation (${code})`);
    this.name = "MutationRejectedError";
    this.code = code;
  }
}

/**
 * One receipt's current state.
 *
 * A discriminated union, in the same style as the query snapshot, so a
 * framework adapter renders it with a `switch` and no second state machine.
 */
export type ReceiptState =
  | { readonly status: "pending" }
  | { readonly status: "queued" }
  | { readonly status: "committed" }
  | { readonly status: "rejected"; readonly error: MutationRejectedError }
  | { readonly status: "failed"; readonly error: Error };

/** What `db.mutate.…()` and `entity.mutate.…()` return. */
export interface Receipt extends Subscription<ReceiptState> {
  readonly invocation: InvocationId;
  readonly queued: Promise<void>;
  readonly committed: Promise<void>;
}

const PENDING: ReceiptState = Object.freeze({ status: "pending" as const });
const QUEUED: ReceiptState = Object.freeze({ status: "queued" as const });
const COMMITTED: ReceiptState = Object.freeze({ status: "committed" as const });

export class ReceiptDriver {
  private readonly store = new Store<ReceiptState>(PENDING);
  private settleQueued!: () => void;
  private failQueued!: (error: Error) => void;
  private settleCommitted!: () => void;
  private failCommitted!: (error: Error) => void;
  readonly receipt: Receipt;

  constructor(invocation: InvocationId) {
    const queued = new Promise<void>((resolve, reject) => {
      this.settleQueued = resolve;
      this.failQueued = reject;
    });
    const committed = new Promise<void>((resolve, reject) => {
      this.settleCommitted = resolve;
      this.failCommitted = reject;
    });
    queued.catch(() => undefined);
    committed.catch(() => undefined);
    this.receipt = Object.freeze({
      invocation,
      queued,
      committed,
      subscribe: this.store.subscription.subscribe,
      getSnapshot: this.store.subscription.getSnapshot,
    });
  }

  private get settled(): boolean {
    const status = this.store.getSnapshot().status;
    return status === "committed" || status === "rejected" || status === "failed";
  }

  queue(): void {
    if (this.settled || this.store.getSnapshot().status === "queued") return;
    this.store.publish(QUEUED);
    this.settleQueued();
  }

  commit(): void {
    if (this.settled) return;
    this.queue();
    this.store.publish(COMMITTED);
    this.settleCommitted();
  }

  reject(code: string): void {
    if (this.settled) return;
    const error = new MutationRejectedError(code);
    this.queue();
    this.store.publish(Object.freeze({ status: "rejected" as const, error }));
    this.failCommitted(error);
  }

  fail(error: Error): void {
    if (this.settled || this.store.getSnapshot().status === "queued") return;
    this.store.publish(Object.freeze({ status: "failed" as const, error }));
    this.failQueued(error);
    this.failCommitted(error);
  }
}
