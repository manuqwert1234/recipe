#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";

// Modules are imported lazily, inside each command's action handler, not at
// the top of this file. Found live (2026-08-24): `recipe show` — pure JSON
// parsing, zero Chrome interaction — was paying the full ~250ms cost of
// importing playwright-core anyway, because it used to be a static top-level
// import shared by the whole CLI. A one-shot CLI invocation only ever runs
// ONE command, so only that command's real dependencies should be paid for.

const program = new Command();
program.name("recipes").description("Operate websites through their semantics, not their pixels.");

function out(obj, json) {
  if (json) {
    console.log(JSON.stringify(obj, null, 2));
  } else {
    console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  }
}

// ---- browser lifecycle ----
const browserCmd = program.command("browser").description("manage the persistent Chrome instance");
browserCmd
  .command("start")
  .option("--headless", "run without a visible window")
  .action(async (opts) => {
    const { startBrowser } = await import("../src/browser.js");
    const r = await startBrowser({ headless: !!opts.headless });
    console.log(r.alreadyRunning ? "Chrome already running." : `Chrome started (pid ${r.pid}).`);
  });
browserCmd.command("stop").action(async () => {
  const { stopBrowser } = await import("../src/browser.js");
  const r = await stopBrowser();
  console.log(r.wasRunning ? "Chrome stopped." : "Chrome was not running.");
});

// ---- sessions ----
program.command("sessions").option("--json").action(async (opts) => {
  const { connect } = await import("../src/browser.js");
  const { listSessions } = await import("../src/sessions.js");
  const { context, browser } = await connect();
  out(await listSessions(context), opts.json);
  await browser.close();
});

// ---- open ----
program
  .command("open <url>")
  .option("--session <name>", "session name to bind this tab to", "default")
  .action(async (url, opts) => {
    const { connect } = await import("../src/browser.js");
    const { acquireSession, tagPage } = await import("../src/sessions.js");
    const { needsHuman } = await import("../src/needs-human.js");
    const { context, browser } = await connect();
    // Reuse the tab already bound to this session name, if one is open —
    // otherwise a stale duplicate tab wins the next lookup (see sessions.js).
    const page = await acquireSession(context, opts.session);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // Re-stamp after navigation: window.name may have been wiped, and the
    // persisted URL needs to match the page we actually landed on.
    await tagPage(page, opts.session);
    const nh = await needsHuman(page);
    console.log(`Opened ${url} as session "${opts.session}".`);
    if (nh.needsHuman) console.log(`⚠ needs-human: ${nh.reason}`);
    await browser.close();
  });

// ---- snapshot ----
program
  .command("snapshot")
  .option("--session <name>", "session name", "default")
  .option("--diff", "only report what changed since the last snapshot")
  .option("--interactive", "only actionable elements")
  .option("--within <ref>", "scope to a subtree")
  .option("--json")
  .action(async (opts) => {
    const { connect } = await import("../src/browser.js");
    const { resolveSession } = await import("../src/sessions.js");
    const { takeSnapshot } = await import("../src/refs.js");
    const { context, browser } = await connect();
    const page = await resolveSession(context, opts.session);
    const result = await takeSnapshot(page, opts.session, {
      diff: !!opts.diff,
      interactive: !!opts.interactive,
      within: opts.within,
    });
    if (opts.json) {
      out(result, true);
    } else if (result.diff) {
      console.log(`+${result.added.length} added, -${result.removed.length} removed, ~${result.changed.length} changed`);
      for (const n of result.added) console.log(`  + [${n.ref}] ${n.role} "${n.name}"`);
      for (const n of result.removed) console.log(`  - [${n.ref}] ${n.role} "${n.name}"`);
      for (const n of result.changed) console.log(`  ~ [${n.ref}] ${n.role} "${n.name}" = ${n.value ?? ""}`);
      if (result.truncated) console.log(`… ${result.truncatedCount} more changes not shown — use --within <ref> to scope down.`);
    } else {
      for (const n of result.nodes) {
        console.log(`[${n.ref}] ${n.role} "${n.name}"${n.value ? ` = ${n.value}` : ""}`);
      }
      if (result.truncated) console.log(`… ${result.hint}`);
    }
    await browser.close();
  });

// ---- click / fill ----
program
  .command("click <ref>")
  .option("--session <name>", "session name", "default")
  .action(async (ref, opts) => {
    const { connect } = await import("../src/browser.js");
    const { resolveSession } = await import("../src/sessions.js");
    const { clickRef } = await import("../src/refs.js");
    const { context, browser } = await connect();
    const page = await resolveSession(context, opts.session);
    const r = await clickRef(page, opts.session, ref);
    console.log(`Clicked ${r.ref} at (${Math.round(r.x)}, ${Math.round(r.y)})`);
    await browser.close();
  });

program
  .command("fill <ref> <text>")
  .option("--session <name>", "session name", "default")
  .action(async (ref, text, opts) => {
    const { connect } = await import("../src/browser.js");
    const { resolveSession } = await import("../src/sessions.js");
    const { fillRef } = await import("../src/refs.js");
    const { context, browser } = await connect();
    const page = await resolveSession(context, opts.session);
    await fillRef(page, opts.session, ref, text);
    console.log(`Filled ${ref}.`);
    await browser.close();
  });

// ---- needs-human ----
program
  .command("needs-human")
  .option("--session <name>", "session name", "default")
  .option("--json")
  .action(async (opts) => {
    const { connect } = await import("../src/browser.js");
    const { resolveSession } = await import("../src/sessions.js");
    const { needsHuman } = await import("../src/needs-human.js");
    const { context, browser } = await connect();
    const page = await resolveSession(context, opts.session);
    out(await needsHuman(page), opts.json);
    await browser.close();
  });

