// Phase 6 — watch. The cron-friendly wrapper: run a recipe, diff the result
// against the last known-good state, and never let a failure silently look
// like "no change" (that's the whole point of storing last-good separately
// from last-attempt).

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { CONFIG_DIR } from "./paths.js";
import { needsHuman } from "./needs-human.js";
import { runRecipe } from "./recipe.js";

function stateFile(recipeName) {
  return path.join(CONFIG_DIR, "watch", `${recipeName}.json`);
}

function loadLastGood(recipeName) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(recipeName), "utf8"));
  } catch {
    return null;
  }
}

function saveLastGood(recipeName, result) {
  fs.mkdirSync(path.dirname(stateFile(recipeName)), { recursive: true });
  fs.writeFileSync(stateFile(recipeName), JSON.stringify({ result, checkedAt: new Date().toISOString() }, null, 2));
}

function diffJson(prev, next) {
  const changes = [];
  const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]);
  for (const k of keys) {
    const a = prev?.[k];
    const b = next?.[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ key: k, from: a, to: b });
  }
  return changes;
}

/**
 * Run one watch check: recipe result vs. last-known-good.
 * Returns a status that's always one of: "unchanged" | "changed" | "needs-human" | "failed".
 * A "failed" or "needs-human" tick never overwrites last-good state — so the
 * next successful check still diffs against the last real answer, not a hole.
 */
export async function watchTick(page, recipe, recipeName, { notifyCmd, session = "default" } = {}) {
  const nh = await needsHuman(page);
  if (nh.needsHuman) {
    return { status: "needs-human", reason: nh.reason };
  }

  let results;
  try {
    results = await runRecipe(page, recipe, { session });
  } catch (e) {
    return { status: "failed", reason: e.message };
  }

  const failedStep = results.find((r) => r.ok === false);
  if (failedStep) {
    return { status: "failed", reason: failedStep.reason ?? "assertion failed", step: failedStep.step };
  }

  // Use the last real step's result as the thing we're watching — "did my
  // balance change", not just "did the check still succeed". Shape differs
  // by mode: fetch carries {status, json}, a dom "read" carries {text}.
  const latest = results.filter((r) => r.status !== undefined || r.text !== undefined).at(-1);
  const current = latest ? { status: latest.status, json: latest.json, text: latest.text } : {};
  const last = loadLastGood(recipeName);
  saveLastGood(recipeName, current);

  if (!last) return { status: "changed", reason: "first successful check — baseline recorded" };

  const changes = diffJson(last.result, current);
  if (changes.length === 0) return { status: "unchanged" };

  if (notifyCmd) {
    execFile(notifyCmd, [JSON.stringify({ recipe: recipeName, changes })], () => {});
  }
  return { status: "changed", changes };
}
