# Live-query social card

A 1600×900 still of the schema and an inline
`useLiveQuery(db, Query.from(Todo).where({ title }))`, with `title` coming in
as a string prop. No wordmark, no site URL — just the code. Captured at 2×
so it stays sharp in the timeline.

```sh
bun website/scripts/social/capture.mjs
```

Open `live-queries.html` in a browser to preview. Output:
`website/public/social/live-queries-twitter.png`.
