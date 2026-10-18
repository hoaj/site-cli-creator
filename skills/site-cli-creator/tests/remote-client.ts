// A small client for remote mode (`mcp --http`) used by the generator's e2e test: the Owner's
// Server sign-in (OAuth 2.1 with PKCE), tool calls through /mcp and the Setup page's upload. It
// is the generator's own test code and never ships to a plugin (not under starter/). The sign-in's
// building blocks (pkce, register, authorizePage, postLogin, token, freePort) are the Starter's
// own test helpers; only what the e2e needs on top lives here.

import { CLAUDE_CB, authorizePage, pkce, postLogin, register, token } from "../starter/skill/cli/tests/helpers";

export function codeOf(html: string): string {
  const raw = html.match(/http-equiv="refresh" content="0;url=([^"]+)"/)?.[1];
  if (!raw) throw new Error(`no redirect in sign-in answer:\n${html}`);
  const code = new URL(raw.replaceAll("&amp;", "&")).searchParams.get("code");
  if (!code) throw new Error("the sign-in redirect has no code");
  return code;
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