// ---- record (network capture) ----
program
  .command("record <outFile>")
  .option("--session <name>", "session name", "default")
  .option("--duration <ms>", "how long to capture", "15000")
  .action(async (outFile, opts) => {
    const { connect } = await import("../src/browser.js");
    const { resolveSession } = await import("../src/sessions.js");
    const { captureNetwork } = await import("../src/network.js");
    const { context, browser } = await connect();
    const page = await resolveSession(context, opts.session);
    console.log(`Recording XHR/Fetch traffic for ${opts.duration}ms — interact with the page now...`);
    const entries = await captureNetwork(page, { durationMs: Number(opts.duration) });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(entries, null, 2));
    console.log(`Captured ${entries.length} XHR/Fetch requests → ${outFile}`);
    await browser.close();
  });

// ---- recipe ----
const recipeCmd = program.command("recipe").description("record, review, and replay flows");
recipeCmd
  .command("from-network <captureFile> <outFile>")
  .requiredOption("--site <site>", "site name for the recipe")
  .option("--ttl <ttl>", "e.g. 1h, 30m, 6h", "1h")
  .action(async (captureFile, outFile, opts) => {
    const { recipeFromCapture } = await import("../src/recipe.js");
    const entries = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    const recipe = recipeFromCapture(entries, { site: opts.site, ttl: opts.ttl });
    fs.writeFileSync(outFile, JSON.stringify(recipe, null, 2));
    console.log(`Draft recipe with ${recipe.steps.length} step(s) written to ${outFile}.`);
    console.log(`Review with "recipes recipe show ${outFile}" before running — expect clauses only check status codes so far.`);
  });

recipeCmd
  .command("show <file>")
  .action(async (file) => {
    // The whole point of this command: no Chrome, no playwright-core — just
    // read a file and format it. Genuinely near-instant now.
    const { loadRecipe, renderShow } = await import("../src/recipe.js");
    console.log(renderShow(loadRecipe(file)));
  });

recipeCmd
  .command("run <file>")
  .option("--session <name>", "session name", "default")
  .option("--dry-run", "print what would happen without making requests")
  .option("--json")
  .action(async (file, opts) => {
    const { loadRecipe, runRecipe } = await import("../src/recipe.js");
    const recipe = loadRecipe(file);
    if (opts.dryRun) {
      // Dry-run needs no Chrome either — don't pay for a connection just to print intentions.
      const results = await runRecipe(null, recipe, { dryRun: true, session: opts.session });
      out(results, !!opts.json);
      return;
    }
    const { connect } = await import("../src/browser.js");
    const { resolveSession } = await import("../src/sessions.js");
    const { context, browser } = await connect();
    const page = await resolveSession(context, opts.session);
    const results = await runRecipe(page, recipe, { dryRun: false, session: opts.session });
    await browser.close();

    if (opts.json) {
      out(results, true);
    } else {
      for (const r of results) {
        if (r.stoppedEarly) {
          console.log(`✗ stopped after step ${r.at} — assertion failed, not guessing further.`);
          continue;
        }
        const mark = r.ok ? "✓" : "✗";
        console.log(`${mark} step ${r.step}${r.call ? ` ${r.call}` : ""}${r.reason ? ` — ${r.reason}` : ""}`);
      }
    }
    const failed = results.some((r) => r.ok === false);
    process.exit(failed ? 1 : 0);
  });

recipeCmd
  .command("watch <file>")
  .option("--session <name>", "session name", "default")
  .option("--interval <sec>", "seconds between checks when looping (omit for a single check, e.g. under cron)")
  .option("--notify-cmd <path>", "executable run with a JSON blob as argv[1] when something changed")
  .option("--json")
  .action(async (file, opts) => {
    const { loadRecipe } = await import("../src/recipe.js");
    const { watchTick } = await import("../src/watch.js");
    const { connect } = await import("../src/browser.js");
    const { resolveSession } = await import("../src/sessions.js");
    const recipe = loadRecipe(file);
    const recipeName = path.basename(file, ".json");

    async function tickOnce() {
      const { context, browser } = await connect();
      const page = await resolveSession(context, opts.session);
      const result = await watchTick(page, recipe, recipeName, { notifyCmd: opts.notifyCmd, session: opts.session });
      await browser.close();
      return result;
    }

    function report(result) {
      if (opts.json) {
        out({ ...result, checkedAt: new Date().toISOString() }, true);
      } else {
        const stamp = new Date().toISOString();
        if (result.status === "changed") console.log(`[${stamp}] CHANGED  ${result.reason ?? JSON.stringify(result.changes)}`);
        else if (result.status === "unchanged") console.log(`[${stamp}] unchanged`);
        else if (result.status === "needs-human") console.log(`[${stamp}] ⚠ needs-human — ${result.reason}`);
        else console.log(`[${stamp}] ✗ failed — ${result.reason}`);
      }
    }

    if (!opts.interval) {
      // Single-shot mode — this is the cron-friendly path.
      const result = await tickOnce();
      report(result);
      process.exit(result.status === "failed" || result.status === "needs-human" ? 1 : 0);
    }

    // Loop mode — for local testing/dev, not for cron (cron should call --interval-less and let cron own the schedule).
    console.log(`Watching "${recipeName}" every ${opts.interval}s. Ctrl+C to stop.`);
    for (;;) {
      report(await tickOnce());
      await new Promise((r) => setTimeout(r, Number(opts.interval) * 1000));
    }
  });

program.parseAsync(process.argv);
