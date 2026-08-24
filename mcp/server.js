#!/usr/bin/env node
// Phase 7 — the MCP wrapper. Calls straight into src/, same as bin/recipes.js
// does — this is not a second implementation, it's a second front door onto
// the same engine, exactly as the design doc specifies ("CLI-first; MCP
// added because it gives Claude typed schemas").

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { startBrowser, connect } from "../src/browser.js";
import { tagPage, resolveSession, listSessions, findSession } from "../src/sessions.js";
import { takeSnapshot, clickRef, fillRef } from "../src/refs.js";
import { needsHuman } from "../src/needs-human.js";
import { loadRecipe, renderShow, runRecipe } from "../src/recipe.js";
import { watchTick } from "../src/watch.js";

const server = new McpServer({ name: "recipes", version: "0.1.0" });

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

// Every tool that touches the browser connects fresh and closes when done —
// same no-daemon model as the CLI (design doc §04). Chrome holds the state,
// not this process.
async function withPage(sessionName, fn) {
  const { context, browser } = await connect();
  try {
    const page = await resolveSession(context, sessionName);
    return await fn(page, context);
  } finally {
    await browser.close();
  }
}

server.registerTool(
  "browser_start",
  { title: "Start browser", description: "Start the persistent Chrome instance if it isn't already running. Optional — every other tool starts it automatically on first use if needed. Only call this explicitly to warm it up ahead of time or to force a visible window before a login step." },
  async () => {
    const r = await startBrowser({});
    return text(r.alreadyRunning ? "Chrome already running." : `Chrome started (pid ${r.pid}).`);
  }
);

server.registerTool(
  "open",
  {
    title: "Open URL",
    description: "Open a URL in a named tab, reusing that tab if the session name is already open. Real logged-in Chrome — cookies and TLS fingerprint are genuine.",
    inputSchema: { url: z.string().describe("URL to open"), session: z.string().default("default").describe("session/tab name to bind or reuse") },
  },
  async ({ url, session }) => {
    const { context, browser } = await connect();
    let page = await findSession(context, session);
    if (!page) { page = await context.newPage(); await tagPage(page, session); }
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const nh = await needsHuman(page);
    await browser.close();
    return text({ opened: url, session, needsHuman: nh });
  }
);

server.registerTool(
  "sessions",
  { title: "List sessions", description: "List currently open tabs and their session names." },
  async () => {
    const { context, browser } = await connect();
    const list = await listSessions(context);
    await browser.close();
    return text(list);
  }
);

server.registerTool(
  "snapshot",
  {
    title: "Accessibility snapshot",
    description:
      "Read the page as a list of labeled elements with stable refs (@e12) instead of a screenshot. " +
      "ALWAYS pass interactive:true and diff:true after the first call on a page — a full, non-diffed " +
      "snapshot of a busy page burns far more context than the tool needs.",
    inputSchema: {
      session: z.string().default("default"),
      interactive: z.boolean().default(true).describe("only actionable elements (button/link/textbox/etc)"),
      diff: z.boolean().default(false).describe("only report what changed since the last snapshot of this session"),
      within: z.string().optional().describe("a ref, e.g. 'e12' — scope the snapshot to that element's subtree"),
    },
  },
  async ({ session, interactive, diff, within }) => {
    const result = await withPage(session, (page) => takeSnapshot(page, session, { interactive, diff, within }));
    return text(result);
  }
);

server.registerTool(
  "click",
  {
    title: "Click a ref",
    description:
      "Click the element with this ref via trusted browser input events (not a synthetic JS click). " +
      "The ref must come from a snapshot taken in this session; a stale ref (page navigated since) raises a clear error instead of guessing.",
    inputSchema: { session: z.string().default("default"), ref: z.string().describe("e.g. 'e12'") },
  },
  async ({ session, ref }) => {
    const r = await withPage(session, (page) => clickRef(page, session, ref));
    return text(r);
  }
);

server.registerTool(
  "fill",
  {
    title: "Fill a ref",
    description: "Focus the element with this ref and insert text via trusted input, replacing any existing content.",
    inputSchema: { session: z.string().default("default"), ref: z.string(), text: z.string() },
  },
  async ({ session, ref, text: value }) => {
    const r = await withPage(session, (page) => fillRef(page, session, ref, value));
    return text(r);
  }
);

server.registerTool(
  "needs_human",
  {
    title: "Check for a challenge or login wall",
    description: "Check whether the current page is showing a Cloudflare/Turnstile-style challenge or similar. Never attempt to solve one programmatically — surface this to the user instead.",
    inputSchema: { session: z.string().default("default") },
  },
  async ({ session }) => {
    const r = await withPage(session, (page) => needsHuman(page));
    return text(r);
  }
);

server.registerTool(
  "recipe_show",
  {
    title: "Show a recipe (dry run)",
    description: "Render a recipe file as a plain-language description of exactly what it will do — read this before running any recipe against a real account.",
    inputSchema: { file: z.string() },
  },
  async ({ file }) => text(renderShow(loadRecipe(file)))
);

server.registerTool(
  "recipe_run",
  {
    title: "Run a recipe",
    description:
      "Replay a recipe's steps via in-page fetch() — same cookies/TLS/session as the real logged-in browser, never a standalone HTTP client. " +
      "Stops at the first failed assertion rather than continuing past a broken assumption; check `ok` on every step.",
    inputSchema: { file: z.string(), session: z.string().default("default"), dryRun: z.boolean().default(false) },
  },
  async ({ file, session, dryRun }) => {
    const recipe = loadRecipe(file);
    const results = await withPage(session, (page) => runRecipe(page, recipe, { dryRun, session }));
    return text(results);
  }
);

server.registerTool(
  "recipe_watch",
  {
    title: "Run one watch check",
    description:
      "Run a recipe and compare its result to the last known-good check for this recipe. Returns status: unchanged | changed | needs-human | failed. " +
      "A needs-human or failed check never overwrites the last-good state, so the next successful check still compares against the real last answer.",
    inputSchema: { file: z.string(), session: z.string().default("default") },
  },
  async ({ file, session }) => {
    const recipe = loadRecipe(file);
    const name = file.replace(/^.*\//, "").replace(/\.json$/, "");
    const result = await withPage(session, (page) => watchTick(page, recipe, name, {}));
    return text(result);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
