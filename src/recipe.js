// Phase 3/5 — the recipe format, the dry-run renderer, and verified replay.
// This file is the actual product: everything above it is plumbing to get
// a real browser session; this is what's genuinely new.

import fs from "node:fs";
import { findRef, clickRef, fillRef } from "./refs.js";

/**
 * Turn a raw `record` capture into a draft recipe — the piece the design
 * doc's Phase 4 called for ("parameterize... into a recipe") that never
 * actually got built; until now every recipe in this repo was hand-written
 * by reading the capture JSON directly. This is a starting point, not a
 * finished recipe: one fetch step per distinct GET request, asserting only
 * the status code it actually got — a human (or Claude) should tighten the
 * `expect` clauses before trusting it unattended, exactly what `recipe show`
 * is for.
 */
export function recipeFromCapture(entries, { site, ttl = "1h" } = {}) {
  const seen = new Set();
  const steps = [];
  for (const e of entries) {
    if (e.method !== "GET") continue; // only reads are safe to auto-generate; writes need a human's intent, not a guess
    let url;
    try { url = new URL(e.url); } catch { continue; }
    const key = `${e.method} ${url.pathname}${url.search}`;
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push({
      mode: "fetch",
      call: `GET ${url.pathname}${url.search}`,
      expect: { status: e.status ?? 200 },
    });
  }
  return {
    site,
    ttl,
    recordedAt: new Date().toISOString(),
    auth_binding: "browser-session",
    steps,
  };
}

export function loadRecipe(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw.site || !Array.isArray(raw.steps)) {
    throw new Error(`${filePath} is not a valid recipe: needs "site" and "steps".`);
  }
  return raw;
}

/** Human-readable dry-run — the trust story from the design doc, §05. */
export function renderShow(recipe) {
  const lines = [];
  const ttlStatus = checkTtl(recipe);
  const ttlLine = !recipe.ttl
    ? "(none set)"
    : !ttlStatus.checked
      ? `${recipe.ttl} (${ttlStatus.reason})`
      : ttlStatus.stale
        ? `${recipe.ttl} — ⚠ STALE, recorded ${new Date(ttlStatus.recordedAt).toISOString()} — run will refuse to replay`
        : `${recipe.ttl} — ok, recorded ${new Date(ttlStatus.recordedAt).toISOString()}`;
  lines.push(`site        ${recipe.site}`);
  if (recipe.start_url) lines.push(`starts at   ${recipe.start_url}`);
  lines.push(`ttl         ${ttlLine}`);
  lines.push(`auth        ${recipe.auth_binding ?? "browser-session (not portable)"}`);
  lines.push(`steps       ${recipe.steps.length}`);
  lines.push("");
  recipe.steps.forEach((step, i) => {
    const label =
      step.call ??
      (step.mode === "dom"
        ? `${step.action} → ${step.locate?.role ?? "*"} "${step.locate?.nameContains ?? step.locate?.nameExact ?? "*"}"${step.value ? ` = "${step.value}"` : ""}`
        : "(unlabeled step)");
    lines.push(`  ${i + 1}. [${step.mode}] ${label}`);
    if (step.expect) {
      for (const [k, v] of Object.entries(step.expect)) {
        lines.push(`       expect  ${k} == ${JSON.stringify(v)}`);
      }
    } else {
      lines.push(`       ⚠ no expect clause — this step's success is unverified`);
    }
  });
  return lines.join("\n");
}

const TTL_UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseTtl(ttl) {
  const m = /^(\d+)([smhd])$/.exec(ttl ?? "");
  if (!m) return null;
  return Number(m[1]) * TTL_UNITS[m[2]];
}

/**
 * Was previously pure documentation — "ttl" was printed but never checked
 * against anything. Now it's real: a recipe without a recordedAt timestamp
 * can't be checked (older/hand-written recipes), and one that's past its
 * ttl is treated the same as any other broken assumption — stop and say so,
 * rather than replaying possibly-rotted request shapes against a real site.
 */
export function checkTtl(recipe) {
  const ttlMs = parseTtl(recipe.ttl);
  if (!ttlMs) return { checked: false, reason: "no ttl set" };
  if (!recipe.recordedAt) return { checked: false, reason: "ttl set but no recordedAt — can't verify age" };
  const ageMs = Date.now() - Date.parse(recipe.recordedAt);
  if (Number.isNaN(ageMs)) return { checked: false, reason: `unparseable recordedAt: "${recipe.recordedAt}"` };
  const stale = ageMs > ttlMs;
  return { checked: true, stale, ageMs, ttlMs, recordedAt: recipe.recordedAt };
}

