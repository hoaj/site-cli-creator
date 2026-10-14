// Spike: remote-mode shape on today's deps plus @modelcontextprotocol/sdk + Express 5.
//   main pw      -> proves playwright-core still resolves its registry inside the binary
//   main serve   -> Express app: mcpAuthRouter (stub one-user provider) + bearer-guarded
//                   stateless Streamable HTTP at /mcp with one zod-typed tool (as BankMCP does)
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { chromium } from "playwright-core";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Response } from "express";

const tok = () => randomBytes(24).toString("base64url");

// Stub one-user provider: auto-approves /authorize (no password page), in-memory everything.
class StubProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private codes = new Map<string, { clientId: string; params: AuthorizationParams }>();
  private access = new Map<string, AuthInfo>();
  clientsStore: OAuthRegisteredClientsStore = {
    getClient: (id) => this.clients.get(id),
    registerClient: (c) => {
      const full = { ...c, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
      this.clients.set(full.client_id, full);
      return full;
    },
  };
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const code = tok();
    this.codes.set(code, { clientId: client.client_id, params });
    const u = new URL(params.redirectUri);
    u.searchParams.set("code", code);
    if (params.state) u.searchParams.set("state", params.state);
    res.redirect(302, u.href);
  }
  async challengeForAuthorizationCode(_c: OAuthClientInformationFull, code: string) {
    const entry = this.codes.get(code);
    if (!entry) throw new InvalidGrantError("unknown code");
    return entry.params.codeChallenge;
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<OAuthTokens> {
    const entry = this.codes.get(code);
    if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("bad code");
    this.codes.delete(code);
    const access_token = tok();
    this.access.set(access_token, { token: access_token, clientId: client.client_id, scopes: ["spike"], expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    return { access_token, token_type: "bearer", expires_in: 3600, refresh_token: tok() };
  }
  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new InvalidGrantError("not in spike");
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = this.access.get(token);
    if (!info) throw new InvalidGrantError("bad token");
    return info;
  }
}

function createServer() {
  const server = new McpServer({ name: "spike", version: "0.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo text back", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  return server;
}

function serve(port: number) {
  const baseUrl = new URL(process.env.BASE_URL ?? `http://localhost:${port}`);
  const mcpUrl = new URL("/mcp", baseUrl);
  const provider = new StubProvider();
  const app = express();
  app.use(mcpAuthRouter({ provider, issuerUrl: baseUrl, resourceServerUrl: mcpUrl, resourceName: "spike", scopesSupported: ["spike"] }));
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.listen(port, () => console.log(`spike listening on ${baseUrl.href}`));
}

const [cmd = "serve", portArg = "8787"] = process.argv.slice(2);
if (cmd === "pw") console.log(`playwright-core ok: chromium path ${chromium.executablePath()}`);
else if (cmd === "serve") serve(Number(portArg));
else {
  console.error("usage: main pw | main serve [port]");
  process.exit(2);
}
