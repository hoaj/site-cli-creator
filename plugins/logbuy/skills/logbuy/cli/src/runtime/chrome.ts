// Google Chrome at the fixed per-OS paths playwright-core's "chrome" channel uses (SPEC §9).
// No browser is shipped. SITE_CLI_CHROME overrides the path.
import { existsSync } from "node:fs";
import type { Env } from "./site";

export function chromeCandidates(platform: string = process.platform, env: Env = process.env): string[] {
  if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  if (platform === "linux") return ["/opt/google/chrome/chrome"];
  if (platform === "win32") {
    const roots = [
      env.LOCALAPPDATA,
      env.PROGRAMFILES,
      env["PROGRAMFILES(X86)"],
      env.HOMEDRIVE && `${env.HOMEDRIVE}\\Program Files`,
      env.HOMEDRIVE && `${env.HOMEDRIVE}\\Program Files (x86)`,
    ].filter((r): r is string => !!r);
    return roots.map((r) => `${r}\\Google\\Chrome\\Application\\chrome.exe`);
  }
  return [];
}

export type ChromeLookup = { path?: string; checked: string[]; override: boolean };

export function findChrome(
  env: Env = process.env,
  platform: string = process.platform,
  exists: (p: string) => boolean = existsSync,
): ChromeLookup {
  if (env.SITE_CLI_CHROME) {
    const p = env.SITE_CLI_CHROME;
    return { path: exists(p) ? p : undefined, checked: [p], override: true };
  }
  const checked = chromeCandidates(platform, env);
  return { path: checked.find((p) => exists(p)), checked, override: false };
}

export function installHint(platform: string = process.platform): string {
  if (platform === "linux") return "Install Google Chrome (google-chrome-stable) from https://www.google.com/chrome/ so it lands in /opt/google/chrome/, or set SITE_CLI_CHROME to its path.";
  return "Install Google Chrome from https://www.google.com/chrome/ in its default location, or set SITE_CLI_CHROME to its path.";
}

/** launchPersistentContext options that select the user's Chrome. */
export function chromeLaunchOptions(lookup: ChromeLookup): { channel?: "chrome"; executablePath?: string } {
  return lookup.override && lookup.path ? { executablePath: lookup.path } : { channel: "chrome" };
}
