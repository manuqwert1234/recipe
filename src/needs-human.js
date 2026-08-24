// Heuristic detection of "this needs a human" — a Turnstile/managed
// challenge, or a login wall. The design doc is explicit: fail loud here,
// never hang and never silently misreport success.
//
// Bug found live (2026-08-23): the original version matched "cf-turnstile"
// and "cf-chl" against page content — but those are CSS class name
// fragments that stay in the DOM whether or not the widget was solved, so
// they false-positived on an already-cleared page. Fix: title markers (they
// genuinely revert once cleared — the page becomes itself again) are
// trusted directly; the Cloudflare-specific body markers now also require
// the cf_clearance cookie to be ABSENT before counting as a real block —
// present clearance means it's just leftover widget markup, not an active
// challenge.

const TITLE_MARKERS = [
  "Just a moment",
  "Checking your browser",
  "Attention Required",
];

const CF_BODY_MARKERS_NEEDING_COOKIE_CHECK = [
  "cf-turnstile",
  "cf-chl",
  "Verify you are human",
];

export async function needsHuman(page) {
  const [title, content] = await Promise.all([
    page.title().catch(() => ""),
    page.content().catch(() => ""),
  ]);

  const titleHit = TITLE_MARKERS.find((m) => title.includes(m));
  if (titleHit) {
    return { needsHuman: true, reason: `challenge title: "${titleHit}"` };
  }

  const bodyHit = CF_BODY_MARKERS_NEEDING_COOKIE_CHECK.find((m) => content.includes(m));
  if (bodyHit) {
    let hasClearance = false;
    try {
      const cookies = await page.context().cookies(page.url());
      hasClearance = cookies.some((c) => c.name === "cf_clearance");
    } catch {
      /* cookie read failed — fall through, treat conservatively as needing a human */
    }
    if (!hasClearance) {
      return { needsHuman: true, reason: `challenge marker found and no cf_clearance cookie: "${bodyHit}"` };
    }
    // Marker present but clearance already issued — this is solved widget
    // markup, not an active block. Not needs-human.
  }

  return { needsHuman: false };
}
