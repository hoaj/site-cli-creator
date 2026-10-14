// Drives a running spike server end to end: discovery -> 401 without token -> DCR ->
// /authorize (PKCE) -> /token -> initialize, tools/list, tools/call over Streamable HTTP.
// Usage: bun smoke.ts [baseUrl]   (exits non-zero on the first failed check)
import { createHash, randomBytes } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:8787";
const check = (ok: unknown, msg: string) => {
  if (!ok) {
    console.error(`FAIL ${msg}`);
    process.exit(1);
  }
  console.log(`ok   ${msg}`);
};

const as = await fetch(`${base}/.well-known/oauth-authorization-server`);
const meta = (await as.json()) as Record<string, string>;
check(as.status === 200 && meta.token_endpoint, `AS metadata ${as.status} token_endpoint=${meta.token_endpoint}`);
const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
check(prm.status === 200, `protected-resource metadata ${prm.status} ${JSON.stringify(await prm.json())}`);

const anon = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check(anon.status === 401 && anon.headers.get("www-authenticate"), `unauthenticated /mcp -> ${anon.status} ${anon.headers.get("www-authenticate")}`);

const redirect = "http://localhost:9999/cb";
const reg = await fetch(meta.registration_endpoint!, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "smoke", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
});
const client = (await reg.json()) as { client_id: string };
check(reg.status === 201 && client.client_id, `DCR ${reg.status} client_id=${client.client_id}`);

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authUrl = new URL(meta.authorization_endpoint!);
for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s1" }))
  authUrl.searchParams.set(k, v);
const auth = await fetch(authUrl, { redirect: "manual" });
const loc = new URL(auth.headers.get("location") ?? "http://x/");
check(auth.status === 302 && loc.searchParams.get("code"), `/authorize ${auth.status} -> code`);

const tokRes = await fetch(meta.token_endpoint!, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect }),
});
const tokens = (await tokRes.json()) as { access_token: string };
check(tokRes.status === 200 && tokens.access_token, `/token ${tokRes.status} (PKCE verified)`);

const rpc = async (id: number, method: string, params: unknown) => {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens.access_token}`, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: r.status, body: (await r.json()) as { result?: any; error?: any } };
};
const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
check(init.status === 200 && init.body.result?.serverInfo?.name === "spike", `initialize -> ${JSON.stringify(init.body.result?.serverInfo)} protocol ${init.body.result?.protocolVersion}`);
const list = await rpc(2, "tools/list", {});
check(list.body.result?.tools?.[0]?.name === "echo", `tools/list -> ${JSON.stringify(list.body.result?.tools?.map((t: any) => t.name))}`);
const call = await rpc(3, "tools/call", { name: "echo", arguments: { text: "hi" } });
check(call.body.result?.content?.[0]?.text === "echo: hi", `tools/call -> ${call.body.result?.content?.[0]?.text}`);
console.log("ALL OK");
