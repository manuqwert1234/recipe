// Session binding across CLI invocations, without touching private Playwright
// internals. window.name survives same-tab navigation (a real browser
// behavior), so tagging a tab with it and reading it back on reconnect is a
// robust way to find "the same tab" without a daemon holding a reference.

const TAG_PREFIX = "recipes:";

export async function tagPage(page, sessionName) {
  await page.evaluate((name) => {
    window.name = name;
  }, TAG_PREFIX + sessionName);
}

/** Find the page tagged with this session name among all open tabs. */
export async function findSession(context, sessionName) {
  const pages = context.pages();
  const names = await Promise.all(
    pages.map((p) => p.evaluate(() => window.name).catch(() => ""))
  );
  const idx = names.findIndex((n) => n === TAG_PREFIX + sessionName);
  return idx === -1 ? null : pages[idx];
}

export async function listSessions(context) {
  const pages = context.pages();
  const results = await Promise.all(
    pages.map(async (p) => {
      const name = await p.evaluate(() => window.name).catch(() => "");
      if (!name.startsWith(TAG_PREFIX)) return null;
      return { name: name.slice(TAG_PREFIX.length), url: p.url() };
    })
  );
  return results.filter(Boolean);
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
