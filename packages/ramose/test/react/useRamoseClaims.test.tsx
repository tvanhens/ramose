/**
 * useRamoseClaims() — synchronous peek of the provider's TokenSource.
 */

import { describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import * as Ramose from "../../src/db/index.ts";
import { RamoseProvider, useRamoseClaims } from "../../src/react/index.ts";
import { registerDom } from "./harness.tsx";
import { fakePeer } from "./peer.ts";

registerDom();

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const jwtOf = (claims: Record<string, unknown>): string =>
  `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`;

const wrap = (
  token: Ramose.TokenInput,
  peer = fakePeer(),
) =>
  ({ children }: { children?: ReactNode }) => (
    <RamoseProvider
      url="https://peer.example.com"
      token={token}
      fetch={peer.fetch}
      webSocket={peer.webSocket}
    >
      {children}
    </RamoseProvider>
  );

describe("useRamoseClaims", () => {
  test("outside a provider it throws, and the message names the hook", () => {
    const noisy = console.error;
    console.error = () => {};
    try {
      expect(() => renderHook(() => useRamoseClaims())).toThrow(
        /useRamoseClaims/,
      );
      expect(() => renderHook(() => useRamoseClaims())).toThrow(
        /RamoseProvider/,
      );
    } finally {
      console.error = noisy;
    }
  });

  test("a warmed jwt source is sync on the first render", async () => {
    const source = Ramose.token.jwt(async () =>
      jwtOf({ sub: "ada", ramose: { db: "coral", class: "owner" } }),
    );
    await source.claims();
    const { result } = renderHook(() => useRamoseClaims(), {
      wrapper: wrap(source),
    });
    expect(result.current?.sub).toBe("ada");
    expect(result.current?.ramose?.class).toBe("owner");
  });

  test("token.static decodes on the first render", () => {
    const jwt = jwtOf({ ramose: { class: "member" } });
    const { result } = renderHook(() => useRamoseClaims(), {
      wrapper: wrap(Ramose.token.static(jwt)),
    });
    expect(result.current?.ramose?.class).toBe("member");
  });

  test("a string token decodes on the first render", () => {
    const jwt = jwtOf({ ramose: { class: "viewer" } });
    const { result } = renderHook(() => useRamoseClaims(), {
      wrapper: wrap(jwt),
    });
    expect(result.current?.ramose?.class).toBe("viewer");
  });

  test("a cold jwt source mints and then lands", async () => {
    const source = Ramose.token.jwt(async () =>
      jwtOf({ ramose: { class: "member" } }),
    );
    const { result } = renderHook(() => useRamoseClaims(), {
      wrapper: wrap(source),
    });
    expect(result.current).toBeUndefined();
    await waitFor(() =>
      expect(result.current?.ramose?.class).toBe("member"),
    );
  });
});
