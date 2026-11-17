// Plain fetch looks like the user's own browser by default (SPEC §7, #111). Bun's fetch sends
// `user-agent: Bun/…` and little else, which many bot protections refuse on sight. withBrowserHeaders
// adds the user-agent of the Chrome installed on this machine (its version, as installed) and an
// accept-language, each only when the request has none of its own, so a site's headers win. Chrome's
// TLS and JavaScript stay with transport "browser"; this changes headers only.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findChrome } from "./chrome";
import type { Env, Fetch } from "./site";

/** The Chrome major used when none is installed or its version cannot be read. */
const FALLBACK_MAJOR = "141";

/** Chrome's reduced user-agent: the platform token is fixed, the version is `<major>.0.0.0`. */
export function browserUserAgent(version: string | undefined, platform: string = process.platform): string {
  const major = /^\d+/.exec(version ?? "")?.[0] ?? FALLBACK_MAJOR;
  const os = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** The accept-language of a browser set to `locale` (the process's: Bun reads LANG and LC_ALL, so an app launched without them says en-US): the locale, its language, then English. */
export function acceptLanguage(locale: string | undefined): string {
  const tag = locale && /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(locale) ? locale : "en-US";
  const language = tag.split("-")[0]!;
  if (language === "en") return tag === "en" ? "en;q=0.9" : `${tag},en;q=0.9`;
  return tag === language ? `${tag},en;q=0.8` : `${tag},${language};q=0.9,en;q=0.8`;
}

/** The installed Chrome's version (`141.0.7390.55`), read where it is cheap to read; undefined when unknown. */
export function installedChromeVersion(env: Env = process.env, platform: string = process.platform): string | undefined {
  const path = findChrome(env, platform).path;
  if (!path) return undefined;
  try {
    if (platform === "darwin") {
      // <app>/Contents/MacOS/<binary>: the app's Info.plist holds the version.
      const plist = readFileSync(join(dirname(dirname(path)), "Info.plist"), "utf8");
      return /<key>CFBundleShortVersionString<\/key>\s*<string>([\d.]+)<\/string>/.exec(plist)?.[1];
    }
    if (platform === "win32") {
      // chrome.exe sits next to a folder named for the version (a Chrome that is updating has two).
      const versions = readdirSync(dirname(path)).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
      return versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    }
    const out = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 2_000 });
    return /(\d+\.\d+\.\d+\.\d+)/.exec(out.stdout ?? "")?.[1];
  } catch {
    return undefined;
  }
}

export type BrowserHeaderSources = { userAgent(): string; acceptLanguage(): string };

/** The user's own Chrome and locale, read on the first request that needs them and kept for the run. */
export function defaultSources(env: Env = process.env): BrowserHeaderSources {
  let ua: string | undefined;
  let lang: string | undefined;
  return {
    userAgent: () => (ua ??= browserUserAgent(installedChromeVersion(env))),
    acceptLanguage: () => (lang ??= acceptLanguage(Intl.DateTimeFormat().resolvedOptions().locale)),
  };
}

/** The headers a call goes with: a Request's, then init's over them (as the Client's own calls expect), then `defaults` for each the call lacks. */
function withDefaults(input: Parameters<Fetch>[0], init: RequestInit | undefined, defaults: () => [string, string][]): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
  for (const [k, v] of defaults()) if (!headers.has(k)) headers.set(k, v);
  return headers;
}

/** `send` with the site's own headers added to a request to its origin, where the request names none. */
export function withSiteHeaders(send: Fetch, headers: Record<string, string> | undefined, origin: string): Fetch {
  if (!headers || Object.keys(headers).length === 0) return send;
  const own = new URL(origin).origin;
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    if (url.origin !== own) return send(input, init);
    return send(input, { ...init, headers: withDefaults(input, init, () => Object.entries(headers)) });
  };
}

/** `send` with a user-agent and accept-language added where the request names none. */
export function withBrowserHeaders(send: Fetch, sources: BrowserHeaderSources = defaultSources()): Fetch {
  return (input, init) => send(input, { ...init, headers: withDefaults(input, init, () => [["user-agent", sources.userAgent()], ["accept-language", sources.acceptLanguage()]]) });
}
