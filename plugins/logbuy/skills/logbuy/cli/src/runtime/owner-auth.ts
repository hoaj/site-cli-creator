// The Owner's Server sign-in for remote mode: an OAuth 2.1 authorization server with exactly one
// user. The MCP SDK's router does discovery, registration, PKCE and the token endpoint; this file
// is the storage behind it, the password check and the sign-in page. Ported from BankMCP's
// SingleUserProvider, with its weaknesses fixed: an unknown token is 401 (InvalidTokenError),
// registration never evicts a client with live tokens, tokens are bound to this server's /mcp,
// a reused refresh token signs its client out, a revoke drops both tokens of a pair, and the
// password fingerprint behind the kill switch is an HMAC with a per-instance salt.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { Failure } from "./envelope";
import { sameResource, verifyPassword, type OwnerPassword } from "./remote-config";
import { ensureStateDir, writePrivateJson } from "./session";

export { hashPassword, verifyPassword } from "./remote-config";

export const ACCESS_TTL = 60 * 60; // 1 hour
export const REFRESH_TTL = 90 * 24 * 60 * 60; // 90 days, renewed by rotation
export const CODE_TTL = 10 * 60;
const LOGIN_TTL = 30 * 60; // an open sign-in page
const DONE_TTL = 30 * 60; // a used sign-in page, so a re-submit gets a calm answer
const LOCK_WINDOW = 15 * 60;
const LOCK_AFTER = 5; // failures per address in LOCK_WINDOW
const GLOBAL_WINDOW = 60 * 60;
const GLOBAL_LOCK_AFTER = 20; // failures from every address together in GLOBAL_WINDOW
const MAX_CLIENTS = 50;
const STALE_CLIENT = 60 * 60; // a registration that never signed in, pruned after an hour
const MAX_PENDING = 200; // open sign-in pages kept in memory
const MAX_TRACKED = 10_000; // addresses with recent failures kept in memory

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

// --- store: one JSON file, 0600, written atomically ---

type Code = { client_id: string; grant: string; code_challenge: string; redirect_uri: string; resource: string; scopes: string[]; expires: number };
type Token = { kind: "access" | "refresh"; client_id: string; grant: string; scopes: string[]; resource: string; expires: number };

export type OAuthData = {
  version: 1;
  /** Per-instance random salt for the password fingerprint. */
  salt: string;
  /** HMAC of the Owner password's variable under `salt`: when it changes, every client is signed out. */
  fingerprint?: string;
  clients: Record<string, OAuthClientInformationFull>;
  /** Keyed by the SHA-256 of the code; the code itself is never stored. */
  codes: Record<string, Code>;
  /** Keyed by the SHA-256 of the token. */
  tokens: Record<string, Token>;
  /** Refresh tokens already rotated away, by SHA-256: presenting one again revokes its grant. */
  rotated: Record<string, { client_id: string; grant: string; expires: number }>;
  /** When each client first signed in: such a client stays registered after a sign-out (it reconnects with its id). */
  seen: Record<string, number>;
};

export class OAuthStore {
  readonly file: string;
  data: OAuthData;

  constructor(dir: string) {
    this.file = join(ensureStateDir(dir), "oauth.json");
    if (existsSync(this.file)) {
      try {
        this.data = JSON.parse(readFileSync(this.file, "utf8")) as OAuthData;
      } catch {
        throw new Failure("input", `${this.file} is not valid JSON, so the server cannot read its sign-ins`, {
          next: `Move ${this.file} away and start the server again; every client then signs in again.`,
        });
      }
    } else {
      this.data = { version: 1, salt: secret(), clients: {}, codes: {}, tokens: {}, rotated: {}, seen: {} };
      this.save();
    }
    this.data.rotated ??= {};
    this.data.seen ??= {};
  }

  update<T>(fn: (d: OAuthData) => T): T {
    const result = fn(this.data);
    this.save();
    return result;
  }

  private save() {
    writePrivateJson(this.file, this.data);
  }
}

