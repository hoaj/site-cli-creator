// State lives in ~/.<plugin>/ for a skill named after its plugin, else ~/.<plugin>-<skill>/ (0700):
// session.json (0600) and, for login skills, profile/ (the tool-owned Chrome user-data dir).
// renew.lock exists only while a run renews the session (login.refresh).
// SITE_CLI_HOME overrides the dir (tests, and the Deploy skill's separate sign-in for a server).
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Account } from "./envelope";
import type { Env } from "./site";

export type Session = {
  headers: Record<string, string>;
  ids: Record<string, string>;
  /** Account ids only: labels come from the site and are never saved. */
  accounts?: Pick<Account, "id">[];
  /**
   * The Chrome profile `login --from-profile` signed in from (an absolute path, no cookie). The
   * silent refresh and `check --writes` seed their Chrome from it again, since the CLI's own
   * profile/ holds no sign-in then.
   */
  fromProfile?: string;
  /** What login.refresh.keep kept (a refresh token): renew trades it for a new session. Never logged. */
  refresh?: Record<string, string>;
  savedAt: string;
};

/**
 * What the Setup page accepts as a Session: the shape `login` writes. Unknown keys are stripped
 * (`fromProfile` is a path on the Owner's computer, meaningless on a server).
 */
export const sessionUploadSchema = z.object({
  headers: z.record(z.string(), z.string()),
  ids: z.record(z.string(), z.string()),
  accounts: z.array(z.object({ id: z.string() })).optional(),
  refresh: z.record(z.string(), z.string()).optional(),
  savedAt: z.string().optional(),
});

type Names = { plugin: string; skill: string };

/** SPEC §7: `~/.<plugin>/` when the skill is named after its plugin, else `~/.<plugin>-<skill>/`. */
export function stateDir(site: Names, env: Env = process.env, home: string = homedir()): string {
  if (env.SITE_CLI_HOME) return env.SITE_CLI_HOME;
  return join(home, site.skill === site.plugin ? `.${site.plugin}` : `.${site.plugin}-${site.skill}`);
}

/**
 * Where builds before generator 0.2.1 kept this skill's state, when that differs from stateDir():
 * `~/.<plugin>-<plugin>/` for a skill named after its plugin. Null otherwise.
 */
export function legacyStateDir(site: Names, env: Env = process.env, home: string = homedir()): string | null {
  if (env.SITE_CLI_HOME || site.skill !== site.plugin) return null;
  return join(home, `.${site.plugin}-${site.skill}`);
}

export type Migration = { moved: false; leftAlone?: string } | { moved: true; from: string; to: string };

/**
 * Moves the legacy state dir to stateDir() once, so the user stays signed in: only when the new
 * dir doesn't exist yet. Never merges or deletes: if both exist, the new one is used and the old
 * one is left alone (`leftAlone`, which `doctor` reports).
 */
export function migrateStateDir(site: Names, env: Env = process.env, home: string = homedir()): Migration {
  const from = legacyStateDir(site, env, home);
  if (!from || !existsSync(from)) return { moved: false };
  const to = stateDir(site, env, home);
  if (existsSync(to)) return { moved: false, leftAlone: from };
  renameSync(from, to);
  chmodSync(to, 0o700);
  if (existsSync(sessionFile(to))) chmodSync(sessionFile(to), 0o600);
  return { moved: true, from, to };
}

export function ensureStateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export const sessionFile = (dir: string) => join(dir, "session.json");
export const profileDir = (dir: string) => join(dir, "profile");
/** The CLI's own Chrome profile, created (0700) with the state dir around it. */
export const ensureProfileDir = (site: Names, env: Env = process.env) => ensureStateDir(profileDir(ensureStateDir(stateDir(site, env))));

export function loadSession(dir: string): Session | null {
  const file = sessionFile(dir);
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (!s || typeof s !== "object" || typeof s.headers !== "object" || typeof s.ids !== "object") return null;
    return s as Session;
  } catch {
    return null;
  }
}

export function saveSession(dir: string, session: Omit<Session, "savedAt"> & { savedAt?: string }): Session {
  ensureStateDir(dir);
  const full: Session = { ...session, savedAt: session.savedAt ?? new Date().toISOString() };
  writePrivateJson(sessionFile(dir), full);
  return full;
}

/** A JSON file written atomically (a unique tmp file, then rename) with mode 0600. */
export function writePrivateJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const RENEW_POLL_MS = 100;
/** 15 s of polls: how long a run waits for another run's renewal. Counted in polls, not wall time. */
const RENEW_WAIT_POLLS = 150;
/** A renew.lock untouched for this long was left by a run that died: a live holder touches it every 10 s. */
const RENEW_STALE_MS = 60_000;
const RENEW_HEARTBEAT_MS = 10_000;

/**
 * Runs `fn` holding `<dir>/renew.lock`, so one run at a time renews: a rotating refresh token works
 * once, and two runs sending it at once can revoke its whole family.
 * - The lock is created exclusively and holds this run's own random token. It is removed only
 *   while it still holds that token, so a run never removes another run's lock.
 * - Another run's lock is waited for (150 polls of 100 ms), then this answers "busy".
 * - A lock older than 60 s is taken over by renaming it away first: only one run's rename succeeds.
 */
export async function withRenewLock<T>(dir: string, fn: () => Promise<T>, sleep: (ms: number) => Promise<void>, now: () => number = Date.now): Promise<T | "busy"> {
  ensureStateDir(dir);
  const file = join(dir, "renew.lock");
  const mine = randomBytes(8).toString("hex");
  for (let polls = 0; ; polls++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, mine);
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      try {
        if (now() - statSync(file).mtimeMs > RENEW_STALE_MS) {
          const away = `${file}.${mine}.stale`;
          renameSync(file, away); // throws for every run but one
          // Between the stat and the rename another run may have taken it over and made a fresh lock:
          // then that one moved, and it goes back (link fails when a third run already holds the path).
          if (now() - statSync(away).mtimeMs <= RENEW_STALE_MS) {
            try {
              linkSync(away, file);
            } catch {
              // the path is held again: that run's lock stands
            }
          }
          rmSync(away, { force: true });
          continue;
        }
      } catch {
        continue; // released or taken over meanwhile: try again
      }
      if (polls >= RENEW_WAIT_POLLS) return "busy";
      await sleep(RENEW_POLL_MS);
    }
  }
  // While held, the lock is touched every 10 s, so a slow renewal (retries, a slow endpoint) never
  // looks stale to another run.
  const heartbeat = setInterval(() => {
    try {
      if (readFileSync(file, "utf8") === mine) utimesSync(file, new Date(), new Date());
    } catch {
      // gone: nothing to keep alive
    }
  }, RENEW_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      if (readFileSync(file, "utf8") === mine) rmSync(file, { force: true });
    } catch {
      // already gone
    }
  }
}
