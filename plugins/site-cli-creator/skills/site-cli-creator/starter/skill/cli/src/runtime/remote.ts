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
import { Failure } from "./envelope";
import { inputSchema, toolResult, type McpTool, type ServerInfo } from "./mcp";
import { OAuthStore, OwnerProvider, failedPage, returningPage, signedInPage } from "./owner-auth";
import { redirectAllowed, type RemoteConfig } from "./remote-config";
import { saveSession, sessionUploadSchema, type Session } from "./session";
import { clearSession, persistenceWarning, readStatus, setupPage, writeStatus, type SessionCheck, type SetupPage } from "./setup";
import type { Env, Site } from "./site";

export type ServeOptions = {
  info: ServerInfo;
  tools: McpTool[];
  site: Site;
  config: RemoteConfig;
  /** The CLI skill's state dir: oauth.json lives there (a volume on the host). */
  dir: string;
  /** Interface to listen on; all of them by default, as a container needs. */
  host?: string;
  /** The host's environment, for the Setup page's volume warning. */
  env?: Env;
  /** One live read with a candidate Session (main.ts builds it from the registry), before it is stored. */
  checkSession: (candidate: Session) => Promise<SessionCheck>;
  note: (message: string) => void;
  now?: () => number;
};

export type RemoteServer = { url: string; store: OAuthStore; provider: OwnerProvider; close(): Promise<void> };

/** Origins a browser-borne request to /mcp may come from; a request without Origin is served. */
const CLIENT_ORIGINS = ["https://claude.ai"];

/** The Setup page's upload: a request of at most this size, holding a session.json of at most the second. */
const MAX_UPLOAD_REQUEST = 256 * 1024;
const MAX_SESSION_BYTES = 64 * 1024;

/** What the tool adapter needs to point a client at the Setup page. */
type SetupInfo = { dir: string; url: string; skill: string; now: () => number };

/** The request body, or null once it passes `cap` bytes (the rest is read and dropped, so the answer can still be sent). */
function readCapped(req: express.Request, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total <= cap) return void chunks.push(chunk);
      chunks.length = 0;
      req.removeAllListeners("data");
      req.resume();
      resolve(null);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * A `session` failure in remote mode is the Owner's to fix, not the client's: the Setup page then
 * shows the Session as expired (when one was stored), and `next` names that page, not the login tool.
 * A call that succeeds while the page says expired proves the Session works again (one refused
 * request does not end a Session for good), so it is marked valid.
 */
function sessionFailure(output: unknown, code: number, setup: SetupInfo): unknown {
  const error = (output as { error?: { kind?: string; message?: string } } | null)?.error;
  if (!error || error.kind !== "session") {
    if (code === 0) {
      const status = readStatus(setup.dir);
      if (status.state === "expired") writeStatus(setup.dir, { state: "valid", ...(status.uploadedAt && { uploadedAt: status.uploadedAt }), checkedAt: new Date(setup.now()).toISOString() });
    }
    return output;
  }
  const before = readStatus(setup.dir);
  if (before.state !== "missing") {
    writeStatus(setup.dir, { state: "expired", ...(before.uploadedAt && { uploadedAt: before.uploadedAt }), checkedAt: new Date(setup.now()).toISOString(), reason: String(error.message ?? "") });
  }
  const next = `Ask the Owner to give this server a new Session at ${setup.url} (they run ${setup.skill} login on their computer and upload the session.json). Do not retry until they have.`;
  return { error: { ...error, next } };
}

