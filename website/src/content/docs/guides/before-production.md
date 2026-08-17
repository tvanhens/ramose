---
title: Before production
description: The checklist between "it works on my laptop" and "it is on the internet" — starting with the fact that a fresh peer is open to everyone.
---

A freshly deployed Ripple peer accepts every request, from anyone, with full
rights. That is the right default for a laptop and the wrong one for the
internet. Work down this list before you point real users at it.

## Close the front door

- [ ] **Set a policy, or a shared token.** With neither `RIPPLE_POLICY` nor
      `RIPPLE_TOKEN` set, every caller is an administrator on every database.
      Use a [policy](/guides/permissions/) for anything a browser talks to; a
      shared `RIPPLE_TOKEN` is only appropriate when the sole caller is your own
      backend.
- [ ] **Complete the verifier.** A policy needs `RIPPLE_JWKS_URL`,
      `RIPPLE_JWT_ISS`, and `RIPPLE_JWT_AUD`. Pass the same `auth` object to
      `Ripple.Server` and the deploy fails loudly when one is missing — better
      than a peer that denies every request at runtime.
- [ ] **Narrow the origins.** Without a policy, the peer answers CORS for `*`.
      Set `RIPPLE_ALLOWED_ORIGINS` to your own origins. An empty list sends no
      CORS header at all, which blocks browsers entirely — that is a valid
      choice for a peer only Workers call.
- [ ] **Cap token lifetime.** `RIPPLE_JWT_MAX_TTL` defaults to 900 seconds.
      Short tokens matter here: a revoked *grant* takes effect on the next
      write, but a revoked *token* is only gone when it expires.
- [ ] **Declare `admin` deliberately.** A token with class `admin` bypasses
      every rule and is the only class that may call `explain` or the
      `/admin/*` routes. Do not hand it to a browser.
- [ ] **Check the demo console is gone.** The peer serves a small demo app at
      `/` until a policy is configured. Load your peer's root URL and confirm
      you get a 404.
- [ ] **Pin the internal secret.** Set `RIPPLE_INTERNAL_SECRET` so the
      Worker-to-writer gate does not rotate on every deploy.
- [ ] **Pass your pull patterns to the compiler.**
      `Ripple.Policy.compile(policy, { pulls: [...] })` turns "this masked field
      silently deletes rows" into a build error. Without `pulls`, the check does
      not run.

## Decide what you keep

- [ ] **Choose a retention window.** `RIPPLE_RETAIN_ROOTS` (default **20**)
      is how many published versions of the storage tree survive garbage
      collection. Everything older is swept, which means `db.asOf(t)` for an
      older `t` no longer resolves and that history is gone.
- [ ] **Understand the unit.** Roots are published per index run, and index
      runs are driven by `RIPPLE_INDEX_TX_THRESHOLD` (500 transactions) and
      `RIPPLE_INDEX_INTERVAL_MS` (5 s). "20 roots" is therefore roughly "the
      last 20 index runs" — it is not a number of days, and a busy database
      ages out faster than a quiet one. If you promise your users an audit
      trail, raise it deliberately.
- [ ] **Know what a teardown does and does not do.** Deleting a
      `Ripple.Database` or `Ripple.Server` resource deletes no data, on
      purpose. `alchemy destroy` leaves the bucket and the Durable Object
      namespaces behind — safe, and still billable. Dropping data is a manual
      act.
- [ ] **Have a copy story.** Ripple ships no export command. Your data lives in
      your own R2 bucket plus the writer's storage, so a bucket-level copy
      captures everything already folded into the tree but not writes newer
      than the last index run. Plan accordingly if this matters to you.

## Size it honestly

- [ ] **One database sustains low thousands of writes per second** — roughly
      2.5–2.9k small transactions per second in-process and ~1.7k through the
      Worker path on development hardware. There is exactly one writer per
      database and that is not configurable.
- [ ] **Split rather than scale up.** More write throughput means more
      databases, divided along ownership lines. There are no joins across
      databases: a view that spans them is one query per database, merged in
      your app. See [the runbook](/reference/runbook/#the-write-ceiling).
- [ ] **Set a query budget you understand.** `RIPPLE_QUERY_MAX_CELLS` defaults
      to 1,572,864 cells (about 48 MB of intermediate results). Over-budget
      queries fail with `QueryBudgetExceeded` (413), and a standing live query
      does not retry them.
- [ ] **Remember `limit` does not bound server work.** Paging happens after the
      full result arrives, so a `limit(20)` on a broad query still costs — and
      can still exceed — the whole query.

## Handle the failures that will happen

- [ ] **503 `Unavailable`.** The writer restarts (deploys, storage faults) and
      returns a `retryAfterMs`. Retrying is safe: nothing from a failed batch is
      durable, and version numbers never gap. Surface it as a retry, not an
      error.
- [ ] **413 `QueryBudgetExceeded`.** Not retryable. Log the clause the error
      names and fix the query.
- [ ] **403 / 409 on writes.** A policy refusal arrives as `Unauthorized` from
      the edge check or `TxRejected` from the writer. Handle both — see
      [Permissions](/guides/permissions/#what-a-denial-looks-like).
- [ ] **Reconnection is already handled.** Standing live queries retry network
      failures with backoff and re-authenticate in place. Four failures are
      terminal and need your attention:
      `InvalidRequest`, `DatabaseNotFound`, `Unauthorized`,
      `QueryBudgetExceeded`.

## Deploy hygiene

- [ ] **Use stages.** `bun alchemy deploy` ships your personal stage;
      `--stage prod` is production. Stages are isolated copies of the whole
      stack.
- [ ] **Expect the first deploy to wait.** `Ripple.Server` probes `GET /health`
      up to 30 times, 2 seconds apart, before anything binds to it. A slow first
      DNS propagation looks like a hang; `probe: false` skips it.
- [ ] **Install the catalog from one place.** `Ripple.Database` at deploy for
      known databases, `db.install()` at signup for per-customer ones. Never per
      request.

Every variable named here is in the [configuration
reference](/reference/configuration/), and every error tag in the [errors
reference](/reference/errors/).
