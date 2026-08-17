# Query navigation typing gate (issue #18)

**Verdict: PASS** on TypeScript 5.9.3. The spelling `Todo.owner.friends.name` is
typeable without `Type instantiation is excessively deep` / TS2615, under both a
depth-capped inferred encoding and an interface-deferred encoding.

This derisks the single riskiest claim in [QUERY.md](./QUERY.md) §9 before any
API rewrite. Prototype code lives under
`packages/alchemy/test/db/nav-prototype/` and is **not** exported from
`@ripple/alchemy/db`.

## Gate

```ts
typeof Todo.owner.friends.name
// ident ":user/name", schema Schema.String
```

Also checked: `User.friends.friends.name`, `Comment.author.friends.name`,
`Comment.replyTo.body`, and (interface encoding) four-hop
`IfaceTodo.owner.friends.friends.friends.name`.

## Encodings

| Encoding | How `Ref.self` closes | Result |
|---|---|---|
| **Depth-capped inference** (`types.ts` `StampedMap<…, D=6>`) | `Ref.self` → `RefAttr<StampedMap<Ns, Attrs, D-1>>`; at `D=0` target stays `SelfMarker` | PASS. Default for a future production `Namespace`. Budget exhausts on the 7th self-hop (`depth-stress.ts`). |
| **Interface-deferred** (`IfaceUserAttrs`) | Named interface; `RefAttr<IfaceUserAttrs>` — TS resolves one property access at a time | PASS. Matches QUERY.md's note that cycle members may need an annotation. |
| **Uncapped inference** (`inferred-uncapped.ts`) | `Ref.self` → `RefAttr<UncappedStampedMap<Ns, Attrs>>` with no hop budget | PASS on TS 5.9.3 (circular mapped type deferred through the `RefAttr` parameter). Depth cap kept anyway as a safety rail. |

An earlier intermediate encoding (string-index `AttrMap` + uncapped substitute)
did hit **TS2615** (`Type of property 'friends' circularly references itself in
mapped type`). Avoid string index signatures on attr maps so `keyof` stays
narrow.

## `tsc --extendedDiagnostics` (regenerate: `./packages/alchemy/test/db/nav-prototype/measure.sh`)

Isolated prototype project (`nav-prototype/tsconfig.json`):

| Metric | Value |
|---|---|
| Files | 322 |
| Lines of TypeScript | 495 |
| Instantiations | 2561 |
| Check time | 0.10s |
| Total time | 0.88s |
| Memory | ~211 MB |

Full workspace (includes the prototype + the rest of the monorepo):

| Metric | Value |
|---|---|
| Instantiations | ~152k |
| Check time | ~2.1s |
| Total time | ~5.4s |

No `excessively deep` errors. Instantiations for the prototype slice are
negligible next to the existing client surface.

## Design notes for the real implementation

1. **Do not stamp a public `.name` field on attrs.** Today's production
   `Namespace` stamps `name` + `ident` ([Namespace.ts](../packages/alchemy/src/db/Namespace.ts)).
   Navigation wants `Todo.owner.name` to mean the target's `name` attribute.
   The prototype uses `attrName` + `ident` so the key does not shadow. Production
   must pick the same (or a symbol / `_name`) before shipping navigable refs.
2. **`Nav<A> = A & TargetAttrs`** is enough for one-hop resolution when the
   target map is deferred (interface or depth-capped mapped type).
3. **`Ref(() => User)`** capturing `N["attributes"]` types cross-namespace hops
   (`Todo.owner.friends`) without annotating `Todo`.
4. **Runtime** can mirror the type with a Proxy that forwards unknown keys to
   the target namespace's stamped map (see `Namespace` in the prototype). Tests
   in `nav-prototype.test.ts` cover the gate path at runtime.
5. Namespace-branded `Eid` with a **required** unique-symbol key is sketched in
   the prototype types but not measured here — separate from the path gate.

## How to re-run

```sh
bunx tsc --noEmit -p packages/alchemy/test/db/nav-prototype/tsconfig.json --extendedDiagnostics
bun test packages/alchemy/test/db/nav-prototype
bun run typecheck   # whole workspace, includes the gate fixtures
```
