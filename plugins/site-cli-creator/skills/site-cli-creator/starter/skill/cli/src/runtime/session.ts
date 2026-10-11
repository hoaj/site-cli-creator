// State lives in ~/.<plugin>-<skill>/ (0700): session.json (0600) and, for login skills,
// profile/ (the tool-owned Chrome user-data dir). SITE_CLI_HOME overrides the dir (tests).
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

export function stateDir(site: Names, env: Env = process.env): string {
  return env.SITE_CLI_HOME || join(homedir(), `.${site.plugin}-${site.skill}`);
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
