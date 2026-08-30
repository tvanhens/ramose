# Recorded replication frames

`optimistic-fence.ndjson` and `optimistic-fence.client.json` are generated from
the local Worker stack. Do not edit them by hand.

Regenerate both files with:

```sh
bun run record:frames
```

The recorder opens an authenticated replication session and saves the emitted
wire lines and matching client metadata. The browser suite serves the recording
as static bytes and decodes it with the product frame codec, so incompatible
recordings fail the suite. Generated opaque identities may change between runs.
