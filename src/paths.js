import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
export const CONFIG_DIR = path.join(HOME, ".recipes");
export const PROFILE_DIR = path.join(HOME, ".web", "profile");
export const BROWSER_STATE_FILE = path.join(CONFIG_DIR, "browser.json");
export const SESSIONS_FILE = path.join(CONFIG_DIR, "sessions.json");
export const RECIPES_DIR = path.join(process.cwd(), "recipes");
export const CDP_PORT = 9333;
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

// Chrome executable, per platform. macOS-only for v1 — the machine this
// was built and verified on. Linux/Windows paths are stubbed and untested.
export function chromeExecutablePath() {
  const candidates = {
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    linux: "/usr/bin/google-chrome",
    win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  };
  const p = candidates[process.platform];
  if (!p) throw new Error(`Unsupported platform: ${process.platform}`);
  return p;
}
