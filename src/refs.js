// Snapshot + ref engine — Phase 2 of the design doc.
//
// Refs are keyed on backendDOMNodeId, not on position in a freshly-taken
// tree (Playwright MCP's approach). That's what lets "@e12" from a snapshot
// taken a minute ago, in a *previous CLI invocation*, still resolve after
// the page re-rendered — as long as the underlying DOM node is still alive.
//
// Ref tables persist to disk per session because each CLI call is a fresh
// process: "recipes snapshot" and the later "recipes click @e3" do not share
// memory, only the ref file.

import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./paths.js";

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio",
  "combobox", "listbox", "option", "menuitem", "menuitemcheckbox",
  "menuitemradio", "tab", "switch", "slider", "spinbutton", "select",
]);

function refFile(sessionName) {
  return path.join(CONFIG_DIR, `refs-${sessionName || "default"}.json`);
}
function snapshotCacheFile(sessionName) {
  return path.join(CONFIG_DIR, `last-snapshot-${sessionName || "default"}.json`);
}

function loadRefTable(sessionName) {
  try {
    return JSON.parse(fs.readFileSync(refFile(sessionName), "utf8"));
  } catch {
    return {}; // ref -> backendNodeId
  }
}
function saveRefTable(sessionName, table) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(refFile(sessionName), JSON.stringify(table, null, 2));
}

function axValue(v) {
  return v && typeof v === "object" ? v.value : v;
}

async function getCdp(page) {
  const client = await page.context().newCDPSession(page);
  await client.send("Accessibility.enable");
  await client.send("DOM.enable");
  return client;
}

/**
 * Take a snapshot of the accessibility tree.
 * @param {object} opts
 * @param {boolean} opts.interactive - only actionable elements
 * @param {string}  opts.within - ref to scope the subtree to
 * @param {boolean} opts.diff - only report what changed since the last snapshot for this session
 */
