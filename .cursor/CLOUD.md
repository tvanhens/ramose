# Cursor Cloud

Dependencies and Bun are installed when the environment starts. Use the commands
in `CONTRIBUTING.md` for checks.

Start the local peer with:

```sh
bun run dev:todos
```

It listens on `http://localhost:1337`. The script supplies the placeholder
credentials required by the local emulator.

Cloudflare e2e requires `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in Cursor Secrets:

```sh
bun run test:e2e:cf
```
