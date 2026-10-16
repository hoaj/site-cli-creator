// The Setup page of remote mode (`/setup`): where the Owner gives the server a Session. This file
// holds the page's own state (session-status.json, next to session.json) and its HTML; the routes
// are in remote.ts. The page never shows, and the status file never holds, any part of a Session.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { esc, page } from "./owner-auth";
import { ensureStateDir, sessionFile, writePrivateJson } from "./session";
import type { Env } from "./site";

/** What the live check of an uploaded Session found: tried = how many reads worked with it (0: none could run without input). */
export type SessionCheck = { ok: true; tried: number } | { ok: false; reason: string };

export type SessionState = "valid" | "expired" | "missing" | "unchecked";
export type SessionStatus = { state: SessionState; uploadedAt?: string; checkedAt?: string; reason?: string };

export const statusFile = (dir: string) => join(dir, "session-status.json");

/** "missing" without a session.json; "unchecked" when one is there but nothing has checked it (a `login` on this host). */
export function readStatus(dir: string): SessionStatus {
  if (!existsSync(sessionFile(dir))) return { state: "missing" };
  try {
    const s = JSON.parse(readFileSync(statusFile(dir), "utf8")) as SessionStatus;
    if (s && (s.state === "valid" || s.state === "expired" || s.state === "unchecked")) {
      const text = (v: unknown) => (typeof v === "string" ? v : undefined);
      return { state: s.state, uploadedAt: text(s.uploadedAt), checkedAt: text(s.checkedAt), reason: text(s.reason) };
    }
  } catch {}
  return { state: "unchecked" };
}

export function writeStatus(dir: string, status: Omit<SessionStatus, "state"> & { state: "valid" | "expired" | "unchecked" }): void {
  ensureStateDir(dir);
  writePrivateJson(statusFile(dir), status);
}

/** Deletes the stored Session and its status. */
export function clearSession(dir: string): void {
  rmSync(sessionFile(dir), { force: true });
  rmSync(statusFile(dir), { force: true });
}

const RAILWAY_VARIABLES = ["RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID"];

/** Whether the state dir will survive a deploy: on Railway it must be on the attached volume. */
export function persistenceWarning(env: Env, dir: string): string | null {
  if (!RAILWAY_VARIABLES.some((name) => env[name])) return null;
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!volume) return `No volume is attached: the Session and every client's sign-in disappear on the next deploy. Attach a volume and keep this server's state dir (${dir}) on it.`;
  const inside = relative(resolve(volume), resolve(dir));
  if (inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) return null;
  return `The state dir ${dir} is not on the volume (${volume}): it disappears on the next deploy. Point HOME (or the state dir) at the volume.`;
}

export type SetupPage = {
  serverName: string;
  siteName: string;
  auth: "login" | "none";
  status: SessionStatus;
  warning: string | null;
  notice?: { kind: "ok" | "error"; text: string };
  skill: string;
};

const FORM_STYLE = `textarea{width:100%;min-height:96px;font:13px/1.4 ui-monospace,Menlo,monospace;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)}
.ok{color:#1e7a46}@media (prefers-color-scheme:dark){.ok{color:#6fd49a}}
h2{font-size:17px;margin:28px 0 4px}.wrap{max-width:560px}hr{border:0;border-top:1px solid var(--line);margin:24px 0 0}code{font-size:14px}`;

const when = (iso?: string) => (iso ? esc(iso.replace("T", " ").replace(/\.\d+Z$/, "Z")) : "never");

function statusLine(s: SessionStatus): string {
  switch (s.state) {
    case "valid":
      return `<p><b>Session: valid</b></p><p class="muted">Uploaded ${when(s.uploadedAt)}, last checked ${when(s.checkedAt)}.</p>`;
    case "expired":
      return `<p class="error"><b>Session: expired</b></p><p class="muted">${s.reason ? `${esc(s.reason)} ` : ""}Last checked ${when(s.checkedAt)}. Upload a new one below.</p>`;
    case "unchecked":
      return `<p><b>Session: unchecked</b></p><p class="muted">A Session is stored, but it has not been checked against the site${s.uploadedAt ? ` (uploaded ${when(s.uploadedAt)})` : ""}. It is used when a tool runs.</p>`;
    case "missing":
      return `<p><b>Session: missing</b></p><p class="muted">No Session is stored, so the tools cannot reach the site as you. Upload one below.</p>`;
  }
}

const passwordField = (id: string) =>
  `<label for="${id}">The Owner password</label><input id="${id}" type="password" name="password" autocomplete="current-password" required>`;

export function setupPage(o: SetupPage): string {
  const skill = esc(o.skill);
  const upload = `<h2>Upload a Session</h2>
     <p class="muted">On your computer run <code>${skill} login</code>, then upload the <code>session.json</code> from its state dir. The server tries it against ${esc(o.siteName)} first and keeps the old one if it does not work.</p>
     <form method="post" action="/setup/session" enctype="multipart/form-data">
       <label for="file">session.json</label><input id="file" type="file" name="session_file">
       <label for="text">or paste its contents</label><textarea id="text" name="session_text" spellcheck="false" autocomplete="off"></textarea>
       ${passwordField("pw-upload")}
       <button type="submit">Check and store</button>
     </form>
     <hr><h2>Delete the Session</h2>
     <p class="muted">The server forgets it; the tools then fail until you upload a new one.</p>
     <form method="post" action="/setup/delete">${passwordField("pw-delete")}<button type="submit">Delete the Session</button></form>`;
  const body = `<p class="muted">${esc(o.serverName)} on <b>${esc(o.siteName)}</b></p>
     ${o.warning ? `<p class="error">${esc(o.warning)}</p>` : ""}
     ${o.notice ? `<p class="${o.notice.kind === "ok" ? "ok" : "error"}"><b>${esc(o.notice.text)}</b></p>` : ""}
     ${o.auth === "login" ? `${statusLine(o.status)}${upload}` : `<p>This site needs no sign-in, so there is no Session to upload.</p>`}
     <hr><h2>Sign out every client</h2>
     <p class="muted">Every connected assistant has to sign in to this server again.</p>
     <form method="post" action="/setup/signout">${passwordField("pw-signout")}<button type="submit">Sign out every client</button></form>`;
  return page("Setup", body, "", FORM_STYLE);
}