export async function takeSnapshot(page, sessionName, opts = {}) {
  const client = await getCdp(page);
  const { nodes } = await client.send("Accessibility.getFullAXTree");

  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const refTable = loadRefTable(sessionName);
  const backendToRef = new Map(Object.entries(refTable).map(([r, b]) => [b, r]));
  let nextRefNum =
    Object.keys(refTable).reduce((max, r) => Math.max(max, Number(r.slice(1)) || 0), 0) + 1;

  function ensureRef(backendNodeId) {
    if (backendNodeId == null) return null;
    let ref = backendToRef.get(backendNodeId);
    if (!ref) {
      ref = `e${nextRefNum++}`;
      backendToRef.set(backendNodeId, ref);
      refTable[ref] = backendNodeId;
    }
    return ref;
  }

  // Resolve the "within" scope to a backendNodeId subtree, if given.
  let scopeNodeIds = null;
  if (opts.within) {
    const scopeBackendId = refTable[opts.within];
    if (!scopeBackendId) throw new Error(`Unknown ref ${opts.within} — take a snapshot first.`);
    const scopeAx = nodes.find((n) => n.backendDOMNodeId === scopeBackendId);
    if (scopeAx) {
      scopeNodeIds = new Set();
      const stack = [scopeAx.nodeId];
      while (stack.length) {
        const id = stack.pop();
        if (scopeNodeIds.has(id)) continue;
        scopeNodeIds.add(id);
        const n = byId.get(id);
        for (const c of n?.childIds ?? []) stack.push(c);
      }
    }
  }

  const flat = [];
  for (const n of nodes) {
    if (n.ignored) continue;
    if (scopeNodeIds && !scopeNodeIds.has(n.nodeId)) continue;
    const role = axValue(n.role);
    const name = axValue(n.name) || "";
    if (!role || role === "none" || role === "generic" || role === "InlineTextBox") continue;
    if (opts.interactive && !INTERACTIVE_ROLES.has(role)) continue;
    // Found live via head-to-head testing (2026-08-24): a closed native
    // <select> exposes ALL of its <option> children in the accessibility
    // tree even while collapsed — Wikipedia's language selector alone added
    // 77 of them to every single snapshot, on the very first read, before
    // anyone opened it. They're not just noise: a closed native <select>
    // renders as an OS-level control, so a trusted CDP click can't target
    // an individual closed option the way it targets a real DOM element
    // anyway. Show the select itself (the combobox role); skip its
    // options until something actually expands it into view.
    if (opts.interactive && role === "option") continue;
    // An unnamed link is something a human using a screen reader couldn't
    // identify either — it's not useful to act on by reference, just noise
    // inflating the count. Buttons are NOT exempted from this the same way:
    // found live via head-to-head testing (2026-09-13) — a bare
    // <input type="submit"> or icon-only button routinely has no accessible
    // name at all but is exactly the element a recipe needs to click (the
    // plain-HTML DuckDuckGo search form's submit button was invisible to
    // `interactive:true` for this reason, forcing a fallback to a full,
    // uncapped snapshot just to find it). Form fields were already exempt
    // for the same underlying reason — extend that exemption to buttons.
    if (opts.interactive && !name.trim() && role === "link") continue;
    if (n.backendDOMNodeId == null) continue;

    const ref = ensureRef(n.backendDOMNodeId);
    flat.push({
      ref,
      role,
      name,
      value: axValue(n.value) ?? undefined,
    });
  }

  saveRefTable(sessionName, refTable);

  // Bug found live via head-to-head testing against a market alternative
  // (2026-08-24): a long article page (486 interactive elements, mostly
  // citation links far below the fold) produced a snapshot ~3x LARGER than
  // a competing tool that caps itself by default — this engine had no cap
  // at all, despite the design doc explicitly promising one ("hard cap per
  // snapshot with explicit truncation markers, never silent") that never
  // actually got implemented. Fixed now: default 150-node cap, truncation
  // always stated plainly, never silent. Use --within to scope to a
  // specific region instead of raising the cap.
  const MAX_NODES = opts.maxNodes ?? 150;
  const cap = (list) => {
    if (list.length <= MAX_NODES) return { list, truncated: false };
    return {
      list: list.slice(0, MAX_NODES),
      truncated: true,
      truncatedCount: list.length - MAX_NODES,
      totalCount: list.length,
    };
  };

  if (opts.diff) {
    let prev = [];
    try {
      prev = JSON.parse(fs.readFileSync(snapshotCacheFile(sessionName), "utf8"));
    } catch {
      /* first snapshot — everything is "added" */
    }
    const prevByRef = new Map(prev.map((n) => [n.ref, n]));
    const currentRefs = new Set(flat.map((n) => n.ref));
    const addedCapped = cap(flat.filter((n) => !prevByRef.has(n.ref)));
    const removed = prev.filter((n) => !currentRefs.has(n.ref));
    const changedCapped = cap(
      flat.filter((n) => {
        const p = prevByRef.get(n.ref);
        return p && (p.name !== n.name || p.value !== n.value);
      })
    );
    fs.writeFileSync(snapshotCacheFile(sessionName), JSON.stringify(flat, null, 2));
    return {
      diff: true,
      added: addedCapped.list,
      removed,
      changed: changedCapped.list,
      truncated: addedCapped.truncated || changedCapped.truncated,
      truncatedCount: (addedCapped.truncatedCount ?? 0) + (changedCapped.truncatedCount ?? 0),
    };
  }

  fs.writeFileSync(snapshotCacheFile(sessionName), JSON.stringify(flat, null, 2));
  const { list: cappedFlat, truncated, truncatedCount, totalCount } = cap(flat);
  if (truncated) {
    return {
      diff: false,
      nodes: cappedFlat,
      truncated: true,
      truncatedCount,
      totalCount,
      hint: `${truncatedCount} more elements not shown (${totalCount} total) — use --within <ref> to scope to a specific region instead of reading the whole page.`,
    };
  }
  return { diff: false, nodes: flat };
}

/**
 * Locate an element by role + name for recipe dom-mode steps. Unlike a raw
 * ref (which only survives within one session's lifetime and dies on
 * navigation), role+name matching is what stays stable across separate
 * "record once, replay forever" runs — the same reason Playwright's own
 * getByRole locators work this way.
 */