// --- sign-in pages: self-contained, no external assets ---

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** `style`: extra CSS appended after the base rules, so it wins over them. */
export function page(title: string, body: string, head = "", style = ""): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>${head}
<style>
:root{--bg:#f4f4f2;--card:#fff;--ink:#16181d;--muted:#666a73;--line:#e3e4e8;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--card:#1b1e23;--ink:#eef0f3;--muted:#9aa0aa;--line:#2c3038;--err:#ff8a7a}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:460px;margin:0 auto;padding:10vh 20px 48px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:26px}
h1{font-size:24px;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--muted)}.error{color:var(--err)}
label{display:block;font-weight:600;font-size:14px;margin:16px 0 6px}input{width:100%;font:inherit;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)}
button{width:100%;margin-top:14px;font:inherit;font-weight:700;padding:12px 16px;border:0;border-radius:10px;background:var(--ink);color:var(--bg);cursor:pointer}
input:focus,button:focus{outline:2px solid var(--ink);outline-offset:2px}${style}
</style><body><div class="wrap"><div class="card"><h1>${esc(title)}</h1>${body}</div></div></body></html>`;
}

export type SignInPage = { requestId: string; clientName?: string; returnTo: string; loopback: boolean; siteName: string; serverName: string; writes: boolean; error?: string };

export function signInPage(o: SignInPage): string {
  const who = o.clientName ? `<b>${esc(o.clientName)}</b>` : "An app";
  const can = o.writes ? "It can run all of its tools there, including ones that change your data after you confirm them." : "Its tools there only read your data.";
  const back = o.loopback
    ? `<p class="muted">After signing in you are sent back to a program on this computer (<b>${esc(o.returnTo)}</b>). Stop if you did not just start a sign-in there.</p>`
    : `<p class="muted">After signing in you are sent back to <b>${esc(o.returnTo)}</b>. Stop if that is not where you came from.</p>`;
  return page(
    "Allow access?",
    `<p>${who} wants to use <b>${esc(o.serverName)}</b> on <b>${esc(o.siteName)}</b> as you. ${can}</p>${back}
     ${o.error ? `<p class="error">${esc(o.error)}</p>` : ""}
     <form method="post" action="/login">
       <input type="hidden" name="request" value="${esc(o.requestId)}">
       <label for="pw">The Owner password set on this server</label>
       <input id="pw" type="password" name="password" autofocus autocomplete="current-password" required>
       <button type="submit">Allow access</button>
     </form>
     <p class="muted">Forgot it? Set a new OWNER_PASSWORD on the host and restart the server; that signs every client out.</p>`,
  );
}

export function returningPage(url: string): string {
  const host = new URL(url).host;
  return page("Signed in", `<p>Taking you back to <b>${esc(host)}</b>.</p><p class="muted">If nothing happens, <a href="${esc(url)}">continue to ${esc(host)}</a>.</p>`, `<meta http-equiv="refresh" content="0;url=${esc(url)}">`);
}

export const signedInPage = () => page("Signed in", `<p>This sign-in already went through. You can close this tab.</p>`);
export const failedPage = (message: string) => page("Not signed in", `<p class="error">${esc(message)}</p><p class="muted">Go back to your assistant and connect again.</p>`);

// --- the provider ---

export type LoginEvent = { ok: boolean; ip: string; clientName?: string; reason?: string };

export type OwnerProviderOptions = {
  store: OAuthStore;
  password: OwnerPassword;
  /** This server's MCP endpoint: the only resource tokens are issued for. */
  mcpUrl: URL;
  siteName: string;
  serverName: string;
  /** Whether any tool writes (the sign-in page says so, or that the tools only read). */
  writes?: boolean;
  allowRedirect: (uri: string) => boolean;
  /** Seconds since the epoch; tests move it. */
  now?: () => number;
  onEvent?: (message: string) => void;
};

type Pending = { client: OAuthClientInformationFull; params: AuthorizationParams; expires: number; attempts: number };
export type LoginResult = { redirect: string } | { done: true } | { error: string; requestId?: string };

export class OwnerProvider implements OAuthServerProvider {
  private pending = new Map<string, Pending>();
  private completed = new Map<string, number>();
  private failures = new Map<string, number[]>();
  private allFailures: number[] = [];
  private readonly o: OwnerProviderOptions;
  private readonly now: () => number;

  constructor(options: OwnerProviderOptions) {
    this.o = options;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private get store() { return this.o.store; }
  private event(message: string) { this.o.onEvent?.(message); }

  /** Signs every client out: every token, code and open sign-in is dropped. Clients that signed in stay registered. */
  revokeAll(): void {
    this.pending.clear();
    this.completed.clear();
    this.store.update((d) => {
      d.tokens = {};
      d.codes = {};
      d.rotated = {};
    });
  }

  /** Remembers the Owner password's fingerprint; a changed password signs every client out. True when it did. */
  rememberPassword(): boolean {
    const value = this.o.password.hash ?? this.o.password.plain ?? "";
    const fingerprint = createHmac("sha256", this.store.data.salt).update(value).digest("hex");
    const changed = this.store.data.fingerprint !== undefined && this.store.data.fingerprint !== fingerprint;
    if (changed) this.revokeAll();
    if (this.store.data.fingerprint !== fingerprint) this.store.update((d) => void (d.fingerprint = fingerprint));
    return changed;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.store.data.clients[clientId],
      registerClient: (client) => {
        for (const uri of client.redirect_uris) {
          if (!this.o.allowRedirect(String(uri))) throw new InvalidClientMetadataError(`redirect_uri not allowed: ${String(uri)}. Only claude.ai's callback and loopback are allowed; EXTRA_REDIRECT_URIS on the server adds more.`);
        }
        // The SDK's handler has already made the id (and a secret for a confidential client).
        const full = client as OAuthClientInformationFull;
        full.client_id ??= randomBytes(16).toString("hex");
        full.client_id_issued_at ??= this.now();
        return this.store.update((d) => {
          this.prune(d);
          const live = this.liveClients(d);
          const ids = Object.keys(d.clients).sort((a, b) => (d.clients[a]!.client_id_issued_at ?? 0) - (d.clients[b]!.client_id_issued_at ?? 0));
          for (const id of ids) {
            if (Object.keys(d.clients).length < MAX_CLIENTS) break;
            if (!live.has(id)) this.dropClient(d, id);
          }
          if (Object.keys(d.clients).length >= MAX_CLIENTS) {
            throw new InvalidClientMetadataError("Too many clients are registered and signed in. Sign every client out on the Setup page, then connect again.");
          }
          d.clients[full.client_id] = full;
          return full;
        });
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep();
    if (params.resource && !sameResource(params.resource.href, this.o.mcpUrl.href)) {
      res.status(400).type("html").send(failedPage(`This server only grants access to ${this.o.mcpUrl.href}, not to ${params.resource.href}.`));
      return;
    }
    // Checked again here, not only at registration: a saved client keeps no redirect the allowlist has dropped.
    if (!this.o.allowRedirect(params.redirectUri)) {
      res.status(400).type("html").send(failedPage(`This server no longer sends sign-ins back to ${new URL(params.redirectUri).host}.`));
      return;
    }
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const id = secret();
    this.pending.set(id, { client, params, expires: this.now() + LOGIN_TTL, attempts: 0 });
    res.status(200).type("html").send(this.signInPageFor(id)!);
  }

  /** The sign-in page of an open request, with an error after a wrong password; null when it is gone. */
  signInPageFor(requestId: string, error?: string): string | null {
    const p = this.pending.get(requestId);
    if (!p) return null;
    const back = new URL(p.params.redirectUri);
    return signInPage({
      requestId,
      clientName: p.client.client_name,
      returnTo: back.host,
      loopback: back.protocol === "http:",
      siteName: this.o.siteName,
      serverName: this.o.serverName,
      writes: this.o.writes ?? true,
      error,
    });
  }

  /**
   * An address is locked after LOCK_AFTER failures in LOCK_WINDOW. Past the global cap, any address
   * that has failed even once is locked too (slowing guesses spread over many addresses), but an
   * address that never failed, the Owner's, is not: failures elsewhere cannot lock the Owner out.
   */
  private locked(ip: string): boolean {
    const t = this.now();
    const mine = (this.failures.get(ip) ?? []).filter((at) => at > t - LOCK_WINDOW);
    if (mine.length) this.failures.set(ip, mine);
    else this.failures.delete(ip);
    this.allFailures = this.allFailures.filter((at) => at > t - GLOBAL_WINDOW);
    return mine.length >= LOCK_AFTER || (mine.length > 0 && this.allFailures.length >= GLOBAL_LOCK_AFTER);
  }

  private recordFailure(ip: string) {
    const t = this.now();
    if (!this.failures.has(ip) && this.failures.size >= MAX_TRACKED) this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(ip, [...(this.failures.get(ip) ?? []), t]);
    this.allFailures.push(t);
  }

  /** The Owner password for a Setup page action, under the same lockout as the sign-in page. */
  checkOwnerPassword(password: string, ip: string): { ok: true } | { error: string } {
    if (this.locked(ip)) {
      this.event(`Setup page refused from ${ip}: locked out`);
      return { error: "Too many attempts. Try again in a few minutes." };
    }
    if (!verifyPassword(this.o.password, password)) {
      this.recordFailure(ip);
      this.event(`failed Setup page password from ${ip}`);
      return { error: "Wrong password." };
    }
    this.failures.delete(ip);
    return { ok: true };
  }

  /** POST /login: the password for an open sign-in page. */
  completeLogin(requestId: string, password: string, ip: string): LoginResult {
    this.sweep();
    if (this.locked(ip)) {
      this.event(`sign-in refused from ${ip}: locked out`);
      return { error: "Too many attempts. Try again in a few minutes." };
    }
    const pending = this.pending.get(requestId);
    if (!pending && this.completed.has(requestId)) return { done: true };
    if (!pending) return { error: "This sign-in page has expired or the server restarted. Go back to your assistant, connect again, and enter the password within 30 minutes." };
    const who = pending.client.client_name ? ` for ${pending.client.client_name}` : "";

    if (!verifyPassword(this.o.password, password)) {
      pending.attempts += 1;
      this.recordFailure(ip);
      if (pending.attempts >= LOCK_AFTER) this.pending.delete(requestId);
      this.event(`failed sign-in from ${ip}${who} (wrong password)`);
      return { error: "Wrong password.", requestId: pending.attempts < LOCK_AFTER ? requestId : undefined };
    }

    this.pending.delete(requestId);
    this.completed.set(requestId, this.now() + DONE_TTL);
    this.failures.delete(ip);
    this.event(`sign-in from ${ip}${who}`);
    const code = secret();
    this.store.update((d) => {
      this.prune(d);
      d.seen[pending.client.client_id] ??= this.now();
      d.codes[sha256(code)] = {
        client_id: pending.client.client_id,
        grant: secret(),
        code_challenge: pending.params.codeChallenge,
        redirect_uri: pending.params.redirectUri,
        resource: this.o.mcpUrl.href,
        scopes: pending.params.scopes ?? [],
        expires: this.now() + CODE_TTL,
      };
    });
    const url = new URL(pending.params.redirectUri);
    url.searchParams.set("code", code);
    if (pending.params.state) url.searchParams.set("state", pending.params.state);
    return { redirect: url.href };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const c = this.store.data.codes[sha256(authorizationCode)];
    if (!c || c.client_id !== client.client_id || c.expires < this.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return c.code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const key = sha256(authorizationCode);
    const c = this.store.data.codes[key];
    if (!c || c.client_id !== client.client_id || c.expires < this.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== c.redirect_uri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    if (resource && !sameResource(resource.href, c.resource)) throw new InvalidGrantError("resource does not match the authorization request");
    return this.store.update((d) => {
      delete d.codes[key];
      return this.issue(d, client.client_id, c.grant, c.scopes, c.resource);
    });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const key = sha256(refreshToken);
    const t = this.store.data.tokens[key];
    if (!t) {
      const used = this.store.data.rotated[key];
      if (used && used.client_id === client.client_id) {
        // A refresh token presented twice: one of the two holders is not the client. Sign it out.
        this.store.update((d) => this.revokeGrant(d, used.grant));
        this.event(`a used refresh token came back for ${client.client_name ?? client.client_id}; that client was signed out`);
        throw new InvalidGrantError("This refresh token was already used; the client was signed out. Connect again.");
      }
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (t.kind !== "refresh" || t.client_id !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    if (t.expires < this.now()) throw new InvalidGrantError("Refresh token expired");
    if (resource && !sameResource(resource.href, t.resource)) throw new InvalidGrantError("resource does not match");
    // A refresh may narrow the granted scopes, never widen them (RFC 6749 §6).
    if (scopes?.some((s) => !t.scopes.includes(s))) throw new InvalidScopeError("A refresh cannot ask for scopes the sign-in did not grant");
    return this.store.update((d) => {
      this.revokeGrant(d, t.grant);
      d.rotated[key] = { client_id: t.client_id, grant: t.grant, expires: t.expires };
      return this.issue(d, client.client_id, t.grant, scopes?.length ? scopes : t.scopes, t.resource);
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = this.store.data.tokens[sha256(token)];
    if (!t || t.kind !== "access") throw new InvalidTokenError("Invalid access token");
    if (t.expires < this.now()) throw new InvalidTokenError("Access token expired");
    return { token, clientId: t.client_id, scopes: t.scopes, expiresAt: t.expires, resource: new URL(t.resource) };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const t = this.store.data.tokens[sha256(request.token)];
    if (t && t.client_id === client.client_id) this.store.update((d) => this.revokeGrant(d, t.grant));
  }

  /** Drops both tokens of a grant (a revoke or a rotation). */
  private revokeGrant(d: OAuthData, grant: string) {
    for (const [k, v] of Object.entries(d.tokens)) if (v.grant === grant) delete d.tokens[k];
  }

  private issue(d: OAuthData, clientId: string, grant: string, scopes: string[], resource: string): OAuthTokens {
    this.prune(d);
    const access = secret();
    const refresh = secret();
    d.tokens[sha256(access)] = { kind: "access", client_id: clientId, grant, scopes, resource, expires: this.now() + ACCESS_TTL };
    d.tokens[sha256(refresh)] = { kind: "refresh", client_id: clientId, grant, scopes, resource, expires: this.now() + REFRESH_TTL };
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(" ") || undefined };
  }

  /**
   * Client ids that hold a live token or code: only those are safe from eviction. An open sign-in
   * page does not count, since anyone can open one without the password.
   */
  private liveClients(d: OAuthData): Set<string> {
    const t = this.now();
    const live = new Set<string>();
    for (const v of Object.values(d.tokens)) if (v.expires >= t) live.add(v.client_id);
    for (const v of Object.values(d.codes)) if (v.expires >= t) live.add(v.client_id);
    return live;
  }

  private dropClient(d: OAuthData, id: string) {
    delete d.clients[id];
    delete d.seen[id];
    for (const [k, p] of this.pending) if (p.client.client_id === id) this.pending.delete(k);
  }

  /** Drops what has expired, and registrations that never signed in, an hour after they registered. */
  private prune(d: OAuthData) {
    const t = this.now();
    for (const [k, v] of Object.entries(d.tokens)) if (v.expires < t) delete d.tokens[k];
    for (const [k, v] of Object.entries(d.codes)) if (v.expires < t) delete d.codes[k];
    for (const [k, v] of Object.entries(d.rotated)) if (v.expires < t) delete d.rotated[k];
    const live = this.liveClients(d);
    for (const [id, c] of Object.entries(d.clients)) {
      if (!live.has(id) && d.seen[id] === undefined && (c.client_id_issued_at ?? 0) < t - STALE_CLIENT) this.dropClient(d, id);
    }
  }

  private sweep() {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expires < t) this.pending.delete(k);
    for (const [k, v] of this.completed) if (v < t) this.completed.delete(k);
  }
}
