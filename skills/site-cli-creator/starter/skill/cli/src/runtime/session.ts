// State lives in ~/.<plugin>/ for a skill named after its plugin, else ~/.<plugin>-<skill>/ (0700):
// session.json (0600) and, for login skills, profile/ (the tool-owned Chrome user-data dir).
// renew.lock exists only while a run renews the session (login.refresh).
// SITE_CLI_HOME overrides the dir (tests, and the Deploy skill's separate sign-in for a server).
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const RENEW_WAIT_MS = 15_000;
/** A renew.lock older than this was left by a run that died; renewing never takes this long. */
const RENEW_STALE_MS = 60_000;

/**
 * Runs `fn` holding `<dir>/renew.lock`, created exclusively, so one run at a time renews: a
 * rotating refresh token works once, and two runs sending it at once can revoke its whole family.
 * Waits up to 15 s for another run's lock, then answers "busy"; takes over a lock older than 60 s.
 */
export async function withRenewLock<T>(dir: string, fn: () => Promise<T>, sleep: (ms: number) => Promise<void>, now: () => number = Date.now): Promise<T | "busy"> {
  ensureStateDir(dir);
  const file = join(dir, "renew.lock");
  const deadline = now() + RENEW_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(file, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      try {
        if (now() - statSync(file).mtimeMs > RENEW_STALE_MS) {
          rmSync(file, { force: true });
          continue;
        }
      } catch {
        continue; // released meanwhile
      }
      if (now() > deadline) return "busy";
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(file, { force: true });
  }
}
