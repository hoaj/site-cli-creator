// Remote mode (`mcp --http`): the same tools as local mode, over the MCP SDK's Streamable HTTP
// transport, behind the Owner's Server sign-in (owner-auth.ts on the SDK's OAuth router).
// main.ts imports this module only for `--http`, so local mode never loads the SDK or Express.
import express from "express";
import type { Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { inputSchema, toolResult, type McpTool, type ServerInfo } from "./mcp";
import { OAuthStore, OwnerProvider, failedPage, returningPage, signedInPage } from "./owner-auth";
import { redirectAllowed, type RemoteConfig } from "./remote-config";
import type { Site } from "./site";

export type ServeOptions = {
  info: ServerInfo;
  tools: McpTool[];
  site: Site;
  config: RemoteConfig;
  /** The CLI skill's state dir: oauth.json lives there (a volume on the host). */
  dir: string;
  /** Interface to listen on; all of them by default, as a container needs. */
  host?: string;
  note: (message: string) => void;
  now?: () => number;
};

export type RemoteServer = { url: string; store: OAuthStore; close(): Promise<void> };

/** Origins a browser-borne request to /mcp may come from; a request without Origin is served. */
const CLIENT_ORIGINS = ["https://claude.ai"];

/** The tools as an SDK low-level Server: list and call go to the same McpTool list as local mode. */
function mcpServerFor(info: ServerInfo, tools: McpTool[], serial: <T>(fn: () => Promise<T>) => Promise<T>) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const server = new Server({ name: info.name, version: info.version }, { capabilities: { tools: { listChanged: false } }, instructions: info.instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.schema) as never, annotations: t.annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${req.params.name}`);
    // One call at a time, as over stdio, so two calls never refresh one Session together.
    const { output, code } = await serial(() => tool.call((req.params.arguments ?? {}) as Record<string, unknown>));
    return toolResult(output, code) as never;
  });
  return server;
}

export async function serveHttp(o: ServeOptions): Promise<RemoteServer> {
  const { config, note } = o;
  const base = config.publicUrl;
  const mcpUrl = new URL("/mcp", base);
  const store = new OAuthStore(o.dir);
  const provider = new OwnerProvider({
    store,
    password: config.password,
    mcpUrl,
    siteName: new URL(o.site.origin).host,
    serverName: o.info.name,
    // A tool with a confirm argument writes (the same rule the server instructions give clients).
    writes: o.tools.some((t) => "confirm" in t.schema.shape),
    allowRedirect: (uri) => redirectAllowed(uri, config.extraRedirects),
    now: o.now,
    onEvent: note,
  });
  if (provider.rememberPassword()) note("the Owner password changed: every client was signed out");

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  const app = express();
  app.set("trust proxy", 1); // behind the host's proxy, req.ip is the client (rate limits, lockout)
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...(base.protocol === "https:" && { "Strict-Transport-Security": "max-age=31536000" }),
    });
    next();
  });

  app.get("/healthz", (_req, res) => void res.json({ ok: true, version: o.info.version }));

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: base,
    resourceServerUrl: mcpUrl,
    resourceName: o.info.name,
    scopesSupported: [o.info.name],
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));

  app.post("/login", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
    res.set("Cache-Control", "no-store");
    const { request, password } = req.body as Record<string, string | undefined>;
    const result = provider.completeLogin(String(request ?? ""), String(password ?? ""), req.ip ?? "unknown");
    // A page that forwards at once rather than a redirect: the form leaves the screen, so a second
    // press cannot post it again, and Chrome applies form-action to redirects after a form post.
    if ("redirect" in result) return void res.status(200).type("html").send(returningPage(result.redirect));
    if ("done" in result) return void res.status(200).type("html").send(signedInPage());
    const again = result.requestId ? provider.signInPageFor(result.requestId, result.error) : null;
    if (again) return void res.status(401).type("html").send(again);
    res.status(400).type("html").send(failedPage(result.error));
  });

  const allowedOrigins = new Set([base.origin, ...CLIENT_ORIGINS]);
  const origin: express.RequestHandler = (req, res, next) => {
    const from = req.headers.origin;
    if (from && !allowedOrigins.has(from)) return void res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: `Origin not allowed: ${from}` }, id: null });
    next();
  };
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl), expectedResource: mcpUrl });

  app.post("/mcp", origin, bearer, express.json({ limit: "1mb" }), async (req, res) => {
    const server = mcpServerFor(o.info, o.tools, serial);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      note("an MCP request failed inside the server");
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  const stateless: express.RequestHandler = (_req, res) => void res.status(405).set("Allow", "POST").json({ error: "This server is stateless; use POST." });
  app.get("/mcp", origin, bearer, stateless);
  app.delete("/mcp", origin, bearer, stateless);

  const http: HttpServer = await new Promise((resolve, reject) => {
    const s = app.listen(config.port, o.host ?? "0.0.0.0", (err?: Error) => (err ? reject(err) : resolve(s)));
    s.once("error", reject);
  });
  note(`remote mode: listening on port ${config.port}; clients connect to ${mcpUrl.href}`);
  return {
    url: mcpUrl.href,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections?.();
        http.close(() => resolve());
      }),
  };
}
