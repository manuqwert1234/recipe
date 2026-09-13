// The core architectural decision from the design doc: no daemon of our own.
// Chrome is spawned once, detached from this process, and every later CLI
// invocation reconnects over CDP by port. Chrome itself holds the state.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright-core";
import {
  CONFIG_DIR,
  PROFILE_DIR,
  BROWSER_STATE_FILE,
  CDP_PORT,
  CDP_URL,
  chromeExecutablePath,
} from "./paths.js";

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

async function isCdpUp() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start Chrome against the dedicated persistent profile, detached from this
 * process, with the CDP port open. Chrome 136+ ignores --remote-debugging-port
 * against the DEFAULT profile dir — this is why a dedicated profile exists.
 * No-op if Chrome is already up on the port.
 */
export async function startBrowser({ headless = false } = {}) {
  ensureConfigDir();

  if (await isCdpUp()) {
    return { alreadyRunning: true };
  }

  const exe = chromeExecutablePath();
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");

  const child = spawn(exe, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Poll for the CDP endpoint to come up rather than a fixed sleep.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await isCdpUp()) {
      fs.writeFileSync(
        BROWSER_STATE_FILE,
        JSON.stringify({ pid: child.pid, port: CDP_PORT, startedAt: Date.now() }, null, 2)
      );
      return { alreadyRunning: false, pid: child.pid };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Chrome did not open CDP on port ${CDP_PORT} within 15s. Check ${PROFILE_DIR} is writable.`
  );
}

/**
 * Connect over CDP to Chrome, starting it first if it isn't already running.
 *
 * Was: throw and tell the caller to run "recipes browser start" separately —
 * a real integration cost (two steps to get anything working, and every
 * MCP-tool caller had to know that ordering). Auto-starting removes that
 * step entirely: the first real command just works, same as it would after
 * a manual "browser start" — startBrowser() is already a safe no-op when
 * Chrome is already up, so this adds no cost on the hot path.
 *
 * Bug found live (2026-08-23): Playwright's connectOverCDP fails outright
 * — "Browser context management is not supported" — when Chrome currently
 * has zero open tabs; it needs an existing target to attach its default
 * context to, and browser.newContext() is not a working fallback for a
 * real, externally-launched Chrome (it doesn't support CDP browser-context
 * creation the way a Playwright-launched browser does). So: guarantee at
 * least one tab exists via the raw CDP HTTP endpoint *before* Playwright
 * ever gets involved.
 */
export async function connect() {
  if (!(await isCdpUp())) {
    await startBrowser({});
  }
  const list = await fetch(`${CDP_URL}/json/list`).then((r) => r.json());
  if (list.length === 0) {
    await openOwnedTab("about:blank");
  }
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error("Connected to Chrome but found no browser context — this shouldn't happen now that a tab is guaranteed first.");
  return { browser, context };
}

/**
 * Open a tab via Chrome's own CDP HTTP endpoint, not Playwright's
 * context.newPage(). Tabs created through a Playwright CDP session can be
 * disposed when that session disconnects (every CLI command calls
 * browser.close()). Chrome-owned tabs survive, which is what we need:
 * the next invocation has to find the same tab.
 */
export async function openOwnedTab(url = "about:blank") {
  const path = `${CDP_URL}/json/new?${url}`;
  let res;
  try {
    res = await fetch(path, { method: "PUT" });
    if (!res.ok) throw new Error(`PUT ${res.status}`);
  } catch {
    res = await fetch(path); // older Chrome builds accept GET here
  }
  if (!res.ok) {
    throw new Error(`Could not open a new tab via CDP HTTP (${res.status}).`);
  }
  return res.json();
}

export async function stopBrowser() {
  if (!fs.existsSync(BROWSER_STATE_FILE)) return { wasRunning: false };
  const { pid } = JSON.parse(fs.readFileSync(BROWSER_STATE_FILE, "utf8"));
  try {
    // Windows has no real POSIX signals — Node's process.kill still works
    // there, but any signal name (including SIGTERM) forcefully terminates
    // the process rather than requesting a graceful shutdown. Fine for
    // Chrome: it doesn't need a graceful SIGTERM to release its profile
    // lock cleanly.
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead — fine
  }
  fs.rmSync(BROWSER_STATE_FILE, { force: true });
  return { wasRunning: true };
}

export { isCdpUp, CDP_URL };
