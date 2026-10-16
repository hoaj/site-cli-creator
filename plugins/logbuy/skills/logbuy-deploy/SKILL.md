---
name: logbuy-deploy
description: Deploys the logbuy CLI skill as a remote MCP server on a host the user controls (Railway first), so claude.ai and the phone can use it, and walks the user through the Owner password, the Session upload and the connector. Use when the user wants logbuy on claude.ai or on their phone, asks to deploy, host or put the logbuy CLI skill online, or has trouble with its remote server, its Setup page or an expired Session there. Not for using logbuy on the user's own computer (that is the CLI skill itself, or its local `mcp`), for anyone else's account, or for hosting it for other people.
---
<!-- version: 0.5.0 -->

# logbuy deploy

Runs this plugin's one CLI skill, `logbuy`, in remote mode (`logbuy mcp --http`) on a host the Owner controls, so claude.ai and the phone reach the same Tasks as tools. The Owner is the one person this is for: they deploy from their own checkout of `hoaj/skills`, and the server serves their account only. A site whose Sessions are short or that blocks bots suits remote mode poorly: the server cannot sign in again by itself, so the Owner uploads a new Session each time. For those, use local mode (`logbuy mcp`) instead.

## Pick the CLI skill

There is one, `logbuy`. Everything below runs from `plugins/logbuy/skills/logbuy/` in the Owner's checkout of `hoaj/skills`, which holds the `Dockerfile` and `railway.json`.

## The contract

Any container host works. The image is built from `plugins/logbuy/skills/logbuy/Dockerfile`, with that folder as the build context.

- `OWNER_PASSWORD` (12+ characters) **or** `OWNER_PASSWORD_HASH`. Without one the server refuses to start.
- `PUBLIC_URL`: the https address clients use. On Railway a generated domain is used automatically.
- Optional: `PORT` (default 8080), `TRUST_PROXY` (a number of proxies; default 1 when `PUBLIC_URL` is https, for one proxy in front, else 0), `EXTRA_REDIRECT_URIS` (comma-separated exact callback URLs; claude.ai's and loopback ones need none).
- A persistent volume mounted on `/data`. All state lives there; without it every deploy loses the Session and every client's sign-in.
- Exactly one replica. Health check: `GET /healthz`.

## The Owner password

12+ characters. Two options; offer A.

**Option A (recommended): generate.** Generate it with a CSPRNG and hash it in one command, so the password passes through the chat only once. `bin/logbuy` is missing until `bash install.sh` has run; that downloads the binary for this plugin version (release `logbuy-v<version>`). With no release yet, build it: `cd cli && bun install && bun build.ts <bun-target> ../bin/logbuy` (targets: `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64`).

`pw=$(openssl rand -base64 24) && printf 'Owner password: %s\n' "$pw" && printf '%s' "$pw" | bin/logbuy mcp --hash-password`

It prints the password, then `{"OWNER_PASSWORD_HASH": "..."}`. Never make one up from your own text. Show the password to the Owner **once** and ask them to store it in their password manager before going on. Do not repeat it or type it into a later command. Set `OWNER_PASSWORD_HASH` on the host.

**Option B: the Owner's own password.** They run `bin/logbuy mcp --hash-password` in their own terminal (type it, then Ctrl-D) and give you only the hash. Set `OWNER_PASSWORD_HASH` as in A. A plain `OWNER_PASSWORD` is also allowed; the Owner sets it in the host's own dashboard (on Railway, the service's Variables tab), never by typing it into a command.

Never write the password into a file in the repo, a commit, a log, or the chat beyond Option A's one display.

It is the sign-in page's password when connecting claude.ai or the phone, and the password of every Setup page action. To rotate it, set a new value and restart the server (on Railway, see step 3 below): every client is signed out and signs in again.

## Railway

From `plugins/logbuy/skills/logbuy/`, with the Railway CLI logged in (`railway login`). Run `railway <command> --help` if a flag differs on your version (written against 5.63).

1. A project and a service: `railway init --name logbuy`, then `railway add --service logbuy`. For an existing project use `railway link` instead.
2. A volume on `/data`: `railway volume add --service logbuy --mount-path /data`. If it refuses the name, pass the service ID (from `railway status --json`).
3. The password variable, with the value on stdin so the shell leaves it alone (a hash holds `$`): `printf '%s' '<hash>' | railway variable set OWNER_PASSWORD_HASH --stdin --service logbuy --skip-deploys`. `--skip-deploys` is only because the first deploy comes later. To rotate, set the new value without `--skip-deploys` (Railway redeploys), or run `railway redeploy --service logbuy` afterwards. A plain `OWNER_PASSWORD` is set by the Owner in the dashboard's Variables tab.
4. A public address: `railway domain --service logbuy` prints `https://<name>.up.railway.app`. `PUBLIC_URL` follows from it by itself. If the domain is added or changed after a deploy, redeploy (`railway redeploy --service logbuy`) or set `PUBLIC_URL` yourself: Railway gives `RAILWAY_PUBLIC_DOMAIN` only to deployments made after the domain exists.
5. Deploy: `railway up --service logbuy` uploads this folder and builds the Dockerfile; `railway.json` is read from the folder's root. The first build takes a few minutes. `--detach` returns at once; then watch `railway logs --build --service logbuy`.
6. Check `https://<domain>/healthz` (it answers `{"ok":true,...}`), then open `https://<domain>/setup`.

A failed health check usually means a missing or invalid password variable, or `PUBLIC_URL`. The server's start-up error names the variable: `railway logs --deployment --service logbuy`.

If Railway's own Claude Code plugin is installed (`railway@railway-skills`), its skill can run these steps; this skill still owns the order and the remote-mode specifics.

## Give the server a Session

On the Owner's computer run `bin/logbuy login`, then upload the `session.json` from the state dir `~/.logbuy/` on `https://<domain>/setup` with the Owner password. The page answers one of:

- "Session stored and checked against <site>." It works.
- "Session stored, but not checked: ..." Fine. The page then shows the Session as unchecked.
- "Not stored: <reason>." The old Session is kept. Fix the reason and upload again.

The Session is never shown again; the Owner uploads a fresh one when it expires. Do not read or print the file yourself.

## Connect claude.ai and the phone

Add a custom connector in claude.ai with the URL `https://<domain>/mcp`, and sign in with the Owner password on the page that opens. The phone uses the same account, so it has the connector too. Claude Code can add it as well: `claude mcp add --transport http --scope user <name> https://<domain>/mcp`. The first use opens the sign-in page (Owner password); start it from `/mcp` in Claude Code.

## Later

- A new plugin version: `git pull`, then `railway up --service logbuy` again from the same folder. The volume keeps the Session and the sign-ins.
- An expired Session: the tools say so and point at `/setup`. Upload a new one.
- A new password: as above. Logs: `railway logs --deployment --service logbuy`.
- Drift or a bug in a Task: that is the `logbuy-feedback` skill.

## When NOT to use

- Local use: that is the CLI skill, or `logbuy mcp` with no server.
- Anyone else's account, or hosting for other people: out of scope until the plugin decides to publish.
