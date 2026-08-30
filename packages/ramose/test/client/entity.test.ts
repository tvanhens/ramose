
import { describe, expect, test } from "bun:test";
import { clientRef, unsafeEntityId, type MutationRef } from "../../src/db/refs.ts";
import type { AnyComposer } from "../../src/db/Composer.ts";
import type { ClientDatabase } from "../../src/client/database.ts";
import {
  EntityRegistry,
  EntityWithdrawnError,
  rowIdentity,
} from "../../src/client/entity.ts";
import type { MutationContext } from "../../src/client/mutation.ts";
import type { ClientOperation } from "../../src/client/operations.ts";
import type { OptimisticPending } from "../../src/internal/replication/reconciliation.ts";

const context: MutationContext = {
  databaseOperations: () => new Map(),
  selfOperations: () => new Map(),
  catalog: () => Promise.reject(new Error("not reached")),
  storage: () => Promise.reject(new Error("not reached")),
  assertLive: () => undefined,
  submit: () => undefined,
  track: () => undefined,
};

const operation = (name: string): ClientOperation =>
  ({ localName: name }) as unknown as ClientOperation;

const focus = { _tag: "Entity", ns: "issue" } as unknown as AnyComposer;
const trait = { _tag: "Trait", ns: "taggable" } as unknown as AnyComposer;

const database = {} as ClientDatabase;

const FULL = "full-row";
const IDS = "ids-row";

const declared = (composer: AnyComposer): ReadonlyMap<string, ClientOperation> =>
  composer === trait
    ? new Map([["addTag", operation("addTag")]])
    : new Map([["close", operation("close")]]);

const registry = () => new EntityRegistry(context, database, declared);

const pending = (
  ref: MutationRef,
  created: boolean,
): OptimisticPending =>
  new Map([[ref, {
    ref,
    invocations: [],
    state: "queued" as const,
    created,
  }]]);

describe("entity handle interning", () => {
  test("one entity is one object, whose data is replaced rather than rebuilt", () => {
    const entities = registry();
    const id = unsafeEntityId("a".repeat(54) + "A");
    const first = entities.handle(id, focus, FULL, { id, title: "Offline" });
    const second = entities.handle(id, focus, FULL, { id, title: "Renamed" });
    expect(second).toBe(first);
    expect(first.data).toEqual({ id, title: "Renamed" });
  });

  test("a client ref and the entity id it maps to become one handle", () => {
    const entities = registry();
    const ref = clientRef();
    const id = unsafeEntityId("b".repeat(54) + "A");
    const created = entities.handle(ref, focus, FULL, {
      id: ref,
      title: "Created offline",
    });
    expect(created.id).toBe(ref);

    entities.alias(ref, id);

    expect(created.id).toBe(id);
    expect(entities.handle(ref, focus, FULL, { id })).toBe(created);
    expect(entities.handle(id, focus, FULL, { id })).toBe(created);
  });

  test("`.local` follows the layers, and a settled entity says so", () => {
    const entities = registry();
    const ref = clientRef();
    const handle = entities.handle(ref, focus, FULL, { id: ref });
    expect(handle.local).toEqual({ pending: false, created: false });

    expect([...entities.observe(pending(ref, true))]).toEqual([handle]);
    expect(handle.local).toEqual({ pending: true, created: true });
    expect([...entities.observe(pending(ref, true))]).toEqual([]);

    expect([...entities.observe(new Map())]).toEqual([handle]);
    expect(handle.local).toEqual({ pending: false, created: false });
  });

  test("clearing drops every handle, so a replaced partition answers nothing", () => {
    const entities = registry();
    const id = unsafeEntityId("c".repeat(54) + "A");
    const before = entities.handle(id, focus, FULL, { id });
    entities.clear();
    expect(entities.handle(id, focus, FULL, { id })).not.toBe(before);
  });

  test("a withdrawn handle keeps saying what it was and refuses to mutate", () => {
    const entities = registry();
    const id = unsafeEntityId("e".repeat(54) + "A");
    const handle = entities.handle(id, focus, FULL, { id, title: "Offline" });

    entities.clear();

    expect(handle.data).toEqual({ id, title: "Offline" });
    expect(handle.id).toBe(id);
    expect(handle.local).toEqual({ pending: false, created: false });
    expect(() => handle.mutate.close!()).toThrow(EntityWithdrawnError);
  });

  test("two query shapes are two views of one entity, not one overwritten slot", () => {
    const entities = registry();
    const id = unsafeEntityId("f".repeat(54) + "A");
    const full = entities.handle(id, focus, FULL, { id, title: "Offline" });
    const ids = entities.handle(id, focus, IDS, { id });

    expect(ids).not.toBe(full);
    expect(full.data).toEqual({ id, title: "Offline" });
    expect(ids.data).toEqual({ id });
    expect(ids.id).toBe(full.id);
  });

  test("aliasing reaches every shape the entity has been seen under", () => {
    const entities = registry();
    const ref = clientRef();
    const id = unsafeEntityId("g".repeat(54) + "A");
    const full = entities.handle(ref, focus, FULL, { id: ref, title: "Created" });
    const ids = entities.handle(ref, focus, IDS, { id: ref });

    entities.alias(ref, id);

    expect(full.id).toBe(id);
    expect(ids.id).toBe(id);
    expect(entities.handle(id, focus, FULL, { id })).toBe(full);
    expect(entities.handle(id, focus, IDS, { id })).toBe(ids);
  });

  test("one entity's two focuses keep their own declared methods", () => {
    const entities = registry();
    const id = unsafeEntityId("h".repeat(54) + "A");
    const asEntity = entities.handle(id, focus, FULL, { id });
    const asTrait = entities.handle(id, trait, FULL, { id });

    expect(asTrait).not.toBe(asEntity);
    expect(Object.keys(asEntity.mutate)).toEqual(["close"]);
    expect(Object.keys(asTrait.mutate)).toEqual(["addTag"]);
  });

  test("a mapped creation stays pending under the identity it now answers to", () => {
    const entities = registry();
    const ref = clientRef();
    const id = unsafeEntityId("i".repeat(54) + "A");
    const created = entities.handle(ref, focus, FULL, { id: ref });
    entities.observe(pending(ref, true));
    expect(created.local).toEqual({ pending: true, created: true });

    entities.alias(ref, id);
    entities.observe(pending(ref, true));
    expect(created.id).toBe(id);
    expect(created.local).toEqual({ pending: true, created: true });

    const late = entities.handle(id, focus, IDS, { id });
    expect(late.local).toEqual({ pending: true, created: true });
  });
});

describe("row identity", () => {
  test("is the opaque id a row carries, and nothing else", () => {
    const id = unsafeEntityId("d".repeat(54) + "A");
    expect(rowIdentity({ id, title: "Offline" })).toBe(id);
    expect(rowIdentity({ title: "Offline" })).toBeUndefined();
    expect(rowIdentity({ id: 1_000 })).toBeUndefined();
    expect(rowIdentity(null)).toBeUndefined();
  });
});
