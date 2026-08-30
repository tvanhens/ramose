import { describe, expect, test } from "bun:test";
import {
  base64Url,
  ENTITY_ID_CODEC_VERSION,
  openEntityId,
  SEALED_ENTITY_ID_PATTERN,
  sealEntityId,
  type EntityIdScope,
  type ServerSealingKey,
} from "../../../src/internal/replication/index.ts";

/**
 * Fixed roots, so the frozen construction is pinned by a golden token rather
 * than only by round-tripping against itself.
 */
const fixedKey = (seed: number): ServerSealingKey => ({
  keyId: base64Url(Uint8Array.from({ length: 16 }, (_, i) => (seed * 31 + i) & 0xff)),
  material: base64Url(
    Uint8Array.from({ length: 32 }, (_, i) => (seed * 17 + i * 7) & 0xff),
  ),
});

const sealing = fixedKey(1);
const other = fixedKey(2);

const scope = (
  overrides: Partial<EntityIdScope> = {},
): EntityIdScope => ({
  server: "S".repeat(43),
  principal: "P".repeat(43),
  database: "D".repeat(43),
  ...overrides,
});

const bytesOf = (token: string): Uint8Array =>
  Uint8Array.from(
    atob(token.replaceAll("-", "+").replaceAll("_", "/") + "="),
    (character) => character.charCodeAt(0),
  );

const flip = (token: string, index: number): string => {
  const bytes = bytesOf(token);
  bytes[index] = bytes[index]! ^ 0x40;
  return base64Url(bytes);
};

