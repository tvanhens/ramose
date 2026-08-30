/** A value that can be observed and read without recomputation. */
export type Subscription<A> = {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => A;
};

export class Store<A> {
  private readonly listeners = new Set<() => void>();
  private value: A;
  readonly subscription: Subscription<A>;

  constructor(initial: A) {
    this.value = initial;
    this.subscription = Object.freeze({
      subscribe: (onChange: () => void) => this.subscribe(onChange),
      getSnapshot: () => this.getSnapshot(),
    });
  }

  getSnapshot(): A {
    return this.value;
  }

  get size(): number {
    return this.listeners.size;
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.listeners.delete(onChange);
    };
  }

  publish(next: A): boolean {
    if (Object.is(next, this.value)) return false;
    this.value = next;
    this.notify();
    return true;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
      }
    }
  }
}

export const sameResult = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length &&
      left.every((item, index) => sameResult(item, right[index]));
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date &&
      left.getTime() === right.getTime();
  }
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return left instanceof Uint8Array && right instanceof Uint8Array &&
      left.length === right.length &&
      left.every((byte, index) => byte === right[index]);
  }
  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.hasOwn(right as Record<string, unknown>, key) &&
    sameResult(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
    )
  );
};
