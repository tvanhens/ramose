import { describe, expect, test } from "bun:test";
import {
  decideServerIdentityBinding,
  decodeServerIdentityRoot,
  generateServerIdentityRoot,
  makeEntityIdentity,
  readServerIdentityRootRecord,
  SERVER_IDENTITY_ROOT_VERSION,
  sealingKeyOf,
} from "../../../src/internal/replication/index.ts";

const root = () => generateServerIdentityRoot(1_700_000_000_000);

describe("durable server identity/sealing root", () => {
  test("a minted root is versioned, key-identified, and round-trips through JSON", () => {
    const minted = root();
    expect(minted.version).toBe(SERVER_IDENTITY_ROOT_VERSION);
    expect(minted.keyId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(minted.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.createdAt).toBe(1_700_000_000_000);
    expect(decodeServerIdentityRoot(JSON.parse(JSON.stringify(minted))))
      .toEqual(minted);
  });

  test("each mint is a distinct key with a distinct key id", () => {
    const a = root();
    const b = root();
    expect(a.key).not.toBe(b.key);
    expect(a.keyId).not.toBe(b.keyId);
  });

  test("anything but a complete current-version record decodes to no root", () => {
    const minted = root();
    for (
      const broken of [
        undefined,
        null,
        "a string",
        {},
        { ...minted, version: 2 },
        { ...minted, keyId: "short" },
        { ...minted, key: `${minted.key}=` },
        { ...minted, createdAt: -1 },
        { ...minted, createdAt: 1.5 },
        { ...minted, key: undefined },
      ]
    ) {
      expect(decodeServerIdentityRoot(broken)).toBeUndefined();
    }
  });

  test("only a genuinely absent record may be initialized", () => {
    const minted = root();
    expect(readServerIdentityRootRecord(undefined)).toEqual({ type: "absent" });
    expect(readServerIdentityRootRecord(minted))
      .toEqual({ type: "existing", root: minted });

    for (const unreadable of [null, {}, { ...minted, version: 2 }, "garbage"]) {
      expect(readServerIdentityRootRecord(unreadable))
        .toEqual({ type: "unreadable" });
    }
  });

  test("a durable consumer adopts once, then quarantines a replaced key", () => {
    const current = root();
    expect(decideServerIdentityBinding(undefined, current.keyId))
      .toEqual({ type: "adopt" });
    expect(decideServerIdentityBinding(current.keyId, current.keyId))
      .toEqual({ type: "compatible" });
    const replaced = root();
    expect(decideServerIdentityBinding(current.keyId, replaced.keyId))
      .toEqual({ type: "incompatible", persisted: current.keyId });
  });

  test("identities are a function of the root's key material, not its key id", async () => {
    const minted = root();
    const entity = await makeEntityIdentity(sealingKeyOf(minted), "db", 42);
    expect(entity).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const reread = decodeServerIdentityRoot(JSON.parse(JSON.stringify(minted)))!;
    expect(await makeEntityIdentity(sealingKeyOf(reread), "db", 42)).toBe(entity);

    const replaced = root();
    expect(await makeEntityIdentity(sealingKeyOf(replaced), "db", 42))
      .not.toBe(entity);

    expect(
      await makeEntityIdentity(
        { keyId: replaced.keyId, material: minted.key },
        "db",
        42,
      ),
    ).toBe(entity);
  });
});
