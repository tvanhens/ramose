# Recorded replication frames

`optimistic-fence.ndjson` and `optimistic-fence.client.json` are a **recording of
real server output**, not hand-authored data. Do not edit either file.

## How they were produced

```sh
bun run record:frames
```

That runs [`scripts/record-optimistic-fence-frames.ts`](../../../scripts/record-optimistic-fence-frames.ts),
which deploys the ordinary Alchemy local stack, seeds a real conformance world,
opens one authenticated `POST /db/:name/replicate` activation against the real
Worker, and writes the verbatim NDJSON lines that Worker produced — read through
the same public frame codec the product uses. The recorder is
[`test/local/record-frames.ts`](../../local/record-frames.ts); it is inert unless
`RAMOSE_RECORD_FRAMES=1`, so no ordinary lane can write here.

- `optimistic-fence.ndjson` — the verbatim wire lines, in the order the Worker
  wrote them: `SnapshotStart`, `SnapshotChunk`…, `SnapshotCommit`.
- `optimistic-fence.client.json` — the client half of the same recording: the
  `ReplicationIdentity` the frames carry, and the `AttributeSpec[]` derived from
  the datoms they contain. The browser suite reads both from here and pins
  nothing of its own, so a re-recording stays self-consistent.

The opaque identities are minted by the local Worker and change on every
re-recording. That is expected; the browser suite never spells them out.

## Why a recording rather than a live activation

The browser lane is a Chromium page served by Vite: no Worker, no Durable
Object, no R2. `ReplicationSession`'s settled-frame path — the one #476's
observation fence hangs off — only runs when real frames arrive over a real
response, so the frames are recorded here and replayed there as inert bytes by
the static middleware in `vitest.browser.config.ts`. Nothing in that middleware
is a peer: no protocol state machine, no request parsing, no per-call scripting.

## Drift

`test/browser/optimistic-layers.browser.test.ts` fetches this stream through the
exact path the session uses and decodes every line with `decodeReplicationFrame`
before any other assertion runs, so a protocol change this recording predates
fails loudly instead of silently weakening the suite. When it does, re-record.

Provenance lives here rather than inside the `.ndjson` because that file is
consumed by a strict line-oriented decoder — a comment line would not decode,
and that strictness is itself part of the drift check.
