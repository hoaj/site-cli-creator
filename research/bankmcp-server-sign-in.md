# BankMCP's Server sign-in and security: what carries over to remote mode

Research for hoaj/skills#54 (map #53). Question: what BankMCP's one-user OAuth 2.1 server and its security consist of, and which parts carry over to a remote-mode CLI skill whose Setup page takes a Session upload.

**Sources** (read 2026-10-14):

- BankMCP 0.1.14 at `~/Documents/projects/hobby/mcp-bank`: `src/auth.ts`, `src/app.ts`, `src/server.ts`, `src/pages.ts`, `src/store.ts`, `src/setup.ts`, `src/register.ts`, `src/config.ts`, `package.json`, `Dockerfile`, `docker-entrypoint.sh`, `railway.json`, `README.md` § Security notes, `docs/security/index.html`, and the test names in `test/auth.test.ts`. Line numbers below refer to these files.
- `@modelcontextprotocol/sdk` 1.30.0 (BankMCP's version) and 1.32.1 (the latest v1), unpacked from npm, under `dist/esm/server/auth/`. BankMCP's own `node_modules/@modelcontextprotocol/sdk/dist` is empty, so the code was read from the npm tarballs.
- `@modelcontextprotocol/server` 2.3.1 and `@modelcontextprotocol/express` 2.0.2 (SDK v2), unpacked from npm.
- The MCP spec 2025-11-25: [Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) and [Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
- Claude's connector docs: [Authentication for connectors](https://claude.com/docs/connectors/building/authentication).

## Short answer

- **Most of the sign-in carries over unchanged.** That covers the SDK auth router (discovery, registration, authorize with PKCE, token, revoke), the provider's hashed storage of codes and tokens, their lifetimes and refresh rotation, the password check, the sign-in page, its one-time request id, the per-IP lockout, the kill switch that revokes everything when the password changes, and the security headers. BankMCP's `SingleUserProvider` (`src/auth.ts`, 245 lines) can be ported almost verbatim.
- **BankMCP-specific, so it is dropped:** the first-run setup page (Enable Banking app id, key file and password), "Register for me" (`register.ts`, `controlpanel.ts`), `/callback`, the watcher, local mode (`selfsigned`, stdio, `BANKMCP_LOCAL`), and the `settings.json` password fallback.
- **New in remote mode:** the Setup page takes a Session upload over and over (each time the Session expires), not once at first run. So it has to sit behind the Owner's password. BankMCP's setup page is unauthenticated while the server is unconfigured, and that does not carry over.
- **Fix these when porting**, in order of weight:
  1. An expired access token gets HTTP 400, not 401.
  2. The redirect allowlist is too broad (it includes ChatGPT/OpenAI hosts).
  3. Anyone can evict the Owner's client, because registration is open and capped at 20.
  4. The password fingerprint is an unsalted SHA-256 of the plain password, written to disk.
  5. Token audience is not checked.
  6. There is no Origin check on `/mcp`.
  7. There is no refresh-token reuse detection.
- **Structural risk:** the "official SDK auth router" exists only in SDK **v1** (1.x, latest 1.32.1, 2026-10-05). SDK **v2** (`@modelcontextprotocol/server` 2.x, first released 2026-07-27) ships only the resource-server half: bearer checks, protected-resource metadata, and Origin/Host validation. It has no `mcpAuthRouter`, no `OAuthServerProvider`, and no authorize, token, register or revoke handlers. The v1 router is Express-only (`router.js` imports `express`; every handler uses `express.Router`).

## What BankMCP's sign-in consists of

### 1. SDK auth router endpoints (`app.ts:157-166`)

`app.use(mcpAuthRouter({provider, issuerUrl: baseUrl, resourceServerUrl: <base>/mcp, resourceName: "bank-mcp", scopesSupported: ["bank:read"], clientRegistrationOptions: {clientSecretExpirySeconds: 0}}))` mounts the following (SDK `router.js`):

| Endpoint | Handler | Methods | SDK default rate limit (per IP) | Other middleware |
|---|---|---|---|---|
| `/.well-known/oauth-protected-resource/mcp` (RFC 9728; the path follows the resource URL) | `metadataHandler` | GET, OPTIONS | none | CORS `*` |
| `/.well-known/oauth-authorization-server` (RFC 8414) | `metadataHandler` | GET, OPTIONS | none | CORS `*` |
| `/authorize` | `authorizationHandler` | GET, POST | 100 / 15 min | `Cache-Control: no-store` |
| `/token` | `tokenHandler` | POST (form-urlencoded) | 50 / 15 min | CORS `*`, `authenticateClient` |
| `/register` (present because `clientsStore.registerClient` exists) | `clientRegistrationHandler` | POST (JSON) | 20 / hour | CORS `*` |
| `/revoke` (present because `provider.revokeToken` exists) | `revocationHandler` | POST | 50 / 15 min | CORS `*`, `authenticateClient` |

The router's metadata advertises:

- `response_types_supported: ["code"]`
- `code_challenge_methods_supported: ["S256"]`
- `grant_types_supported: ["authorization_code", "refresh_token"]`
- `token_endpoint_auth_methods_supported: ["client_secret_post", "none"]`

`checkIssuerUrl` refuses a non-HTTPS issuer except on localhost or 127.0.0.1, unless `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` is set. The rate limits come from `express-rate-limit`, keyed by `req.ip`. BankMCP sets `trust proxy 1` (`app.ts:27`), so behind Railway's proxy `req.ip` is the client's address.

BankMCP adds two routes of its own:

- **`POST /login`** (`app.ts:174-185`): the password form. The SDK does not rate-limit it; BankMCP's own lockout covers it (section 6).
- **`POST /mcp` and `POST /`** behind `requireBearerAuth({verifier: provider, resourceMetadataUrl})` (`app.ts:189-207`). It is stateless: one `McpServer` and one `StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true})` per request, with a 1 MB JSON limit. `GET /mcp` and `DELETE /mcp` answer 405 behind the same bearer check.

The spec requires protected-resource metadata, AS metadata or OIDC discovery, and PKCE S256 advertised in metadata. Dynamic Client Registration (DCR) is only a MAY; Client ID Metadata Documents (CIMD) are a SHOULD (spec § Overview 2-5). Claude uses CIMD only when the AS advertises `client_id_metadata_document_supported: true` and `"none"`, and otherwise falls back to DCR (Claude docs § DCR and CIMD details). The v1 router does not advertise CIMD, so Claude uses DCR, which is fine.

### 2. Client registration (`auth.ts:98-124`)

- The SDK handler validates the metadata and generates `client_id` (UUID). For a confidential client it also generates `client_secret` (32 random bytes, hex). `clientSecretExpirySeconds: 0` means secrets never expire (`register.js`).
- `registerClient` refuses any `redirect_uri` whose hostname is not in `ALLOWED_REDIRECT_HOSTS` or a subdomain of one. The default list (`config.ts:91`) is `claude.ai, claude.com, chatgpt.com, openai.com, mistral.ai, cursor.com, cursor.sh, vscode.dev, localhost, 127.0.0.1`.
- Clients are stored in `bank.json` with any `client_secret` **in plain text**. Above 20 clients, the oldest are deleted (`auth.ts:117-118`).
- At authorize time the SDK requires an exact `redirect_uri` match, except for loopback hosts, where any port is accepted per RFC 8252 § 7.3 (`authorize.js` `redirectUriMatches`). That covers both of Claude's redirects: `https://claude.ai/api/mcp/auth_callback` for claude.ai, Desktop and mobile, and `http://localhost:<port>/callback` or `http://127.0.0.1:<port>/callback` for Claude Code (Claude docs § Callback URLs).
- The SDK's `authenticateClient` compares `client_secret` with `!==`, which is not timing-safe (`clientAuth.js`). Claude registers as a public client (`none`), so in practice there is rarely a secret to compare.

### 3. PKCE

All of PKCE is done by the SDK:

- `/authorize` requires `code_challenge` and `code_challenge_method=S256`; there is no `plain` (`authorize.js` `RequestAuthorizationParamsSchema`).
- `/token` asks the provider for the stored challenge (`challengeForAuthorizationCode`, `auth.ts:181-185`) and checks the verifier with `pkce-challenge`'s `verifyChallenge` (`token.js`).
- BankMCP only stores `code_challenge` with the code.

### 4. Lifetimes (`auth.ts:17-21`)

| Item | Lifetime | Where it lives |
|---|---|---|
| Access token | 1 hour | `bank.json`, keyed by SHA-256 |
| Refresh token | 90 days, renewed on every use because it rotates | `bank.json`, keyed by SHA-256 |
| Authorization code | 10 minutes, single use (deleted on exchange) | `bank.json`, keyed by SHA-256 |
| Pending sign-in (open login page) | 30 minutes, at most 5 password attempts | memory |
| Completed sign-in id (so a re-submit is answered calmly) | 30 minutes | memory |
| IP lockout | 15 minutes after 5 failures | memory |

Refresh tokens rotate: the old one is deleted and a new pair issued (`auth.ts:205-215`). The spec requires rotation for public clients (§ Token Theft), and so does Claude (§ Token refresh). Expired entries are swept whenever new ones are written. Claude refreshes proactively up to 5 minutes before expiry and reactively on a 401 (Claude docs § Token refresh).

### 5. Password and token storage

- **Password** (`auth.ts:25-45`, `config.ts:83-86`):
  - `ADMIN_PASSWORD_HASH` (format `scrypt$<salt b64>$<hash b64>`, made by `npm run hash-password`) takes precedence over `ADMIN_PASSWORD` (plain text). Then comes `settings.json`'s `admin_password_hash`, written by the setup page.
  - scrypt uses Node's defaults (N=16384, r=8, p=1), a 16-byte salt and a 64-byte key. Both paths compare with `timingSafeEqual`; the plain path leaks only the length.
  - Minimum length is 12, but it is enforced only on the setup page (`setup.ts:42,66`), never on the env var.
- **Tokens and codes:** each is 32 random bytes as base64url and stored as `sha256(value)` hex (`auth.ts:56-57`). A fast unsalted hash is right for 256-bit random secrets. A stolen `bank.json` yields no usable token.
- **Password fingerprint** (`app.ts:54-63`): `sha256(ADMIN_PASSWORD_HASH || ADMIN_PASSWORD)` is stored in `bank.json` as `oauth.password_fingerprint`. When it changes at startup, `revokeAll()` drops every token and code (clients stay). This is the kill switch.

### 6. Sign-in page, CSRF and lockout

- `provider.authorize` (`auth.ts:126-131`) stores the validated request under a fresh 32-byte id. It answers 200 with `loginPage` (`pages.ts:79-95`), which shows:
  - the client's self-declared name (it comes from DCR, so the client controls it),
  - **the redirect hostname** (the spec MUST, § Localhost Redirect URI Risks),
  - a form with a hidden `request` field and a `password` field.
- **CSRF:** the hidden request id acts as a one-time token bound to that authorization request. A cross-site POST cannot know it, and it still needs the password. There is no cookie, so there is no session to ride. `form-action 'self'` in the CSP stops the form from posting elsewhere.
- On success, `completeLogin` (`auth.ts:134-179`) drops the pending entry and writes a hashed code with the client id, challenge, redirect URI, resource and scopes. It then renders `returningPage`, a `<meta refresh>` to the client's redirect with `code` and `state` (`pages.ts:112-120`). It uses a page rather than a 302 so that a double click cannot re-post the form, and because Chrome applies `form-action` to redirects that follow a form submission (`app.ts:178-181`).
- **Lockout:** 5 wrong passwords from one IP lock that IP for 15 minutes. 5 wrong passwords on one request id kill that request. Both live in memory, so a restart clears them. Every sign-in attempt is logged, and a successful one also posts to `NOTIFY_WEBHOOK_URL` (with a Slack format) when that is set (`app.ts:41-51,73-81`).

### 7. Revocation

- `/revoke` (SDK, client-authenticated) deletes only the token presented, and only if it belongs to the calling client (`auth.ts:224-228`). Access and refresh tokens are not linked, so revoking a refresh token leaves its access token alive for up to an hour.
- Global revocation is the password change plus a restart (section 5). No page lists clients or revokes one of them.

### 8. Origin, redirect and resource checks

- **Redirect:** host allowlist at registration (section 2), plus the SDK's exact match at authorize.
- **Resource (RFC 8707):** the code stores the resource the client sent. Token exchange and refresh refuse a different resource, but only when both sides have one (`auth.ts:198,210`). Nothing checks that the resource equals this server's `/mcp` URL. `verifyAccessToken` returns `resource`, but BankMCP's `requireBearerAuth` (1.30.0) does not compare it. SDK 1.32.1 adds `requireBearerAuth({expectedResource})` for this; it rejects a token whose `AuthInfo.resource` differs (`bearerAuth.js` in 1.32.1).
- **Origin:** none on `/mcp`. The spec says servers MUST validate `Origin` on all Streamable HTTP connections and answer 403 when it is present and invalid (Transports § Security Warning). `/healthz` sends `Access-Control-Allow-Origin: *` on purpose; it carries only `{ok, version, configured}`.
- **Headers on every response** (`app.ts:29-37`): `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (so the code cannot leak in a Referer), and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`. The setup and status pages add `script-src 'unsafe-inline'`. There is no HSTS.
- **Logging:** the method, path, IP, a truncated user agent and the referer host for the OAuth paths, and the first 6 characters of the request id. Query strings, bodies and tokens are never logged (`app.ts:168-177`).

### 9. What is persisted where

| Data | Where | Mode |
|---|---|---|
| OAuth clients (with any plain-text `client_secret`), hashed codes, hashed tokens, password fingerprint | `$DATA_DIR/bank.json` (`/data` in Docker), written atomically via `.tmp` and rename | 0600 |
| Bank sessions, accounts, watches, pending bank logins (BankMCP-specific) | same `bank.json` | 0600 |
| App id, scrypt password hash, country, setup timestamps (BankMCP-specific, from the setup page) | `$DATA_DIR/settings.json` | 0600 |
| Enable Banking private key (BankMCP-specific) | `$DATA_DIR/enablebanking.pem` | 0600 |
| Pending and completed sign-ins, lockouts | process memory | n/a |
| Password (`ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH`), `BASE_URL`, `ALLOWED_REDIRECT_HOSTS`, `NOTIFY_WEBHOOK_URL` | environment | n/a |

`docker-entrypoint.sh` chowns the volume to `node` and drops root with `su-exec`. `railway.json` sets `numReplicas: 1`, which is required: the lockouts and pending sign-ins live in memory, and the JSON file has a single writer. `config.ts:50` derives `BASE_URL` from `RAILWAY_PUBLIC_DOMAIN`.

### 10. npm dependencies per part

BankMCP's own dependencies are `@modelcontextprotocol/sdk ^1.30.0`, `express ^5.2.1`, `selfsigned ^5.5.0` and `zod ^4.5.4`.

| Part | Pulls in |
|---|---|
| Auth router and handlers, bearer middleware | `@modelcontextprotocol/sdk` v1, and through it `express`, `cors`, `express-rate-limit`, `pkce-challenge`, `zod`. Installing the SDK also installs its other dependencies whether used or not: `hono`, `@hono/node-server`, `ajv`, `ajv-formats`, `jose`, `eventsource`, `eventsource-parser`, `cross-spawn`, `raw-body`, `content-type`, `json-schema-typed`, `zod-to-json-schema` |
| Provider (`auth.ts`): password, tokens, codes, lockout | `node:crypto` only, plus SDK types and error classes |
| Sign-in and other pages (`pages.ts`) | nothing (template strings and an own `esc()`) |
| Store (`store.ts`) | `node:fs` |
| `/login` and `/mcp` routes | `express` (body parsers), SDK `StreamableHTTPServerTransport` (Node wrapper over the web-standard transport, using `@hono/node-server`) |
| Setup page key check (BankMCP-specific) | `node:crypto` `createPrivateKey` |
| Local-mode TLS (BankMCP-specific) | `selfsigned` |
| Tools | `zod` |

For comparison, the generator's CLI today depends only on `playwright-core` and `zod`. It is compiled with `bun build`, and its local-mode MCP server is hand-written JSON-RPC over stdio, not the SDK (`plugins/site-cli-creator/skills/site-cli-creator/starter/skill/cli/src/runtime/mcp.ts`, `ARCHITECTURE.md` § mcp). Remote mode on the v1 router would bring in Express 5 and the dependencies above. Whether they survive `bun build --compile` is #55.

## Verdict per part

| Part | Verdict | How |
|---|---|---|
| Discovery metadata (protected resource and AS) | **Carries over unchanged** | Same `mcpAuthRouter` call. Change `resourceName` to the skill name and `scopesSupported` to one scope per skill (for example `"<skill>"`). |
| `/authorize` and PKCE S256 | **Carries over unchanged** | SDK. |
| `/token`, code exchange, refresh rotation | **Carries over unchanged** | SDK, plus the provider's `exchangeAuthorizationCode` and `exchangeRefreshToken` as they are. |
| `/register` (DCR) | **Needs adapting** | Narrow the default redirect allowlist to `https://claude.ai/api/mcp/auth_callback` (exact) plus loopback on any port for Claude Code, with an env var to widen it. Do not evict a client that still has live tokens (fix 3). |
| `/revoke` | **Carries over**, with one improvement | Revoking either token of a pair revokes both (store a grant id on both). |
| Code and token storage: SHA-256 keyed, TTLs, sweep | **Carries over unchanged** | Port `issue`, `sweep` and the TTL constants. |
| `verifyAccessToken` | **Needs adapting** | Throw `InvalidTokenError` (fix 1). Return `resource`, defaulting it to the `/mcp` URL at code time when the client sent none, and mount `requireBearerAuth({expectedResource: mcpUrl})` (SDK ≥ 1.32.1, fix 5). |
| Password check (scrypt hash or plain, timing-safe) | **Carries over** | Drop the `settings.json` fallback, because the map settles the password from an env var. Refuse to start when neither variable is set or `ADMIN_PASSWORD` is shorter than about 16 characters. Consider stronger scrypt cost (N=2^17) for the hash helper. |
| Kill switch on password change | **Needs adapting** | Keep the behaviour, but store `HMAC-SHA256(random per-instance salt, secret)` or the scrypt hash, never a bare `sha256` of the plain password (fix 4). |
| Sign-in page, `/login`, returning page | **Needs adapting** (copy only) | Same mechanism. Reword for the site: name the skill and say plainly that it can run the skill's Tasks, writes included. Drop the "read-only bank" wording. Add the spec's SHOULD warning when the only redirect URIs are loopback. Add `Cache-Control: no-store` to the `/login` response. |
| CSRF on sign-in (one-time request id, no cookies) | **Carries over unchanged** | |
| Lockout per IP and per request | **Carries over**, with one improvement | Count failures in a sliding window (today four failures stay until restart), and add a global cap (for example 20 failures per hour across all IPs locks sign-in and notifies the Owner) against distributed guessing. |
| SDK rate limits | **Carries over unchanged** | Defaults are fine for one Owner. |
| Security headers and CSP | **Carries over**, plus HSTS | Add `Strict-Transport-Security`. The Setup page needs `script-src 'unsafe-inline'` only if it reads the file in the browser; a plain `<input type=file>` form needs no script. |
| Origin check on `/mcp` | **Missing; add** | 403 when `Origin` is present and is neither the server's own origin nor `https://claude.ai`. Allow an absent `Origin`, since Claude's calls come from Anthropic's servers (egress `160.79.104.0/21`). SDK 1.x `StreamableHTTPServerTransport` has `allowedOrigins` and `enableDnsRebindingProtection`; v2 has `originValidation`. |
| Sign-in notification webhook and logging | **Carries over** (optional) | Same no-secrets logging. |
| Stateless `/mcp` behind bearer, GET and DELETE 405 | **Carries over in shape** | The transport implementation is for #55 and #56. |
| Store: one JSON file, 0600, atomic rename | **Needs adapting** | Keep only the `oauth` section (for example `$DATA_DIR/oauth.json`). The Session gets its own file (#58). Needs a Railway volume, or every deploy logs the clients out, and `numReplicas: 1`. |
| First-run setup page (app id, key, password; unauthenticated while unconfigured) | **BankMCP-specific: drop** | The remote Setup page is a different thing: it takes a Session upload, and it must be behind the Owner password (see below). |
| `register.ts`, `controlpanel.ts`, `/callback`, watcher, `enablebanking.ts` | **BankMCP-specific: drop** | |
| Local mode (`selfsigned`, stdio, `BANKMCP_LOCAL`, `local.ts`) | **BankMCP-specific: drop** | site-cli-creator already has local mode over stdio. |
| Dockerfile (node:24-alpine, `su-exec` volume chown, `/healthz` healthcheck), `railway.json` (Dockerfile builder, healthcheck, 1 replica), `BASE_URL` from `RAILWAY_PUBLIC_DOMAIN` | **Needs adapting** | Same pattern for a Bun binary with no Chrome. That is #59. |

## Weak or missing in BankMCP (do better in remote mode)

1. **Expired or unknown access token answers 400, not 401.**
   - `verifyAccessToken` throws `InvalidClientError` (`auth.ts:219-220`). `requireBearerAuth` maps only `InvalidTokenError` to 401 with `WWW-Authenticate`; any other `OAuthError` becomes a bare 400 (`bearerAuth.js`, both 1.30.0 and 1.32.1). The two classes are siblings (`errors.js`).
   - The spec says invalid or expired tokens MUST get 401 (Authorization § Token Handling). Claude refreshes reactively on a 401 (Claude docs § Token refresh).
   - BankMCP works today only because Claude also refreshes proactively. A token revoked via `/revoke`, or one surviving a clock skew, leaves Claude stuck on 400s. Fix: throw `InvalidTokenError`.
2. **The redirect allowlist lets other assistants' platforms receive codes.** The defaults include `chatgpt.com` and `openai.com` with subdomains. A ChatGPT custom GPT's OAuth callback lives on that domain, so anyone can create one that points at the Owner's server. The only defence left is the Owner reading the hostname on the sign-in page. For private use with Claude, allow exactly `https://claude.ai/api/mcp/auth_callback` plus loopback.
3. **Anyone can evict the Owner's client.** Registration is open (20 per hour per IP), and the store keeps only the newest about 20 clients (`auth.ts:117-118`). An outsider can register 20 clients and push out the Owner's. The Owner's next refresh then fails `authenticateClient` (`Invalid client_id`) and they must reconnect. Fix: evict only clients without live tokens, or cap registrations that never completed a sign-in separately.
4. **The password fingerprint is an offline-crackable hash of the password.** With `ADMIN_PASSWORD` (plain), `bank.json` holds `sha256(password)` unsalted (`app.ts:57`). Anyone who reads the file can brute-force the password at GPU speed. Fix: HMAC with a random per-instance salt, or fingerprint only the scrypt hash.
5. **Token audience is not validated.** The authorize step accepts any `resource`, and tokens are not checked against the server's URL. With one AS serving one resource, the practical risk is low. It matters the moment one instance serves several skills (out of scope now). Fix: reject a `resource` other than the `/mcp` URL at authorize, default it when absent, and use `expectedResource` (SDK ≥ 1.32.1).
6. **No Origin validation on `/mcp`** (a spec MUST). The practical risk is low for a bearer-only public server, but it is cheap to add.
7. **No refresh-token reuse detection.** If a refresh token is stolen and used first, the Owner's next refresh fails with `invalid_grant` and they reconnect, while the thief keeps a working chain. Fix: keep a grant id; when a rotated-away refresh token is presented again, revoke the whole grant.
8. **Smaller items:**
   - Failure counts below 5 never decay until restart.
   - The env-var password has no minimum length.
   - The 90-day refresh renews forever while used; consider an absolute grant lifetime (for example 180 days).
   - There is no HSTS.
   - The `/login` response lacks `no-store`.
   - Client secrets are stored in plain text and compared non-timing-safe by the SDK. This is minor, since Claude registers as a public client.
   - BankMCP mounts MCP at both `/` and `/mcp`, while the protected-resource metadata names only `/mcp`. Claude requires the metadata's `resource` to equal the URL the user entered (Claude docs § Serve discovery metadata), so remote mode should have one canonical URL, `/mcp`.

## Recommended shape for remote mode

- **Server sign-in:** port `SingleUserProvider` with fixes 1-5 and 7. Mount the SDK v1 `mcpAuthRouter` (≥ 1.32.1) and `requireBearerAuth({verifier, resourceMetadataUrl, expectedResource: <base>/mcp})`. Use one canonical MCP URL, `<base>/mcp`. Read the password only from `ADMIN_PASSWORD_HASH` or `ADMIN_PASSWORD` (refuse to start without one, or with a plain one under about 16 characters). Changing it and redeploying revokes all tokens.
- **Redirects:** by default exactly `https://claude.ai/api/mcp/auth_callback`, plus loopback on any port (Claude Code). An env var can extend the list.
- **Setup page (Session upload):** behind the same Owner password. The simplest form asks for the password in the upload form itself and checks it with the same `verifyPassword` and the same lockout. With no cookie there is no session to forge, so no CSRF token is needed beyond what the password gives. Keep CSP `form-action 'self'` and `frame-ancestors 'none'`, a body size limit (BankMCP uses 16-64 kB), and shape validation of the uploaded Session. A cookie session after sign-in is the alternative; it then needs `SameSite=Strict; Secure; HttpOnly` plus a CSRF token. How the Session is stored and protected is #58.
- **State:** `$DATA_DIR/oauth.json` (0600, atomic rename) on a Railway volume, plus the Session file. Run 1 replica.
- **Transport:** stateless Streamable HTTP POST at `/mcp` behind bearer, GET and DELETE 405, an Origin check, and security headers with HSTS.

## Open risks and questions for the sibling tickets

- **SDK v1 versus v2 (#55, #57).** The AS router is v1-only and Express-only. v2 dropped the AS half. Choosing it means pinning SDK v1 and Express 5 into the remote build and staying on v1 for that path. The alternative is to hand-write the AS: about 5 small endpoints over the same provider, which is what the SDK handlers are (router, handlers and middleware are about 675 lines of compiled JS including comments in 1.32.1). That keeps the binary dependency-light and matches how the local-mode MCP server is hand-written. Either way the provider code above carries over, because it is just the `OAuthServerProvider` interface.
- **Bun compile (#55).** Express 5, `express-rate-limit`, `cors` and `pkce-challenge` all have to work inside `bun build --compile`. That was not tested here.
- **Persistence (#59).** Without a volume, every deploy wipes clients and tokens, and the Owner reconnects from claude.ai and the phone. With a volume, tokens and the Session are at rest on Railway's disk, protected only by file mode.
- **Session secrecy (#58).** The uploaded Session is a live login to the site, more sensitive than any OAuth token here. Whoever has the Owner password can replace it, but nothing should ever send it back out (no download).
- **Unverified here:** whether claude.ai's calls carry an `Origin` header (assumed absent; check in the manual test), and how Claude handles the 400 from fix 1 beyond the docs' statement.
