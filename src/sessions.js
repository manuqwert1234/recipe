// Session binding across CLI invocations, without touching private Playwright
// internals.
//
// window.name used to be the only key. That survives same-tab navigation in
// theory, but real sites overwrite it (confirmed live: wikipedia.org sets it
// to ""). Playwright's context.newPage() also creates a tab that Chrome may
// dispose when the short-lived CDP connection drops — so a later command
// could honestly report "no session" while a different leftover tab was
// still on screen.
//
// The tab's CDP targetId is what actually identifies "this Chrome tab"
// while Chrome stays up. We persist that (plus the last URL) under
// ~/.recipes/sessions.json. Lookup order: targetId, then window.name, then
// a unique URL match after a Chrome restart (targetIds change on relaunch).

import fs from "node:fs";
import { CONFIG_DIR, SESSIONS_FILE } from "./paths.js";

export const TAG_PREFIX = "recipes:";

export function loadBindings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function saveBindings(bindings) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(bindings, null, 2));
}

export function urlsMatch(a, b) {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

/**
 * Pick which live tab belongs to a session name.
 * @param {{ targetId?: string, windowName?: string, url?: string }[]} candidates
 * @param {string} sessionName
 * @param {Record<string, { targetId?: string, url?: string }>} bindings
 */
export function resolveBinding(candidates, sessionName, bindings) {
  const want = bindings[sessionName];
  const tag = TAG_PREFIX + sessionName;

  if (want?.targetId) {
    const byId = candidates.find((c) => c.targetId && c.targetId === want.targetId);
    if (byId) return byId;
  }

  const byName = candidates.filter((c) => c.windowName === tag);
  if (byName.length === 1) return byName[0];

  if (want?.url) {
    const byUrl = candidates.filter((c) => urlsMatch(c.url, want.url));
    if (byUrl.length === 1) return byUrl[0];
  }

  return null;
}

async function pageTargetId(page) {
  const client = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await client.send("Target.getTargetInfo");
    return targetInfo?.targetId ?? null;
  } catch {
    return null;
  } finally {
    await client.detach().catch(() => {});
  }
}

async function describePages(context) {
  const pages = context.pages();
  return Promise.all(
    pages.map(async (page) => {
      const [targetId, windowName] = await Promise.all([
        pageTargetId(page),
        page.evaluate(() => window.name).catch(() => ""),
      ]);
      return { page, targetId, windowName: windowName ?? "", url: page.url() };
    })
  );
}

export async function tagPage(page, sessionName) {
  const tag = TAG_PREFIX + sessionName;
  await page.evaluate((name) => {
    window.name = name;
  }, tag).catch(() => {});

  const targetId = await pageTargetId(page);
  const bindings = loadBindings();
  for (const [name, binding] of Object.entries(bindings)) {
    if (name !== sessionName && binding?.targetId && binding.targetId === targetId) {
      delete bindings[name];
    }
  }
  bindings[sessionName] = {
    targetId,
    url: page.url(),
    taggedAt: Date.now(),
  };
  saveBindings(bindings);
}

async function waitForPageByTargetId(context, targetId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const described = await describePages(context);
    const hit = described.find((c) => c.targetId === targetId);
    if (hit) return hit.page;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** Find the page tagged with this session name among all open tabs. */
export async function findSession(context, sessionName) {
  const candidates = await describePages(context);
  const hit = resolveBinding(candidates, sessionName, loadBindings());
  return hit?.page ?? null;
}

/**
 * Reuse the session tab if it's still open; otherwise open a Chrome-owned
 * tab (not Playwright newPage) and bind it.
 */
export async function acquireSession(context, sessionName) {
  const existing = await findSession(context, sessionName);
  if (existing) return existing;

  const { openOwnedTab } = await import("./browser.js");
  const created = await openOwnedTab("about:blank");
  const page =
    (created?.id && (await waitForPageByTargetId(context, created.id))) ||
    context.pages().at(-1);
  if (!page) {
    throw new Error(`Could not open a tab for session "${sessionName}".`);
  }
  await tagPage(page, sessionName);
  return page;
}

export async function listSessions(context) {
  const candidates = await describePages(context);
  const bindings = loadBindings();
  const results = [];
  const claimed = new Set();

  for (const name of Object.keys(bindings)) {
    const hit = resolveBinding(candidates, name, bindings);
    if (!hit) continue;
    results.push({ name, url: hit.url });
    if (hit.targetId) claimed.add(hit.targetId);
  }

  for (const c of candidates) {
    if (!c.windowName.startsWith(TAG_PREFIX)) continue;
    const name = c.windowName.slice(TAG_PREFIX.length);
    if (results.some((r) => r.name === name)) continue;
    if (c.targetId && claimed.has(c.targetId)) continue;
    results.push({ name, url: c.url });
  }
  return results;
}

/** Get the session's page, or the sole/most-recent page as a fallback. */
export async function resolveSession(context, sessionName) {
  if (sessionName) {
    const page = await findSession(context, sessionName);
    if (!page) throw new Error(`No open session named "${sessionName}". Run "recipes open <url> --session ${sessionName}" first.`);
    return page;
  }
  const pages = context.pages();
  if (pages.length === 0) throw new Error("No open tabs. Run \"recipes open <url>\" first.");
  return pages[pages.length - 1];
}
