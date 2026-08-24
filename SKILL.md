---
name: recipes
description: Operate a website through its accessibility tree instead of screenshots — snapshot, click, fill by ref, record real network traffic, and replay flows in-page (same TLS/UA/cookies as your real logged-in browser). Use this instead of screenshotting whenever a task involves driving a website.
---

# recipes

A CLI that drives your real, logged-in Chrome (dedicated profile at `~/.web/profile`) via the accessibility tree — no screenshots, no coordinate guessing. Every action either resolves against a labeled element or raises a typed error; nothing silently "succeeds" against the wrong target.

## Core loop

No setup step needed — just start using it. The first command that touches Chrome starts it automatically if it isn't already running (that first call takes a few seconds; every one after is fast). Chrome then stays running — nothing else here is a daemon, every later command just reconnects to it.

```
recipes open <url> --session work           # opens or reuses a tab named "work"
recipes snapshot --session work --interactive   # list only clickable/fillable elements, with refs
recipes click e17 --session work
recipes fill e33 "search text" --session work
recipes snapshot --session work --interactive --diff   # only what changed since the last snapshot
```

Always prefer `--interactive` and `--diff` over a full snapshot — a full accessibility tree on a busy page can be large; the interactive filter and diff mode keep it to only what matters for the next decision.

If a snapshot shows a login wall or `needs-human` fires, stop and tell the user — don't try to guess past it:

```
recipes needs-human --session work
```

## Recipes — for a flow you'll repeat

Record once, replay fast and same-origin from then on:

```
recipes record out.json --session work --duration 15000   # capture real XHR/Fetch traffic
recipes recipe show my-flow.json                            # human-readable dry-run before running
recipes recipe run my-flow.json --session work --json
```

A recipe has steps in one of two modes:

- **`fetch`** — replays via `page.evaluate(() => fetch(...))`, same cookies and TLS fingerprint as the real browser. Never a standalone HTTP client, which gets a different fingerprint. Use this when the site's endpoint doesn't require a per-request signed token.
- **`dom`** — locates an element by role + name (not a raw ref — those don't survive between runs) and reads its text, clicks it, or fills it, using the same trusted-input engine as the core loop above. **Use this whenever `fetch` gets rejected with a 400/403 on an otherwise-correct request** — that's usually a site requiring a rotating, per-page signed token (confirmed live on GitHub's own internal API, which needs a fresh `X-Fetch-Nonce` per request that can't be read once and reused). Don't try to reverse-engineer the token; switch the step to `dom` mode instead.

A recipe's `expect` clause is checked on every run — `status`/`json.path`/`text` for exact match, or `...Contains` for substring match (needed when the real value legitimately varies, like a count). If a step's actual result doesn't match, the run stops and reports exactly which assertion failed — it does not continue and report false success.

## Rules

- Never use `context.request` / `page.request` for replay — verified to carry a different TLS fingerprint than in-page `fetch()`, which defeats the entire point of staying inside the real session.
- Never attempt to solve a Turnstile/CAPTCHA challenge programmatically. Surface `needs-human` and ask the user to clear it in the visible Chrome window.
- A stale ref (element gone after navigation) raises an error — re-snapshot rather than retrying blindly.
