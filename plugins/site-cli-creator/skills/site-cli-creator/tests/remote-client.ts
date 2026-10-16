// A small client for remote mode (`mcp --http`) used by the generator's e2e test: the Owner's
// Server sign-in (OAuth 2.1 with PKCE), tool calls through /mcp and the Setup page's upload. It
// is the generator's own test code and never ships to a plugin (not under starter/); the same
// helpers live in starter/skill/cli/tests/remote.test.ts and setup.test.ts, copied on purpose.

import { createHash, randomBytes } from "node:crypto";

export const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

export function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function register(base: string, redirect = CLAUDE_CB) {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: "Claude", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
}

export function authorizePage(base: string, clientId: string, challenge: string, redirect = CLAUDE_CB) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    resource: `${base}/mcp`,
  });
  return fetch(`${base}/authorize?${q}`, { redirect: "manual" });
}

export function postLogin(base: string, requestId: string, password: string) {
  return fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: requestId, password }) });
}

export function codeOf(html: string): string {
  const raw = html.match(/http-equiv="refresh" content="0;url=([^"]+)"/)?.[1];
  if (!raw) throw new Error(`no redirect in sign-in answer:\n${html}`);
  const code = new URL(raw.replaceAll("&amp;", "&")).searchParams.get("code");
  if (!code) throw new Error("the sign-in redirect has no code");
  return code;
}

export function token(base: string, body: Record<string, string>) {
  return fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
}

/** The whole Server sign-in, as a client like claude.ai does it. Returns the access token. */
export async function signIn(base: string, password: string): Promise<string> {
  const client = await (await register(base)).json();
  const { verifier, challenge } = pkce();
  const page = await (await authorizePage(base, client.client_id, challenge)).text();
  const requestId = page.match(/name="request" value="([^"]+)"/)?.[1];
  if (!requestId) throw new Error(`no sign-in form:\n${page}`);
  const code = codeOf(await (await postLogin(base, requestId, password)).text());
  const res = await token(base, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CLAUDE_CB, resource: `${base}/mcp` });
  if (res.status !== 200) throw new Error(`/token answered ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token as string;
}

let rpcId = 1;

/** One JSON-RPC call to /mcp; the body is returned as text too, for the leak check. */
export async function mcpCall(base: string, accessToken: string, method: string, params?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, ...(params !== undefined && { params }) }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

/** Uploads a Session as text on the Setup page. */
export async function upload(base: string, password: string, text: string): Promise<{ status: number; text: string }> {
  const form = new FormData();
  form.set("password", password);
  form.set("session_text", text);
  const res = await fetch(`${base}/setup/session`, { method: "POST", body: form });
  return { status: res.status, text: await res.text() };
}

/** A Setup page action that takes only the password: "delete" or "signout". */
export async function setupAction(base: string, path: "delete" | "signout", password: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/setup/${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }) });
  return { status: res.status, text: await res.text() };
}