describe("the sealed EntityId codec", () => {
  test("round-trips the private eid and resolves with its scope", async () => {
    const token = await sealEntityId(sealing, scope(), 42);
    expect(token).toMatch(SEALED_ENTITY_ID_PATTERN);
    expect(bytesOf(token).length).toBe(41);
    expect(bytesOf(token)[0]).toBe(ENTITY_ID_CODEC_VERSION);
    expect(await openEntityId(sealing, scope(), token)).toEqual({
      type: "resolved",
      eid: 42,
      scope: scope(),
    });
  });

  test("the same root, scope, and eid always produce the identical token", async () => {
    const first = await sealEntityId(sealing, scope(), 7);
    expect(await sealEntityId(sealing, scope(), 7)).toBe(first);
    // Frozen construction: HKDF-SHA-256 -> HMAC-SHA-256 synthetic IV ->
    // AES-256-CTR, canonical 41-byte envelope. Changing any constant changes
    // this literal, and would orphan every persisted queued target.
    expect(first).toBe(
      "AR8gISIjJCUmJygpKissLS5h7GSx2nwjtWKjHe0iqxdpwiqkYHCSLwc",
    );
    expect(await sealEntityId(sealing, scope(), 8)).not.toBe(first);
  });

  test("eids are eight-byte big-endian and bounded by the safe integer range", async () => {
    for (const eid of [0, 1, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      const resolved = await openEntityId(
        sealing,
        scope(),
        await sealEntityId(sealing, scope(), eid),
      );
      expect(resolved).toEqual({ type: "resolved", eid, scope: scope() });
    }
    for (const rejected of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(sealEntityId(sealing, scope(), rejected)).rejects.toThrow(
        TypeError,
      );
    }
  });

  test("only the canonical envelope encoding is accepted", async () => {
    const token = await sealEntityId(sealing, scope(), 11);
    for (
      const malformed of [
        "",
        `${token}=`,
        `${token}A`,
        token.slice(0, -1),
        `${token.slice(0, -1)}+`,
        `${token.slice(0, -1)}/`,
        // A non-canonical trailing sextet: "B" always carries bits that
        // decode to nothing, so it is a second spelling of 52-and-a-bit bytes.
        `${token.slice(0, -1)}B`,
      ]
    ) {
      if (malformed === token) throw new Error("fixture is not a mutation");
      expect(await openEntityId(sealing, scope(), malformed))
        .toEqual({ type: "denied" });
    }
  });

  test("an unreadable codec version or key epoch is a data-free quarantine", async () => {
    const token = await sealEntityId(sealing, scope(), 11);
    const versioned = bytesOf(token);
    versioned[0] = ENTITY_ID_CODEC_VERSION + 1;
    expect(await openEntityId(sealing, scope(), base64Url(versioned)))
      .toEqual({ type: "update-required", reason: "codec-version" });
    // A future envelope need not even be 53 bytes to classify.
    expect(
      await openEntityId(sealing, scope(), base64Url(versioned.slice(0, 20))),
    ).toEqual({ type: "update-required", reason: "codec-version" });

    // A replaced root: a different key id quarantines rather than denying, so
    // the queued target can be reported as update-required and never silently
    // re-executed or cleared.
    expect(await openEntityId(other, scope(), token))
      .toEqual({ type: "update-required", reason: "key-epoch" });

    // The right key id with the wrong material is not a key epoch at all — it
    // is a forgery, and takes the ordinary sealed denial.
    const forged: ServerSealingKey = {
      keyId: sealing.keyId,
      material: other.material,
    };
    expect(await openEntityId(forged, scope(), token)).toEqual({ type: "denied" });
  });

  test("tampering with any envelope field is the ordinary sealed denial", async () => {
    const token = await sealEntityId(sealing, scope(), 11);
    // key id, synthetic IV, ciphertext.
    for (const index of [1, 20, 35]) {
      const mutated = flip(token, index);
      const resolution = await openEntityId(sealing, scope(), mutated);
      expect(resolution).toEqual(
        // A mutated key id is a key epoch this server does not hold.
        index === 1
          ? { type: "update-required", reason: "key-epoch" }
          : { type: "denied" },
      );
    }
  });

  test("the synthetic IV is the tag, so mixed envelope halves never resolve", async () => {
    const mine = bytesOf(await sealEntityId(sealing, scope(), 11));
    const other = bytesOf(await sealEntityId(sealing, scope(), 12));

    // This token's synthetic IV with the other token's ciphertext: AES-CTR
    // happily produces *some* plaintext, and the recomputed IV rejects it.
    const swappedCiphertext = mine.slice();
    swappedCiphertext.set(other.slice(33), 33);
    expect(await openEntityId(sealing, scope(), base64Url(swappedCiphertext)))
      .toEqual({ type: "denied" });

    // And the reverse: another token's IV over this ciphertext.
    const swappedIv = mine.slice();
    swappedIv.set(other.slice(17, 33), 17);
    expect(await openEntityId(sealing, scope(), base64Url(swappedIv)))
      .toEqual({ type: "denied" });

    // Both halves together are just the other handle, and it still resolves.
    expect(await openEntityId(sealing, scope(), base64Url(other)))
      .toEqual({ type: "resolved", eid: 12, scope: scope() });
  });

  test("every scope component separates, and none of them can be forged", async () => {
    const token = await sealEntityId(sealing, scope(), 11);
    for (
      const wrong of [
        scope({ server: "s".repeat(43) }),
        scope({ principal: "p".repeat(43) }),
        scope({ database: "d".repeat(43) }),
        // Components swapped: the canonical JSON scope cannot be flattened
        // into an ambiguous concatenation.
        { server: scope().principal, principal: scope().server, database: scope().database },
      ]
    ) {
      expect(await openEntityId(sealing, wrong, token)).toEqual({ type: "denied" });
      expect(await sealEntityId(sealing, wrong, 11)).not.toBe(token);
    }
  });

  test("a compatible read-view, catalog, or deployment change is not in the scope", async () => {
    // The scope has exactly three components; there is no field a schema or
    // read-view hash could occupy, so a compatible redeploy cannot rotate a
    // queued target.
    expect(Object.keys(scope()).sort()).toEqual([
      "database",
      "principal",
      "server",
    ]);
    const token = await sealEntityId(sealing, scope(), 11);
    const extra = { ...scope(), readCompatibilityHash: "ignored" };
    expect(await sealEntityId(sealing, extra, 11)).toBe(token);
  });
});
