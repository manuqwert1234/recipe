import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const HOME = os.homedir();
export const CONFIG_DIR = path.join(HOME, ".recipes");
export const PROFILE_DIR = path.join(HOME, ".web", "profile");
export const BROWSER_STATE_FILE = path.join(CONFIG_DIR, "browser.json");
export const SESSIONS_FILE = path.join(CONFIG_DIR, "sessions.json");
export const RECIPES_DIR = path.join(process.cwd(), "recipes");
export const CDP_PORT = 9333;
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

/**
 * Chrome executable, per platform. Each platform lists real, known install
 * locations in likely-first order; the first one that actually exists on
 * disk wins. This matters especially on Windows, where the modern default
 * is a per-user install under %LOCALAPPDATA% (no admin rights needed) —
 * a single hardcoded Program Files path misses that case entirely.
 *
 * Verified end-to-end only on macOS, where this was built (Chrome 151,
 * the standard /Applications location). Linux and Windows candidate paths
 * are real, researched install locations, not guesses — but neither has
 * been run on actual Linux/Windows hardware. If none of a platform's
 * candidates exist, the error lists exactly what was checked, so a
 * mismatch is diagnosable rather than a mysterious spawn failure.
 */
function candidatePaths() {
  const home = HOME;
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      ];
    case "linux":
      return [
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/opt/google/chrome/google-chrome",
        "/snap/bin/chromium",
      ];
    case "win32": {
      const programFiles = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
      const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
      const localAppData = process.env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local");
      return [
        // Per-user install — the modern default; Chrome's installer uses
        // this location when run without admin rights, which is common.
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      ];
    }
    default:
      return [];
  }
}

export function chromeExecutablePath() {
  const candidates = candidatePaths();
  if (candidates.length === 0) {
    throw new Error(`Unsupported platform: ${process.platform} (supported: darwin, linux, win32)`);
  }
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  throw new Error(
    `Could not find Chrome. Checked:\n${candidates.map((p) => `  - ${p}`).join("\n")}\n` +
      `If Chrome is installed somewhere else, this platform's candidate list in src/paths.js needs another entry.`
  );
}
