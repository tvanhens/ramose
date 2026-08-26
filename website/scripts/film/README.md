# How a query is made

A 36-second brand film for X: facts are stamped as `[entity · attribute · value · time]`, then a frontend query is filtered per-fact by the policy that lives in the database.

```sh
# preview
bun website/scripts/film/serve.mjs

# render 1920×1080 H.264 (needs system Chrome + ffmpeg)
bun website/scripts/film/capture.mjs
```

Output lands in `website/scripts/film/out/how-a-query-is-made.mp4` (gitignored).
The rendered file is the shareable artifact; this folder is the source.
