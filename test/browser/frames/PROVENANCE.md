# Recorded replication frames

`optimistic-fence.ndjson`, `optimistic-fence-resume.ndjson`,
`optimistic-fence-change.ndjson`, and `optimistic-fence.client.json` are
generated from the local Worker stack. Do not edit them by hand.

Regenerate every file with:

```sh
bun run record:frames
```

The recorder opens an authenticated replication session and saves the emitted
wire lines and matching client metadata: one activation's snapshot, the
acknowledgement a client resuming that exact revision is answered with, and the
change a real commit emits over it. The browser suite serves the recordings as
static bytes and decodes them with the product frame codec, so incompatible
recordings fail the suite. Generated opaque identities may change between runs.
