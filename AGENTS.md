# Ramose

Bun workspace. The published package is `packages/ramose` (npm: `ramose`).
Consumer demos live in `examples/*`.

See `README.md` for the product overview and `CONTRIBUTING.md` for local
commands, tests and CI. Documentation lives at [ramose.ai](https://ramose.ai)
(source in `website/`). There is no in-repo `docs/` folder.

## Cursor Cloud specific instructions

Cursor Cloud Agent environment and runtime caveats live in
[`.cursor/CLOUD.md`](.cursor/CLOUD.md). Read that file when working as a
Cursor Cloud Agent.

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation
details when the documentation isn't enough.

Note: this is the canonical [`Effect-TS/effect`](https://github.com/Effect-TS/effect)
repo, whose `main` branch is v4. The `effect-smol` repo the Effect Solutions guide
names is archived. Update with
`git -C ~/.local/share/effect-solutions/effect pull --depth 1`.

## Effect Language Service

This repo is on TypeScript 7 (native), so the Effect diagnostics come from
[`@effect/tsgo`](https://github.com/Effect-TS/tsgo), not the `@effect/language-service`
tsserver plugin that the Effect Solutions guide describes — TS7 does not load
JS TS plugins. `@effect/tsgo` patches the native `tsc` binary; the `prepare`
script re-applies the patch on every install, so `bunx tsc --version` should
report `7.0.2+effect-tsgo.<version>`. If it prints a bare version, Effect
diagnostics are silently off — run `bunx effect-tsgo patch --typescript --no-oxlint`.

Effect diagnostics surface as `TS377xxx` codes in `bun run typecheck` and count
toward its exit code. Suppress with a scoped directive rather than disabling the
rule globally — both forms are verified against this repo's setup:

```ts
// @effect-diagnostics-next-line floatingEffect:off   <- suppresses the next line only
// @effect-diagnostics floatingEffect:off             <- suppresses for the whole file
```

Prefer the `-next-line` form. The file-level form is appropriate for type-level
test fixtures (`packages/ramose/test/db/*-types.ts`), where bare expressions are
deliberate type assertions rather than dropped effects.
<!-- effect-solutions:end -->