export async function findRef(page, sessionName, { role, nameContains, nameExact }) {
  // Bug found live via a real cron run (2026-08-23): a manual test with
  // natural pauses between commands never hit this, but content that renders
  // asynchronously after navigation (confirmed: absent at domcontentloaded,
  // present ~2s later) means the very first snapshot after a fresh nav can
  // legitimately race the page's own data fetch. Retry with backoff before
  // giving up — this is a real timing gap, not a "page changed" situation,
  // and treating it as instant-fail was a false negative.
  const attempts = [0, 500, 1000, 1500]; // ms to wait before each attempt
  let matches = [];
  for (const delay of attempts) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const snap = await takeSnapshot(page, sessionName, { interactive: true });
    matches = snap.nodes.filter((n) => {
      if (role && n.role !== role) return false;
      if (nameExact && n.name !== nameExact) return false;
      if (nameContains && !n.name.includes(nameContains)) return false;
      return true;
    });
    if (matches.length > 0) break;
  }
  if (matches.length === 0) {
    throw new Error(`No element found matching role=${role ?? "*"} name~="${nameContains ?? nameExact ?? "*"}" after retrying for ${attempts.reduce((a, b) => a + b, 0)}ms — the page may have changed since this recipe was recorded, or genuinely doesn't have this content.`);
  }
  if (matches.length > 1) {
    // Don't silently guess which one was meant — surface it so a recipe
    // author tightens the locate criteria instead of it acting on the
    // wrong element on some future run where match order differs.
    return {
      ...matches[0],
      ambiguous: true,
      ambiguousCount: matches.length,
      ambiguousNames: matches.map((m) => m.name),
    };
  }
  return matches[0];
}

function resolveBackendId(sessionName, ref) {
  const refTable = loadRefTable(sessionName);
  const backendNodeId = refTable[ref];
  if (!backendNodeId) throw new Error(`Unknown ref ${ref} — stale, or never snapshotted. Take a fresh snapshot.`);
  return backendNodeId;
}

/** Is `candidate` the target node itself or one of its descendants? */
async function isSameOrDescendant(client, targetBackendId, candidateBackendId) {
  if (candidateBackendId === targetBackendId) return true;
  const { node } = await client.send("DOM.describeNode", {
    backendNodeId: candidateBackendId,
    depth: -1,
  });
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n.backendNodeId === targetBackendId) return true;
    for (const c of n.children ?? []) stack.push(c);
  }
  return false;
}

/** Click via trusted CDP input events — not a synthetic .click(), on purpose (see design doc §02). */
export async function clickRef(page, sessionName, ref) {
  const backendNodeId = resolveBackendId(sessionName, ref);
  const client = await getCdp(page);

  let box;
  try {
    box = await client.send("DOM.getBoxModel", { backendNodeId });
  } catch {
    throw new Error(`${ref} no longer resolves to a visible element — stale ref. Take a fresh snapshot.`);
  }
  const quad = box.model.content; // [x1,y1,x2,y2,x3,y3,x4,y4]
  const x = (quad[0] + quad[4]) / 2;
  const y = (quad[1] + quad[5]) / 2;

  // Bug found live via head-to-head testing (2026-09-13): a click was
  // dispatched blind at the box-model center with no check that the target
  // was actually the topmost thing there. A sticky header, autocomplete
  // overlay, or a duplicate (mobile/desktop) copy of the same widget can sit
  // on top of the real element; the mouse events then land on whatever's
  // actually painted at that point — or on nothing clickable — while this
  // still reported {ref, x, y} as if the click had landed. Verify via
  // DOM.getNodeForLocation before dispatching, and fail loudly instead of
  // silently clicking the wrong element.
  let hit;
  try {
    hit = await client.send("DOM.getNodeForLocation", {
      x: Math.round(x),
      y: Math.round(y),
      includeUserAgentShadowDOM: true,
    });
  } catch {
    hit = null;
  }
  if (hit && !(await isSameOrDescendant(client, backendNodeId, hit.backendNodeId))) {
    throw new Error(
      `${ref} is covered by another element at its click point (${Math.round(x)}, ${Math.round(y)}) — likely a sticky header, overlay, or duplicate widget on top of it. Scroll it into view or dismiss whatever's overlapping it, then take a fresh snapshot before retrying.`
    );
  }

  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return { ref, x, y };
}

/** Focus + insert text via CDP — inherits real focus/input handling, not a value= assignment. */
export async function fillRef(page, sessionName, ref, text) {
  const backendNodeId = resolveBackendId(sessionName, ref);
  const client = await getCdp(page);
  await client.send("DOM.focus", { backendNodeId });
  // Clear existing content first: select all, then insert replaces selection.
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", commands: ["selectAll"] });
  await client.send("Input.insertText", { text });
  return { ref, text };
}
