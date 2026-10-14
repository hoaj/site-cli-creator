// What `mcp --http` (remote mode) reads from its environment, checked before anything listens.
// No dependencies, so run() can validate it without loading the SDK or Express (runtime/remote.ts).
import { Failure } from "./envelope";
import type { Env } from "./site";

/** The Owner's password, as one of the two variables the host sets. */
export type OwnerPassword = { hash?: string; plain?: string };

export type RemoteConfig = {
  port: number;
  /** The address clients use: the OAuth issuer, and `<publicUrl>/mcp` is the resource. */
  publicUrl: URL;
  password: OwnerPassword;
  /** Redirect URIs allowed besides claude.ai's callback and loopback, exact matches. */
  extraRedirects: string[];
};

export const MIN_PASSWORD_LENGTH = 12;
const SCRYPT_HASH = /^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const input = (message: string) => new Failure("input", message);

/** The remote-mode settings from the host's environment, or an input Failure naming what is missing. */
export function remoteConfig(env: Env, flags: { port?: number }): RemoteConfig {
  const password: OwnerPassword = {};
  if (env.OWNER_PASSWORD_HASH) {
    if (!SCRYPT_HASH.test(env.OWNER_PASSWORD_HASH)) throw input("OWNER_PASSWORD_HASH is not a scrypt hash (scrypt$<salt>$<hash>); set OWNER_PASSWORD instead, or make the hash again");
    password.hash = env.OWNER_PASSWORD_HASH;
  } else if (env.OWNER_PASSWORD) {
    if (env.OWNER_PASSWORD.length < MIN_PASSWORD_LENGTH) throw input(`OWNER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
    password.plain = env.OWNER_PASSWORD;
  } else {
    throw input("remote mode needs the Owner's password: set OWNER_PASSWORD (at least 12 characters) or OWNER_PASSWORD_HASH on the host");
  }

  const raw = env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "");
  if (!raw) throw input("remote mode needs its public address: set PUBLIC_URL (for example https://logbuy.example.com); on Railway, generate a domain");
  let publicUrl: URL;
  try {
    publicUrl = new URL(raw);
  } catch {
    throw input(`PUBLIC_URL is not a URL: ${raw}`);
  }
  if (publicUrl.protocol !== "https:" && !(publicUrl.protocol === "http:" && LOOPBACK.has(publicUrl.hostname))) {
    throw input("PUBLIC_URL must be https (plain http only on localhost)");
  }
  publicUrl = new URL(publicUrl.origin + "/");

  let port = flags.port;
  if (port === undefined) {
    if (env.PORT !== undefined && env.PORT !== "" && !/^\d+$/.test(env.PORT)) throw input(`PORT is not a number: ${env.PORT}`);
    port = env.PORT ? Number(env.PORT) : 8080;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw input(`the port must be 1-65535, not ${port}`);

  const extraRedirects = (env.EXTRA_REDIRECT_URIS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const uri of extraRedirects) {
    try {
      new URL(uri);
    } catch {
      throw input(`EXTRA_REDIRECT_URIS holds something that is not a URL: ${uri}`);
    }
  }
  return { port, publicUrl, password, extraRedirects };
}

/** Whether an OAuth client may be sent back to `uri`: claude.ai's callback, loopback on any port, or an extra one. */
export function redirectAllowed(uri: string, extra: string[] = []): boolean {
  if (uri === "https://claude.ai/api/mcp/auth_callback" || extra.includes(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}
