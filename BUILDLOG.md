# Build log

The honest, live-verified history of how this was built — every bug found, every claim actually tested, in order. For installing and using the tool, see [README.md](README.md); this file is the record of *how it got proven to work*, not the user guide. The [original design doc](https://manuqwert1234.github.io/recipe/design.html) records the decisions made before any of this was built, including the alternatives considered and rejected.

## Faster, fewer tokens, easier to integrate (this pass)

Asked to push all three at once. Profiled first rather than guessing where the cost was.

- **Found: `recipe show` — pure JSON parsing, zero Chrome interaction — took 291ms.** Profiled it directly: ~250ms of that was `playwright-core` import overhead, paid even though the command never touches a browser, because every command shared one static top-of-file import block. **Fixed:** converted every command to lazy, per-handler `import()` — each command now pays only for what it actually uses. `recipe show`: **291ms → 46ms (6.3x)**. `recipe run --dry-run` also no longer needs Chrome running at all — genuinely new capability, not just faster.
- **Found, while restructuring: `recipe watch`'s CLI command never passed `session` through to `watchTick`** — a real latent bug where any `dom`-mode step running under the actual live cron job was using the wrong session name for its ref cache (functionally harmless so far — the page itself still resolved correctly — but wrong). Fixed while touching the same code.
- **Found, verifying the fix: the live crontab recipe's own `ttl` (1h) was wrong for its job.** A `dom`-mode recipe's locators don't rot on an hourly timescale the way a `fetch`-mode recipe's exact API shape can — but running it under a 30-minute cron schedule meant it would fail its own staleness check every tick after the first hour, correctly-but-uselessly. Fixed: `ttl` bumped to `30d`, `recordedAt` refreshed. This was ttl enforcement (added earlier this session) actually catching a real misconfiguration, exactly as designed — just found on the tool's own shipped recipe rather than a hypothetical one.
- **Integration: removed the mandatory `recipes browser start` step.** `connect()` now auto-starts Chrome if it isn't already running, instead of throwing and telling the caller to run a separate command first. Tested from a fully cold state — Chrome stopped, zero prior setup — through both the CLI (`recipes open ...` directly) and the MCP server (`mcp/test-client.js`, itself fixed to be self-contained rather than depending on a stale hardcoded session name from earlier testing). Both worked, no manual step. First call after cold start pays Chrome's own startup cost (~4.5s); every call after is normal speed.

## Against a real, installed market CLI — `@playwright/cli`

Installed the actual package (`npm i -g @playwright/cli@latest`, from Playwright's own README, which explicitly markets it as "more token-efficient than MCP"), attached it to real Chrome with a persistent profile, and ran it against the identical live Wikipedia article as `recipes`, same moment.

- **Speed, warm, 3 runs each:** recipes ~450–560ms avg ~490ms; `@playwright/cli` ~730–900ms avg ~790ms. **recipes ~1.6x faster**, consistently.
- **Tokens, same page:** `@playwright/cli`'s `snapshot` has no interactive-only filter and no default cap — it always returns the whole tree: **137,444 chars**. recipes, same page: **4,202 chars interactive-filtered, 4,167 chars in full (capped) mode** — both ~33x smaller.
- **The honest caveat, not glossed over:** this is not "our engine collects less data." recipes' own uncapped element count on this page (2,149) is the same ballpark as `@playwright/cli`'s output (2,022 lines) — the underlying accessibility walk is comparably thorough on both sides. The real difference is that recipes ships a default 150-element cap with an explicit truncation notice *and* a purpose-built interactive filter, and `@playwright/cli` — aimed more at test authoring/codegen than agent token budgets — offers neither by default (only an uncapped `--depth` option). A real, structural, verifiable product difference, not a rigged comparison — but worth naming precisely rather than overclaiming.

## Cross-platform support (Linux, Windows)

Was macOS-only — not by design, just because that's the only machine available to build and verify on. Two real gaps closed:

- **`chromeExecutablePath()` rewritten from one hardcoded guess per platform to a real candidate list, existence-checked.** Linux checks the actual common install locations across distros (`google-chrome-stable`, `google-chrome`, `chromium-browser`, `chromium`, the snap path). Windows checks the modern per-user install under `%LOCALAPPDATA%` *first* — Chrome's installer defaults there without admin rights, which is a real, common case a single Program Files path would silently miss — then both Program Files variants. Whichever candidate actually exists on disk wins; if none do, the error names every path that was checked, rather than a mysterious downstream spawn failure.
- **`package.json`'s `"os": ["darwin"]` was an active blocker**, independent of whether the code worked — npm refuses to even attempt an install on a platform not listed there. Fixed to `["darwin", "linux", "win32"]`.
- **`process.kill(pid, "SIGTERM")` in `stopBrowser()` needed a second look for Windows**, which has no real POSIX signals. Confirmed (via Node's own documented behavior, not run on real Windows) that any signal name forcefully terminates the target process there — acceptable, since Chrome doesn't need a graceful SIGTERM to release its profile lock cleanly.
- **Stated honestly, not glossed over: none of this ran on an actual Linux or Windows machine.** No Docker was available in this environment to at least verify the Linux path for real, and there's obviously no way to run Windows from here. "Implemented, with real researched paths" is the accurate claim; "verified" is not — that stays true only for macOS until someone runs it on the other two.

## Status

All 8 phases from the design doc are implemented, plus a second pass of real bug fixes found by actually running it against live sites (including a real GitHub account) and a real cron schedule — not just unit-tested in isolation.

| Phase | What | Verified live |
|---|---|---|
| 0 | Preconditions | ✅ P0a (TLS divergence), P0c (JSONP finding), P0b closed with a real human click — see the Cloudflare section |
| 1 | Chrome bootstrap + sessions | ✅ incl. two real bugs found and fixed — see Known bugs fixed |
| 2 | Snapshot + refs | ✅ click, fill, `--diff`, `--interactive`, ambiguous-match warning, all against real page state changes |
| 3 | Recipe format + `show` | ✅ plus `ttl`/`auth_binding`/`start_url` now actually enforced, not just documented |
| 4 | `record` → recipe generation | ✅ `recipe from-network` builds a draft recipe from a real capture — proven end to end |
| 5 | `run` + verification | ✅ `fetch` and `dom` modes both proven live against a real account; fail-loud confirmed on real failures |
| 6 | `watch` + cron | ✅ a real crontab entry is installed and its exact invocation (binary path, minimal env) has been tested standalone |
| 7 | Surfaces | ✅ `SKILL.md` + MCP server, registered with Claude Code and confirmed connected |

## Head-to-head against a real market tool (this pass)

Ran `recipes` and Claude Code's own `claude-in-chrome` extension (`read_page`) against the identical live URL, back to back, and measured real output size — not a simulation, not a cited number.

- **GitHub repo README page:** roughly tied (9,393 vs 9,671 chars) — but confounded: `recipes` was logged in (extra nav/notifications chrome), `claude-in-chrome`'s tab wasn't. Not a clean comparison.
- **Wikipedia long-article page (controlled — neither tool logged in):** `recipes` came back **3x larger** (13,897 vs 4,683 chars, 508 vs 69 elements). Real, uncomfortable result, reported as found.
- **Root cause, diagnosed:** `recipes`' snapshot walked the *entire* accessibility tree with no cap — 486 links, mostly citation references at the bottom of the article, nowhere near the viewport. `claude-in-chrome` caps itself by default; `recipes` didn't, despite the original design doc explicitly promising "a hard cap per snapshot with explicit truncation markers, never silent" — a promise that was never actually implemented in the code until this was found.
- **Fixed:** a default 150-node cap with an explicit, printed truncation notice (`"N more elements not shown (total) — use --within to scope"`), never silent. Retested on the identical Wikipedia page after the fix: **4,088 chars — now smaller than `claude-in-chrome`'s 4,683**, with the truncation clearly stated rather than hidden. Unit tests still pass; the earlier GitHub session's normal case (well under the cap) is unaffected; a separate page that also exceeds 150 elements now truncates the same way, correctly.

## Trying to push further — two more real fixes, one honest mixed result

Asked to make it decisively better than the market tool, not just tied. Two more real gaps found and fixed, plus one result reported as-is rather than massaged into a win.

- **Fixed: nameless links/buttons dropped from `--interactive`.** ~10% of a typical page's "interactive" elements had no accessible name at all (`link ""`) — a screen reader couldn't identify them either, so they were pure noise, not something usefully actionable by ref. Now excluded by default; form fields are exempt since a fillable input is often still meaningful without a rich name.
- **Fixed, more importantly: closed native `<select>` elements were exposing all their `<option>` children.** Found live: Wikipedia's language `<select>` alone added 77 elements to *every single snapshot*, before anyone ever opened it. Worse than noise — a closed native `<select>` renders as an OS-level control, so a trusted CDP click can't target one of those collapsed options the way it targets a real rendered element anyway. `role === "option"` is now excluded from `--interactive` by default; the `<select>` itself (as a `combobox`) still shows.
- **The honest part: a real multi-step, round-trip comparison came out mixed, not a clean sweep.** Tested "read → click language picker → read again" on the identical interaction, both tools: `claude-in-chrome`'s two full reads totaled 7,997 bytes; `recipes`' full-read + `--diff` totaled 8,556 bytes — **`recipes` narrowly lost this specific round-trip**, before the option-filter fix closed most of that gap (retested afterward, but the retest hit a *different*, equally real confound: all `recipes` tabs share one persistent Chrome profile, so a second test on the same site inherited Wikipedia's own `localStorage` state from the *first* test's click — the overlay loaded pre-expanded, which isn't a fair "cold" comparison either). A third attempt, on a fresh random article's table-of-contents toggle, didn't produce a measurable DOM change at all on either tool.
- **What this honestly adds up to:** two real, verified, shipped fixes that measurably reduce noise and close gaps found through genuine competitive testing — not two cosmetic tweaks. But the multi-step, real-world picture is genuinely mixed rather than a clean "always better" story, and the shared-profile design has a real, disclosed cost for benchmark cleanliness (session isolation) that's a deliberate tradeoff, not a bug — the same persistence is exactly what makes staying logged in across commands work at all. Reported as found rather than picking the flattering runs.

## MCP (Phase 7)

`mcp/server.js` exposes the same engine as 10 typed MCP tools — calls straight into `src/`, the same code the CLI calls. Verified with a real client over real stdio JSON-RPC (`mcp/test-client.js`).

**Registered with Claude Code**, scoped to this project: `claude mcp add recipes -- node <repo-path>/mcp/server.js`. To undo: `claude mcp remove recipes`.

## Cron (Phase 6)

A real crontab entry is installed:

```
*/30 * * * * cd <repo-path> && <absolute-path-to-node> bin/recipes.js recipe watch recipes/github-inbox-dom.json --session gh --json >> logs/github-inbox-watch.log 2>&1 # recipes-cli-demo
```

To remove it: `crontab -e` and delete the line (tagged `# recipes-cli-demo`), or `crontab -l | grep -v recipes-cli-demo | crontab -`.

**Real bug found installing this:** the first attempt hardcoded `/usr/local/bin/node`, which doesn't exist on this machine — the real binary is nvm-managed. Cron runs with a minimal environment (no shell profile sourced), so this would have failed silently at 30 minutes past the hour with no one watching. Fixed by testing the *exact* invocation cron uses (`env -i` with cron's real minimal PATH) before trusting it, not just running it normally from an interactive shell.

**Depends on Chrome staying up — and on the named session tab specifically, which auto-start does NOT fix.** Chrome itself now auto-starts on first use (see below), but a fresh Chrome launch only ever opens `about:blank` — it does not know that a session called `gh` is supposed to exist, logged in, on a specific page. Confirmed live: repeated `browser stop`/auto-start cycles during this session's own testing silently broke the actual crontab job's `gh` tab, and it sat failing with "No open session named gh" until manually reopened. Auto-start solves "Chrome isn't running"; it does not and cannot solve "the tab this recipe expects doesn't exist" — that still needs a human (or a recipe with dom-mode login steps, not built) to open and authenticate the session at least once after any full restart.

## Setup

```
npm install
node bin/recipes.js browser start
```

Log into any site you want to automate, once, in the window that opens — cookies persist in `~/.web/profile` from then on.

## Known bugs found and fixed (this session, second pass)

- **`connectOverCDP` crashed when Chrome had zero open tabs.** Playwright's CDP connection setup needs an existing target to attach its default context to; with no tabs it threw "Browser context management is not supported" before even reaching our code. Root cause was likely an abruptly-killed debug process from earlier testing, which can make Chrome auto-close targets tied to a dropped CDP connection. Fixed by guaranteeing a tab exists via the raw CDP HTTP endpoint (`/json/new`) before Playwright ever connects.
- **`needs-human` gave a false positive on an already-cleared Cloudflare page.** It matched `cf-turnstile`/`cf-chl` against page content — but those are CSS class name fragments that stay in the DOM whether the widget was solved or not. Fixed: those markers now also require the `cf_clearance` cookie to be *absent* before counting as a real block; title-based markers (which genuinely revert once cleared) are unchanged.
- **A hand-written recipe silently assumed the session's tab was already on the right page.** Broke the moment that tab had navigated elsewhere for any other reason — proven live when an earlier test had left the `gh` session on `/notifications` instead of the dashboard. Fixed: recipes now carry an optional `start_url`, and `run`/`watch` navigate there before executing steps, so a recipe is self-contained instead of depending on incidental tab state.
- **The same recipe's locator assumed a fixed button label** ("Expand Needs your review") — broke after an earlier live test had clicked it, toggling the label to "Collapse...". Fixed by loosening the locator to the stable substring ("Needs your review") and separately confirming via `start_url` that it's on the one page where that substring is unambiguous.
- **`findRef` had no retry, and the real cron run caught it.** The first real, unattended cron firing (17:30, logged in `logs/github-inbox-watch.log`) failed on `start_url`-navigated content that hadn't rendered yet — confirmed directly: the widget text is genuinely absent from the DOM right at `domcontentloaded` and appears ~2s later via async data fetch. Manual testing never caught this because natural pauses between commands accidentally gave it time. Fixed: `findRef` now retries with backoff (up to ~3s total) before giving up, treating "not there yet" as a timing gap rather than an instant failure. Retested 3 consecutive cold runs after the fix — all clean.

## Format enforcement — real now, not documentation

Three recipe fields used to be printed by `recipe show` but never actually checked by `run`:

- **`ttl`** — a recipe past its ttl (checked against a new `recordedAt` timestamp) now refuses to run at all, rather than replaying a possibly-rotted request shape. Tested both paths live: fresh runs normally, an artificially-aged copy correctly refuses.
- **`auth_binding: "none"`** — now actually sent with `credentials: "omit"` on `fetch` steps, so a recipe claiming to be account-independent is genuinely tested that way instead of silently riding on cookies anyway.
- **Ambiguous `dom` locators** — if a `locate` clause matches more than one element, the step no longer silently acts on the first one; it now surfaces a `warning` naming the exact matches, so a recipe author tightens the locator instead of it acting on the wrong element on some future run.

## `record` → recipe generation (the gap that used to exist)

The design doc's Phase 4 called for turning a capture into a recipe automatically; until this pass, every recipe in this repo — GitHub included — was hand-written by reading the raw capture JSON. `recipes recipe from-network <capture> <out> --site <site>` now does this: one `fetch` step per distinct real GET request, asserting the status code actually observed. Proven end-to-end live: recorded real GitHub traffic, generated a 10-step draft, ran it, and it correctly failed loud (406 — the same nonce-protection as below) rather than reporting false success. It's explicitly a **draft** — the tool says so in its own output — not a substitute for reviewing `recipe show` before trusting it unattended.

## `dom` mode (built this session, proven on a real account)

`fetch`-mode replay doesn't work everywhere — GitHub's own internal API requires a rotating, single-use `X-Fetch-Nonce` per request, generated fresh by its own JS. Reading the nonce once and reusing it still gets rejected. `dom` mode handles this: locate an element by role + name (stable across reruns, unlike a raw ref), then `read` its text, `click` it, or `fill` it — routed through the same trusted-CDP-input engine already proven in Phase 2, not a second implementation.

All three actions proven live against the real GitHub account:
- **`read`** — confirmed "no unread notifications" and empty review-inbox sections, matching the real account state.
- **`click`** — confirmed via the button's own label changing ("Expand" → "Collapse") after a trusted click.
- **`fill`** — confirmed via a search box's value genuinely changing, checked with `--diff`.

`recipes/github-inbox-dom.json` is a real, repeatable, currently-scheduled (see Cron above) recipe against your actual account.

## Verified live, first pass

- **P0a (TLS fingerprint):** `page.evaluate(() => fetch())` and `context.request` produce **different JA3 hashes from the same Chrome process** — confirmed against tls.peet.ws. This is why `context.request`/`page.request` is banned for replay: it would defeat the entire in-page-replay premise.
- **Click:** trusted CDP `Input.dispatchMouseEvent` opened Wikipedia's language picker; `--diff` reported exactly the 345 elements that appeared.
- **Fill:** typed into Wikipedia's search box via CDP; `--diff` showed both the value change and the live suggestion links that appeared.
- **Recipe replay + verification:** a two-step recipe against a real API — one correct assertion (passed), one deliberately wrong assertion (failed with the exact expected/got values, then halted the run rather than continuing).
- **Network capture:** confirmed correct against genuine `fetch()` traffic.

## Known limitations, still true

- **Refs don't survive a full page navigation** (only in-page re-renders) — expected, and the tool raises a clear error rather than silently acting on the wrong element.
- **`fetch`-mode replay requires the containing page to have a permissive CSP.** A bare API endpoint navigated to directly (e.g. `api.github.com`, `default-src 'none'`) blocks in-page fetch entirely. Not a real-world problem — recipes replay from an actual application page — but it means recipes should be recorded from the app's real UI, not a bare API URL.
- **Not every "API call" is `fetch`/XHR.** Wikipedia's search-suggestion requests are JSONP via injected `<script>` tags — invisible to XHR/Fetch capture by design.
- **`npm test`** now runs 12 real unit tests (ttl parsing/staleness, recipe loading, the dry-run renderer, capture→recipe generation) — the parts that don't need live Chrome. Everything else above was verified through live testing against real sites this session and doesn't re-run automatically; a browser-driven suite is still a gap.
- **Linux and Windows support added, still unverified on real hardware.** `chromeExecutablePath()` now checks multiple real, researched install locations per platform (not one guessed path) and picks the first that actually exists via `fs.existsSync`, rather than blindly returning a hardcoded string. Windows specifically checks the modern per-user install under `%LOCALAPPDATA%` first — Chrome's installer defaults there without admin rights, and a single Program Files path would miss it. `package.json`'s `os` field, which was actively blocking `npm install` on any platform but macOS regardless of whether the code worked, is fixed. No Windows or Linux machine was available to actually run this, so "implemented" is the honest claim here, not "verified" — see the section below.

## The Cloudflare finding, precisely

- Real Chrome (this tool) clears Cloudflare's bot-management **transparently, no widget, on ordinary production sites** (confirmed live on discord.com, canva.com, udemy.com, notion.so) — the common case the whole design targets.
- The TLS fingerprint divergence between in-page `fetch()` and the banned `page.request` is real and measured (different JA3 hash, same Chrome process) — that's the actual mechanism `cf_clearance` binding relies on.
- Whether a *specific* endpoint enforces that binding strictly enough to reject a standalone client turns out to be **route/config-dependent, not universal** — a live Discord API test returned 200 for both paths, because that route wasn't gated tightly.
- **Closed, with a real human click — and the result is more nuanced than the original claim.** After clearing a live Turnstile by hand (confirmed via the actual `cf_clearance` cookie being issued, not just page text), both in-page `fetch()` **and** the banned standalone `page.request` returned 200 using the same cookie. Once clearance existed, Cloudflare did not re-check the TLS fingerprint on the follow-up request. **What this actually shows:** the TLS-divergence mechanism (P0a) is real and measured, but its practical payoff is concentrated in *obtaining* clearance in the first place — that step genuinely requires being the real browser — not necessarily in every request afterward, which can depend on the site's specific bot-management strictness. In-page replay is still strictly safer (it never has a fingerprint to be caught on), just not proven to always be *necessary* post-clearance on every site tested so far (2 for 2: Discord and nowsecure.nl both let a standalone copy through).
