# recipes

**Drive websites through their accessibility tree instead of screenshots and pixel guessing.** Real logged-in Chrome, auditable JSON recipes, in-page replay — built for AI agents and humans alike.

📖 **[Full documentation, with diagrams and benchmarks](https://claude.ai/code/artifact/bf0eb20b-a0e2-4152-b3d1-21abfdc740e0)**

```
npm install -g recipes-cli
recipes open https://example.com --session s
recipes snapshot --session s --interactive
```

No setup step — the first command starts Chrome automatically.

## Why

Vision-based browser agents look at a screenshot, guess a pixel coordinate, and click — which "succeeds" whether or not it hit the right thing. `recipes` reads the page's real accessibility tree instead, so every action either resolves against a labeled element or raises a typed error.

- **No vision, no coordinate guessing.** A page becomes a list of labeled elements (`e5: button "Search"`) — actions target the element, not an (x, y) that may or may not still be there.
- **Real Chrome, real session.** Runs against your actual, logged-in Chrome (a dedicated profile, not your default one) — sites you're already signed into just work.
- **Recipes you can read before they run.** A repeatable flow is a plain JSON file with explicit assertions. Review it with `recipes recipe show` before it ever touches a real account.
- **Fails loud.** A wrong assertion stops the run and says exactly what didn't match — it never reports success it didn't actually get.

Measured against a comparable market CLI, on identical pages: **~1.6x faster**, **~33x fewer tokens per page-read**. Full methodology and honest caveats in the [docs](https://claude.ai/code/artifact/bf0eb20b-a0e2-4152-b3d1-21abfdc740e0#benchmarks).

## Install

```
npm install -g recipes-cli
```

Or from source:

```
git clone https://github.com/manuqwert1234/recipe.git
cd recipe
npm install
npm link
```

Requires Node 18+ and Google Chrome. macOS only for now.

## Quickstart

```
recipes open https://example.com --session s    # log in here if the site needs it
recipes snapshot --session s --interactive       # see what's on the page, by label not pixel
recipes click e5 --session s
recipes fill e9 "hello" --session s
```

For a repeatable flow:

```
recipes record capture.json --session s --duration 15000
recipes recipe from-network capture.json my-flow.json --site example.com
recipes recipe show my-flow.json     # read exactly what it will do
recipes recipe run my-flow.json --session s
```

## MCP

The same engine is also exposed as 10 typed MCP tools:

```
claude mcp add recipes -- node /path/to/recipe/mcp/server.js
```

## The Cloudflare-adjacent part, stated plainly

A recipe replays a flow by running `fetch()` **inside** the real browser tab rather than from a separate HTTP client. This is not fingerprint spoofing — every request carries the browser's own, unmodified TLS/UA signature, because it *is* the browser. Nothing here is forged.

Be precise about what that means: the reason it matters is that it avoids ever presenting a *different* signal than a separate client would — and that signal is specifically what some anti-bot systems use to distinguish scripted traffic. So while nothing is spoofed, the architecture is deliberately shaped to not trip that detection.

Separately: **this covers "is it technically evasion," not "is it allowed."** Automating your own logged-in account isn't automatically fine everywhere just because nothing is spoofed — plenty of sites' terms of service restrict automated access to your own account too. Check a site's ToS before pointing this at anything beyond low-stakes use.

## Limitations

- Canvas/WebGL apps (Figma, maps) have no useful accessibility tree.
- Sites with no accessible labels ("div soup") produce technically-correct, practically-useless snapshots.
- Some endpoints protect against replay with a rotating, per-request signed token — `dom` mode (locate-and-interact) is the fallback, not `fetch` mode.
- macOS only, currently.
- No automated browser-driven test suite yet — `npm test` covers the logic that doesn't need Chrome.

## More

- [Full documentation](https://claude.ai/code/artifact/bf0eb20b-a0e2-4152-b3d1-21abfdc740e0) — architecture, recipe format, command reference, benchmarks.
- [`SKILL.md`](SKILL.md) — command reference written for an AI agent to load directly.
- [`BUILDLOG.md`](BUILDLOG.md) — the complete, honest build history: every bug found, every claim tested against real sites.

## License

MIT — see [`LICENSE`](LICENSE).
