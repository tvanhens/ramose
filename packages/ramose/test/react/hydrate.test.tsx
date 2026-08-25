/**
 * SSR seam on the read hooks: `initialData` hydrates the first paint
 * (keyed on the same structural identity as the subscription / one-shot),
 * and `{ suspense: true }` throws until that key has a value.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import { Component, type ReactNode, Suspense } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import {
  registerDom,
  sleep,
  Todo,
  Todos,
  titles,
  wrapperFor,
} from "./harness.tsx";
import { fakePeer, type Frame } from "./peer.ts";
import * as Ramose from "../../src/db/index.ts";
import {
  useDb,
  useLiveQuery,
  usePull,
  useQuery,
} from "../../src/react/index.ts";

registerDom();

const snap = (r: {
  readonly data: unknown;
  readonly error: unknown;
  readonly status: string;
  readonly isLoading: boolean;
  readonly t: number | undefined;
}) => ({
  data: r.data,
  error: r.error,
  status: r.status,
  isLoading: r.isLoading,
  t: r.t,
});

const immediate = <A,>(values: readonly A[]): Ramose.Subscription<A> => ({
  subscribe(onValue) {
    for (const value of values) onValue(value);
    return () => {};
  },
  async *[Symbol.asyncIterator]() {
    yield* values;
  },
  close() {},
});

const later = <A,>(): {
  readonly sub: Ramose.Subscription<A>;
  readonly emit: (value: A) => void;
  readonly fail: (error: unknown) => void;
} => {
  const listeners: Array<(value: A) => void> = [];
  const errors: Array<(error: unknown) => void> = [];
  return {
    sub: {
      subscribe(onValue, onError) {
        listeners.push(onValue);
        if (onError !== undefined) errors.push(onError);
        return () => {};
      },
      async *[Symbol.asyncIterator]() {},
      close() {},
    },
    emit: (value) => {
      for (const fn of listeners) fn(value);
    },
    fail: (error) => {
      for (const fn of errors) fn(error);
    },
  };
};

class Catch extends Component<
  { readonly children: ReactNode },
  { error: unknown }
> {
  override state: { error: unknown } = { error: undefined };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    if (this.state.error !== undefined) {
      const tag =
        typeof this.state.error === "object" &&
        this.state.error !== null &&
        "_tag" in this.state.error
          ? String((this.state.error as { _tag: unknown })._tag)
          : String(this.state.error);
      return <div data-testid="caught">{tag}</div>;
    }
    return this.props.children;
  }
}

describe("initialData", () => {
  test("useLiveQuery(sub) paints hydrated rows on the first render", async () => {
    const pending = later<string>();
    const { result } = renderHook(() =>
      useLiveQuery(pending.sub, { initialData: "seed", initialT: 4 }),
    );
    expect(snap(result.current)).toEqual({
      data: "seed",
      error: undefined,
      status: "success",
      isLoading: false,
      t: 4,
    });
    await act(() => {
      pending.emit("live");
    });
    expect(result.current.data).toBe("live");
  });

  test("a new subscription identity without initialData blanks rows", async () => {
    const first = immediate(["A"]);
    const pending = later<string>();
    type Props = {
      sub: Ramose.Subscription<string>;
      initialData?: string;
    };
    const { result, rerender } = renderHook(
      (props: Props) => useLiveQuery(props.sub, { initialData: props.initialData }),
      { initialProps: { sub: first, initialData: "A" } as Props },
    );
    expect(result.current.data).toBe("A");

    rerender({ sub: pending.sub });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);

    pending.emit("B");
    await waitFor(() => expect(result.current.data).toBe("B"));
  });

  test("a new identity with matching initialData hydrates the new key", () => {
    const first = immediate(["A"]);
    const pending = later<string>();
    const { result, rerender } = renderHook(
      ({
        sub,
        initialData,
      }: {
        sub: Ramose.Subscription<string>;
        initialData: string;
      }) => useLiveQuery(sub, { initialData }),
      { initialProps: { sub: first, initialData: "A" } },
    );
    expect(result.current.data).toBe("A");

    rerender({ sub: pending.sub, initialData: "B-seed" });
    expect(snap(result.current)).toEqual({
      data: "B-seed",
      error: undefined,
      status: "success",
      isLoading: false,
      t: undefined,
    });
  });

  test("useQuery skips the first fetch when initialData hydrates the key", async () => {
    const peer = fakePeer({
      answer: (frame: Frame) =>
        frame.op === "q"
          ? { body: { t: 1, result: [[{ title: "fresh" }]] } }
          : { body: { t: 1, result: [] } },
    });
    const seed = [{ title: "seed" }];
    const { result } = renderHook(
      () => {
        const db = useDb("todos", Todos);
        return useQuery(db.asOf(1), titles, {
          initialData: seed,
          initialT: 1,
        });
      },
      { wrapper: wrapperFor(peer) },
    );
    expect(snap(result.current)).toEqual({
      data: seed,
      error: undefined,
      status: "success",
      isLoading: false,
      t: 1,
    });
    await sleep(30);
    expect(peer.frameOps("q")).toHaveLength(0);

    result.current.refetch();
    await waitFor(() =>
      expect(result.current.data).toEqual([{ title: "fresh" }]),
    );
    expect(peer.frameOps("q")).toHaveLength(1);
  });

  test("usePull hydrates null — a missing record is data, not a blank", () => {
    const peer = fakePeer({
      answer: () => ({ body: { t: 3, result: { title: "A" } } }),
    });
    const { result } = renderHook(
      () =>
        usePull(useDb("todos", Todos).asOf(3), 17, { title: Todo.title }, {
          initialData: null,
          initialT: 3,
        }),
      { wrapper: wrapperFor(peer) },
    );
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.t).toBe(3);
    expect(peer.frameOps("pull")).toHaveLength(0);
  });
});

const ensureDom = () => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
};

describe("{ suspense: true }", () => {
  test("useLiveQuery suspends until the first emission, then data is defined", async () => {
    ensureDom();
    const pending = later<string>();
    function Probe() {
      const { data } = useLiveQuery(pending.sub, { suspense: true });
      return <div data-testid="row">{data}</div>;
    }
    const { container } = render(
      <Suspense fallback={<div data-testid="fb">loading</div>}>
        <Probe />
      </Suspense>,
    );
    expect(container.textContent).toBe("loading");
    await act(() => {
      pending.emit("hello");
    });
    await waitFor(() => expect(container.textContent).toBe("hello"));
  });

  test("initialData plus suspense does not suspend", () => {
    ensureDom();
    const pending = later<string>();
    function Probe() {
      const { data } = useLiveQuery(pending.sub, {
        initialData: "seed",
        suspense: true,
      });
      return <div data-testid="row">{data}</div>;
    }
    const { container } = render(
      <Suspense fallback={<div data-testid="fb">loading</div>}>
        <Probe />
      </Suspense>,
    );
    expect(container.textContent).toBe("seed");
  });

  test("a terminal live error throws to the nearest boundary", async () => {
    ensureDom();
    const pending = later<string>();
    function Probe() {
      useLiveQuery(pending.sub, { suspense: true });
      return <div data-testid="row">ok</div>;
    }
    const { container } = render(
      <Catch>
        <Suspense fallback={<div data-testid="fb">loading</div>}>
          <Probe />
        </Suspense>
      </Catch>,
    );
    expect(container.textContent).toBe("loading");
    await act(() => {
      pending.fail({ _tag: "Unauthorized" });
    });
    await waitFor(() => expect(container.textContent).toBe("Unauthorized"));
  });

  test("useQuery suspense resolves the first answer without a loading shell", async () => {
    ensureDom();
    const peer = fakePeer({
      answer: (frame: Frame) =>
        frame.op === "q"
          ? { body: { t: 1, result: [[{ title: "one" }]] } }
          : { body: { t: 1, result: [] } },
    });
    function Probe() {
      const { data } = useQuery(useDb("todos", Todos).asOf(1), titles, {
        suspense: true,
      });
      return <div data-testid="row">{data[0]!.title}</div>;
    }
    const { container } = render(
      wrapperFor(peer)({
        children: (
          <Suspense fallback={<div data-testid="fb">loading</div>}>
            <Probe />
          </Suspense>
        ),
      }),
    );
    expect(container.textContent).toBe("loading");
    await waitFor(() => expect(container.textContent).toBe("one"));
  });
});