/** The tools as an SDK low-level Server: list and call go to the same McpTool list as local mode. */
function mcpServerFor(info: ServerInfo, tools: McpTool[], serial: <T>(fn: () => Promise<T>) => Promise<T>, setup: SetupInfo) {
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
    return toolResult(sessionFailure(output, code, setup), code) as never;
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

  const clock = () => (o.now ? o.now() * 1000 : Date.now());
  const setup: SetupInfo = { dir: o.dir, url: new URL("setup", base).href, skill: o.site.skill, now: clock };

  const app = express();
  // req.ip feeds the lockout and the SDK's rate limits: trust X-Forwarded-For only from the proxies in front.
  app.set("trust proxy", config.trustProxy);
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

  // --- the Setup page: the Owner gives the server a Session; every action asks for the Owner password ---

  const siteName = new URL(o.site.origin).host;
  const answer = (res: express.Response, status: number, notice?: SetupPage["notice"]) =>
    void res
      .status(status)
      .set("Cache-Control", "no-store")
      .type("html")
      .send(setupPage({ serverName: o.info.name, siteName, auth: o.site.auth, status: readStatus(o.dir), warning: persistenceWarning(o.env ?? {}, o.dir), notice, skill: o.site.skill }));
  const refuse = (res: express.Response, status: number, text: string) => answer(res, status, { kind: "error", text });
  const ownerOnly = (req: express.Request, res: express.Response, password: unknown): boolean => {
    const checked = provider.checkOwnerPassword(typeof password === "string" ? password : "", req.ip ?? "unknown");
    if ("ok" in checked) return true;
    refuse(res, 401, checked.error);
    return false;
  };

  /** An answer given without reading the body: the connection closes and the unread body is dropped. */
  const refuseUnread = (req: express.Request, res: express.Response, status: number, text: string) => {
    res.set("Connection", "close");
    req.resume();
    refuse(res, status, text);
  };

  app.get("/", (_req, res) => void res.redirect(302, "/setup"));
  app.get("/setup", (_req, res) => answer(res, 200));

  app.post("/setup/session", async (req, res) => {
    if (o.site.auth !== "login") return refuseUnread(req, res, 400, "This site needs no sign-in, so there is no Session to upload.");
    // A declared length over the cap is refused unread; without one (chunked) the body is read up to the cap.
    const declared = req.headers["content-length"];
    if (declared !== undefined && !(Number(declared) <= MAX_UPLOAD_REQUEST)) return refuseUnread(req, res, 413, "That upload is too large for a session.json.");
    const body = await readCapped(req, MAX_UPLOAD_REQUEST);
    if (!body) return refuseUnread(req, res, 413, "That upload is too large for a session.json.");
    let form: FormData;
    try {
      form = await new Request("http://local/", { method: "POST", headers: { "content-type": req.headers["content-type"] ?? "" }, body: new Uint8Array(body) }).formData();
    } catch {
      return refuse(res, 400, "The upload could not be read; use the form on this page.");
    }
    if (!ownerOnly(req, res, form.get("password"))) return;
    const file = form.get("session_file");
    const pasted = form.get("session_text");
    let text = file instanceof File ? await file.text() : "";
    if (!text.trim()) text = typeof pasted === "string" ? pasted : "";
    if (!text.trim()) return refuse(res, 400, "Choose session.json or paste its contents.");
    if (Buffer.byteLength(text) > MAX_SESSION_BYTES) return refuse(res, 413, "session.json is larger than 64 KB; that is not a session file.");
    let parsed: ReturnType<typeof sessionUploadSchema.safeParse>;
    try {
      parsed = sessionUploadSchema.safeParse(JSON.parse(text));
    } catch {
      parsed = sessionUploadSchema.safeParse(undefined);
    }
    if (!parsed.success) {
      // Top-level field names only: nothing the Owner sent comes back.
      const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
      return refuse(res, 400, `That is not a session.json from ${o.site.skill} login${fields.length ? ` (check: ${fields.join(", ")})` : ""}.`);
    }
    const at = new Date(clock()).toISOString();
    const { headers, ids, accounts } = parsed.data;
    if (Object.keys(headers).length === 0) return refuse(res, 400, `This session.json holds no sign-in (no headers); upload the file ${o.site.skill} login wrote.`);
    let checked: SessionCheck;
    try {
      // One turn in the tool calls' queue for the check, the save and the status, so a delete or a
      // call that refreshes a Session never lands between them.
      checked = await serial(async () => {
        const result = await o.checkSession({ headers, ids, accounts, savedAt: at });
        if (!result.ok) return result;
        saveSession(o.dir, { headers, ids, accounts, savedAt: at });
        writeStatus(o.dir, result.tried > 0 ? { state: "valid", uploadedAt: at, checkedAt: at } : { state: "unchecked", uploadedAt: at });
        return result;
      });
    } catch {
      note("a Session upload failed inside the server");
      return refuse(res, 500, "The Session could not be checked (an error inside the server).");
    }
    if (!checked.ok) {
      note("Session rejected (the live check failed)");
      return refuse(res, 400, `Not stored: ${checked.reason}.`);
    }
    if (checked.tried === 0) {
      note("Session stored (not checked)");
      return answer(res, 200, { kind: "ok", text: "Session stored, but not checked: none of the site's reads can run without input." });
    }
    note("Session stored (checked)");
    answer(res, 200, { kind: "ok", text: `Session stored and checked against ${siteName}.` });
  });

  app.post("/setup/delete", express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
    if (!ownerOnly(req, res, req.body?.password)) return;
    await serial(async () => clearSession(o.dir));
    note("Session deleted");
    answer(res, 200, { kind: "ok", text: "Session deleted." });
  });

  app.post("/setup/signout", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
    if (!ownerOnly(req, res, req.body?.password)) return;
    provider.revokeAll();
    note("every client signed out from the Setup page");
    answer(res, 200, { kind: "ok", text: "Every client is signed out; each one has to sign in again." });
  });

  const allowedOrigins = new Set([base.origin, ...CLIENT_ORIGINS]);
  const origin: express.RequestHandler = (req, res, next) => {
    const from = req.headers.origin;
    if (from && !allowedOrigins.has(from)) return void res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: `Origin not allowed: ${from}` }, id: null });
    next();
  };
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl), expectedResource: mcpUrl });

  app.post("/mcp", origin, bearer, express.json({ limit: "1mb" }), async (req, res) => {
    const server = mcpServerFor(o.info, o.tools, serial, setup);
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
    const fail = (err: NodeJS.ErrnoException) =>
      reject(new Failure("input", err.code === "EADDRINUSE" ? `port ${config.port} is already in use` : `cannot listen on port ${config.port} (${err.code ?? err.message})`, {
        next: "Choose a free port with --port or PORT, then start `mcp --http` again.",
      }));
    const s = app.listen(config.port, o.host ?? "0.0.0.0", (err?: Error) => (err ? fail(err) : resolve(s)));
    s.once("error", fail);
  });
  note(`remote mode: listening on port ${config.port}; clients connect to ${mcpUrl.href}; the Owner gives it a Session at ${setup.url}`);
  return {
    url: mcpUrl.href,
    store,
    provider,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections?.();
        http.close(() => resolve());
      }),
  };
}
