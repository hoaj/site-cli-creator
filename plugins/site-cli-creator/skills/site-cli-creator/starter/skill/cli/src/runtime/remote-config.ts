// What `mcp --http` (remote mode) reads from its environment, checked before anything listens,
// and the Owner password's hash and check. No dependencies beyond node:crypto, so run() can use
// it without loading the SDK or Express (runtime/remote.ts).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
  /** Proxy hops in front whose X-Forwarded-For is trusted for the client's address (lockout, rate limits). */
  trustProxy: number;
};

export const MIN_PASSWORD_LENGTH = 12;
const SCRYPT_HASH = /^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** A scrypt hash for OWNER_PASSWORD_HASH (`<skill> mcp --hash-password` prints one): `scrypt$<salt>$<hash>`, base64. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  return `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, KEY_BYTES).toString("base64")}`;
}

export function verifyPassword(owner: OwnerPassword, attempt: string): boolean {
  if (owner.hash) {
    const [, salt, expected] = owner.hash.split("$");
    if (!salt || !expected) return false;
    const actual = scryptSync(attempt, Buffer.from(salt, "base64"), KEY_BYTES);
    const exp = Buffer.from(expected, "base64");
    return actual.length === exp.length && timingSafeEqual(actual, exp);
  }
  if (owner.plain === undefined) return false;
  // Compare digests, so neither the content nor the length of the password leaks through timing.
  return timingSafeEqual(createHash("sha256").update(attempt).digest(), createHash("sha256").update(owner.plain).digest());
}

/** Whether a hash has the shape hashPassword() makes (salt and key length), so verifyPassword can match it. */
function ownHash(hash: string): boolean {
  const [, salt, key] = hash.split("$");
  return SCRYPT_HASH.test(hash) && Buffer.from(salt!, "base64").length >= SALT_BYTES && Buffer.from(key!, "base64").length === KEY_BYTES;
}
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A missing or wrong host setting: `next` says to fix the environment, not the command's flags. */
const input = (message: string) =>
  new Failure("input", message, { next: "Set the environment variable the message names on the host, then start `mcp --http` again." });

/** The remote-mode settings from the host's environment, or an input Failure naming what is missing. */
export function remoteConfig(env: Env, flags: { port?: number }): RemoteConfig {
  const password: OwnerPassword = {};
  if (env.OWNER_PASSWORD_HASH) {
    if (!ownHash(env.OWNER_PASSWORD_HASH)) throw input("OWNER_PASSWORD_HASH is not a hash this server can check; make it with `<skill> mcp --hash-password` (the password on stdin), or set OWNER_PASSWORD instead");
    password.hash = env.OWNER_PASSWORD_HASH;
  } else if (env.OWNER_PASSWORD) {
    if (env.OWNER_PASSWORD.length < MIN_PASSWORD_LENGTH) throw input(`OWNER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
    password.plain = env.OWNER_PASSWORD;
  } else {
    throw input("remote mode needs the Owner's password: set OWNER_PASSWORD (at least 12 characters) or OWNER_PASSWORD_HASH on the host");
  }

  const raw = env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "");
  if (!raw) throw input("remote mode needs the public address clients use: set PUBLIC_URL (for example https://mcp.example.com); on Railway, a generated domain (RAILWAY_PUBLIC_DOMAIN) is used when PUBLIC_URL is not set");
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
  // Behind the host's TLS proxy (https) trust one hop; on loopback http there is no proxy to trust.
  let trustProxy = publicUrl.protocol === "https:" ? 1 : 0;
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== "") {
    if (!/^\d+$/.test(env.TRUST_PROXY)) throw input(`TRUST_PROXY must be the number of proxies in front (0, 1, 2 …), not ${env.TRUST_PROXY}`);
    trustProxy = Number(env.TRUST_PROXY);
  }
  return { port, publicUrl, password, extraRedirects, trustProxy };
}

/** Whether two resource URLs name the same resource, ignoring a trailing slash (as the SDK's bearer check does). */
export function sameResource(a: string, b: string): boolean {
  try {
    const norm = (s: string) => {
      const u = new URL(s);
      return `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    };
    return norm(a) === norm(b);
  } catch {
    return false;
  }
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
