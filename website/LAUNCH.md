# Documentation release checklist

The public documentation describes the graph-of-graphs, offline client,
operation authorization, and fixed MCP surface currently landing in parallel.
Before publishing a release, verify the prose and samples against the final
exported contracts rather than restoring retired examples.

```sh
cd website
bun run check
bun run build
```

## Product contracts to verify

- `ramose/client` and `ramose/react` export names and state unions.
- Graph trait declaration, typed `.db()` traversal, path rename, and archive.
- Query builder lowering and the complete `QueryDocumentV1` grammar.
- Entity- and trait-owned operations, optimistic projections, and receipts.
- Read policy compilation and exact `Policy.invoke(...)` grants.
- MCP Streamable HTTP and OAuth behavior at `POST /mcp`.
- The fixed `describe`, `query`, and `mutate` request and error contracts.
- Production query, discovery, retention, and synchronization defaults.

## Editorial invariants

- No sample application or screenshots are required to understand the model.
- Start pages form one path: value → mental model → starter → MCP.
- Each guide explains tradeoffs and failure states, not only syntax.
- Reference pages distinguish public names from internal identities.
- Browser, Worker, and MCP callers share the same catalog, policy, and operations.
- Claims about planned providers and pre-release stability remain clearly labeled.
