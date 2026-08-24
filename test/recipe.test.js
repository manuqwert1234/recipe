// Pure-logic tests — no Chrome needed, so these actually re-run automatically
// (`node --test`), unlike everything verified live this session. Covers the
// parts of src/recipe.js that don't need a browser: ttl checking, the dry-run
// renderer, and capture→recipe generation.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRecipe, renderShow, checkTtl, recipeFromCapture } from "../src/recipe.js";

function tmpFile(content) {
  const p = path.join(os.tmpdir(), `recipes-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(content));
  return p;
}

test("checkTtl: no ttl set → unchecked", () => {
  const r = checkTtl({ site: "x", steps: [] });
  assert.equal(r.checked, false);
  assert.equal(r.reason, "no ttl set");
});

test("checkTtl: ttl set but no recordedAt → unchecked, not a false pass", () => {
  const r = checkTtl({ site: "x", ttl: "1h", steps: [] });
  assert.equal(r.checked, false);
  assert.match(r.reason, /recordedAt/);
});

test("checkTtl: fresh recipe → not stale", () => {
  const r = checkTtl({ site: "x", ttl: "1h", recordedAt: new Date().toISOString(), steps: [] });
  assert.equal(r.checked, true);
  assert.equal(r.stale, false);
});

test("checkTtl: recipe older than its ttl → stale", () => {
  const r = checkTtl({ site: "x", ttl: "1h", recordedAt: "2020-01-01T00:00:00.000Z", steps: [] });
  assert.equal(r.checked, true);
  assert.equal(r.stale, true);
});

test("checkTtl: various duration units parse correctly", () => {
  const now = new Date().toISOString();
  assert.equal(checkTtl({ ttl: "30s", recordedAt: now }).stale, false);
  assert.equal(checkTtl({ ttl: "6h", recordedAt: now }).stale, false);
  assert.equal(checkTtl({ ttl: "1d", recordedAt: now }).stale, false);
  assert.equal(checkTtl({ ttl: "bogus", recordedAt: now }).checked, false); // unparseable ttl treated as "no ttl", not a crash
});

test("loadRecipe: rejects a file missing required fields", () => {
  const p = tmpFile({ notASite: true });
  assert.throws(() => loadRecipe(p), /needs "site" and "steps"/);
});

test("loadRecipe: accepts a minimal valid recipe", () => {
  const p = tmpFile({ site: "x", steps: [] });
  const r = loadRecipe(p);
  assert.equal(r.site, "x");
});

test("renderShow: surfaces a missing expect clause as an explicit warning, not silence", () => {
  const out = renderShow({ site: "x", steps: [{ mode: "fetch", call: "GET /a" }] });
  assert.match(out, /no expect clause — this step's success is unverified/);
});

test("renderShow: reports stale ttl clearly in the dry-run", () => {
  const out = renderShow({ site: "x", ttl: "1h", recordedAt: "2020-01-01T00:00:00.000Z", steps: [] });
  assert.match(out, /STALE/);
});

test("recipeFromCapture: only GET requests become steps (writes need a human, not a guess)", () => {
  const entries = [
    { method: "GET", url: "https://x.com/a", status: 200 },
    { method: "POST", url: "https://x.com/b", status: 201 },
  ];
  const recipe = recipeFromCapture(entries, { site: "x.com" });
  assert.equal(recipe.steps.length, 1);
  assert.equal(recipe.steps[0].call, "GET /a");
});

test("recipeFromCapture: dedupes identical method+path", () => {
  const entries = [
    { method: "GET", url: "https://x.com/a?x=1", status: 200 },
    { method: "GET", url: "https://x.com/a?x=1", status: 200 },
    { method: "GET", url: "https://x.com/a?x=2", status: 200 },
  ];
  const recipe = recipeFromCapture(entries, { site: "x.com" });
  assert.equal(recipe.steps.length, 2); // ?x=1 once, ?x=2 once
});

test("recipeFromCapture: stamps a recordedAt so ttl enforcement actually works on generated recipes", () => {
  const recipe = recipeFromCapture([], { site: "x.com" });
  assert.ok(recipe.recordedAt);
  assert.equal(checkTtl(recipe).checked, true);
});