function getPath(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Check a step's result against its expect clause. A key ending in
 * "Contains" does a substring match — needed for text that's legitimately
 * allowed to vary (a count, a name) where only "the label is still there"
 * matters, not an exact string.
 */
function verifyExpect(expect, result) {
  if (!expect) return { ok: true, reason: "no expect clause (unverified)" };
  const failures = [];
  for (const [key, want] of Object.entries(expect)) {
    if (key.endsWith("Contains")) {
      const field = key.slice(0, -"Contains".length);
      const got = field === "status" ? result.status : getPath(result, field);
      if (typeof got !== "string" || !got.includes(want)) {
        failures.push(`${key}: expected to contain ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
      }
      continue;
    }
    const got = key === "status" ? result.status : getPath(result, key);
    if (got !== want) {
      failures.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  return failures.length ? { ok: false, reason: failures.join("; ") } : { ok: true };
}

/**
 * Replay a recipe. `fetch` steps run in-page via page.evaluate — same
 * origin, same cookie jar, same TLS/UA — never page.request (see design
 * doc §02, the banned-API note).
 */
export async function runRecipe(page, recipe, { dryRun = false, session = "default" } = {}) {
  const ttlStatus = checkTtl(recipe);
  if (ttlStatus.checked && ttlStatus.stale) {
    const ageH = (ttlStatus.ageMs / 3_600_000).toFixed(1);
    return [{
      step: 0, ok: false,
      reason: `recipe is stale — recorded ${ageH}h ago, ttl is ${recipe.ttl}. Re-record before trusting it; refusing to replay a possibly-rotted recipe.`,
    }, { stoppedEarly: true, at: 0 }];
  }

  // Found live: a recipe silently assuming the session's tab is already on
  // the right page breaks the moment that tab has navigated elsewhere for
  // any other reason (another command, another recipe, the user browsing).
  // A recipe should be self-contained about where it runs, not depend on
  // incidental state.
  if (recipe.start_url && !dryRun) {
    await page.goto(recipe.start_url, { waitUntil: "domcontentloaded" });
  }

  const results = [];
  for (const [i, step] of recipe.steps.entries()) {
    let result, label;

    if (step.mode === "fetch") {
      const [method, urlPath] = step.call.split(" ");
      label = step.call;
      if (dryRun) {
        results.push({ step: i + 1, ok: true, dryRun: true, would: `${method} ${urlPath}` });
        continue;
      }
      // auth_binding: "none" is now actually enforced, not just documentation
      // — omitting credentials means a recipe claiming to be portable really
      // is tested that way, instead of silently riding on cookies anyway.
      const credentials = recipe.auth_binding === "none" ? "omit" : "include";
      result = await page.evaluate(
        async ([method, urlPath, credentials]) => {
          const res = await fetch(urlPath, { method, credentials });
          const status = res.status;
          let json = null;
          try { json = await res.json(); } catch { /* not JSON — fine, status still checkable */ }
          return { status, json };
        },
        [method, urlPath, credentials]
      );
    } else if (step.mode === "dom") {
      label = `${step.action} → ${step.locate?.role ?? "*"} "${step.locate?.nameContains ?? step.locate?.nameExact ?? "*"}"`;
      if (dryRun) {
        results.push({ step: i + 1, ok: true, dryRun: true, would: label });
        continue;
      }
      try {
        const node = await findRef(page, session, step.locate ?? {});
        const ambiguity = node.ambiguous
          ? { warning: `locate matched ${node.ambiguousCount} elements, acted on the first: ${JSON.stringify(node.ambiguousNames)} — tighten "locate" to remove this risk` }
          : {};
        if (step.action === "read") {
          result = { text: node.value ?? node.name, ...ambiguity };
        } else if (step.action === "click") {
          await clickRef(page, session, node.ref);
          result = { clicked: node.ref, ...ambiguity };
        } else if (step.action === "fill") {
          await fillRef(page, session, node.ref, step.value);
          result = { filled: node.ref, ...ambiguity };
        } else {
          results.push({ step: i + 1, ok: false, reason: `unknown dom action "${step.action}"` });
          results.push({ stoppedEarly: true, at: i + 1 });
          break;
        }
      } catch (e) {
        results.push({ step: i + 1, ok: false, reason: e.message });
        results.push({ stoppedEarly: true, at: i + 1 });
        break;
      }
    } else {
      results.push({ step: i + 1, ok: false, skipped: true, reason: `unknown mode "${step.mode}" — expected "fetch" or "dom"` });
      results.push({ stoppedEarly: true, at: i + 1 });
      break;
    }

    const verdict = verifyExpect(step.expect, result);
    results.push({ step: i + 1, call: label, ...result, ...verdict });

    if (!verdict.ok) {
      // Fail loud, stop the run — never guess past a broken assumption.
      results.push({ stoppedEarly: true, at: i + 1 });
      break;
    }
  }
  return results;
}
