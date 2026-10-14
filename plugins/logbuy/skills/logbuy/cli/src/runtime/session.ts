// State lives in ~/.<plugin>/ for a skill named after its plugin, else ~/.<plugin>-<skill>/ (0700):
// session.json (0600) and, for login skills, profile/ (the tool-owned Chrome user-data dir).
// SITE_CLI_HOME overrides the dir (tests).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account } from "./envelope";
import type { Env } from "./site";

export type Session = {
  headers: Record<string, string>;
  ids: Record<string, string>;
  /** Account ids only: labels come from the site and are never saved. */
  accounts?: Pick<Account, "id">[];
  savedAt: string;
};

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
  const file = sessionFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(full, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return full;
}
