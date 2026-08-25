# Live-query social cards

Twitter-ready stills of the live-query spelling. Same brand palette as
`public/og.png` (black / forest / green), captured at 2× so the code stays
sharp in the timeline.

```sh
# system Chrome
bun website/scripts/social/capture.mjs
bun website/scripts/social/capture.mjs twitter   # 1600×900 landscape
bun website/scripts/social/capture.mjs card      # 1080×1350 4:5 cheat sheet
```

Open `live-queries.html?shot=twitter` in a browser to preview. Output lands
in `website/public/social/`.
