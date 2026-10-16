---
name: logbuy-deploy
description: Deploys the logbuy CLI skill as a remote MCP server on a host the user controls (Railway first), so claude.ai and the phone can use it, and walks the user through the Owner password, the Session upload and the connector. Use when the user wants logbuy on claude.ai or on their phone, asks to deploy, host or put the logbuy CLI skill online, or has trouble with its remote server, its Setup page or an expired Session there. Not for using logbuy on the user's own computer (that is the CLI skill itself, or its local `mcp`), for anyone else's account, or for hosting it for other people.
---
<!-- version: 0.5.1 -->

# logbuy deploy

Runs this plugin's one CLI skill, `logbuy`, in remote mode (`logbuy mcp --http`) on a host the Owner controls, so claude.ai and the phone reach the same Tasks as tools. The Owner is the one person this is for: they deploy from their own checkout of `hoaj/skills`, and the server serves their account only. A site whose Sessions are short or that blocks bots suits remote mode poorly: the server cannot sign in again by itself, so the Owner uploads a new Session each time. For those, use local mode (`logbuy mcp`) instead.

## Pick the CLI skill

There is one, `logbuy`. Everything below runs from `plugins/logbuy/skills/logbuy/` in the Owner's checkout of `hoaj/skills`, which holds the `Dockerfile` and `.dockerignore`. Nothing host-specific lives there.

## The contract

Any container host works. The image is built from `plugins/logbuy/skills/logbuy/Dockerfile`, with that folder as the build context.

- `OWNER_PASSWORD` (12+ characters) **or** `OWNER_PASSWORD_HASH`. Without one the server refuses to start.
- `PUBLIC_URL`: the https address clients use. Some hosts' generated domains are used automatically (Railway's is).
- Optional: `PORT` (default 8080), `TRUST_PROXY` (a number of proxies; default 1 when `PUBLIC_URL` is https, for one proxy in front, else 0), `EXTRA_REDIRECT_URIS` (comma-separated exact callback URLs; claude.ai's and loopback ones need none).
- A persistent volume mounted on `/data`. All state lives there; without it every deploy loses the Session and every client's sign-in.
- Exactly one replica (Railway's default), and a health check on `GET /healthz` (recommended). The host guide says how.

## The Owner password

12+ characters. Two options; offer A.

**Option A (recommended): generate.** Generate it with a CSPRNG and hash it in one command, so the password passes through the chat only once. `bin/logbuy` is missing until `bash install.sh` has run; that downloads the binary for this plugin version (release `logbuy-v<version>`). With no release yet, build it: `cd cli && bun install && bun build.ts <bun-target> ../bin/logbuy` (targets: `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64`).

`pw=$(openssl rand -base64 24) && printf 'Owner password: %s\n' "$pw" && printf '%s' "$pw" | bin/logbuy mcp --hash-password`

It prints the password, then `{"OWNER_PASSWORD_HASH": "..."}`. Never make one up from your own text. Show the password to the Owner **once** and ask them to store it in their password manager before going on. Do not repeat it or type it into a later command. Set `OWNER_PASSWORD_HASH` on the host.

**Option B: the Owner's own password.** They run `bin/logbuy mcp --hash-password` in their own terminal (type it, then Ctrl-D) and give you only the hash. Set `OWNER_PASSWORD_HASH` as in A. A plain `OWNER_PASSWORD` is also allowed; the Owner sets it in the host's own dashboard, never by typing it into a command.

Never write the password into a file in the repo, a commit, a log, or the chat beyond Option A's one display.

It is the sign-in page's password when connecting claude.ai or the phone, and the password of every Setup page action. To rotate it, set a new value and restart the server (the host guide says how): every client is signed out and signs in again.

## Pick a host

| Host | Guide |
|---|---|
| Railway | [hosts/railway.md](hosts/railway.md) |
| Any other container host | No guide yet. Build `plugins/logbuy/skills/logbuy/Dockerfile` with that folder as the context, meet the contract above, then carry on from "Give the server a Session". |

The guide covers the host's steps, in order, from the project to the first check of `/healthz`, and gives the server's https address: `<domain>` below. This skill owns the order around it and the remote-mode specifics.

## Give the server a Session

On the Owner's computer run `bin/logbuy login`, then upload the `session.json` from the state dir `~/.logbuy/` on `https://<domain>/setup` with the Owner password. The page answers one of:

- "Session stored and checked against <site>." It works.
- "Session stored, but not checked: ..." Fine. The page then shows the Session as unchecked.
- "Not stored: <reason>." The old Session is kept. Fix the reason and upload again.

The Session is never shown again; the Owner uploads a fresh one when it expires. Do not read or print the file yourself.

## Connect claude.ai and the phone

Add a custom connector in claude.ai with the URL `https://<domain>/mcp`, and sign in with the Owner password on the page that opens. The phone uses the same account, so it has the connector too. Claude Code can add it as well: `claude mcp add --transport http --scope user <name> https://<domain>/mcp`. The first use opens the sign-in page (Owner password); start it from `/mcp` in Claude Code.

A connector added in claude.ai also shows up in Claude Code (same account) as `claude.ai <name>`. If a local `logbuy mcp` is set up there too, the same Tasks appear twice. Turn the claude.ai one off with `/mcp`, or all claude.ai connectors with `"disableClaudeAiConnectors": true` in `~/.claude/settings.json`.

## Later

- A new plugin version: `git pull`, then redeploy from the same folder as the host guide says. The volume keeps the Session and the sign-ins.
- An expired Session: the tools say so and point at `/setup`. Upload a new one.
- A new password: as above. Logs: see the host guide.
- Drift or a bug in a Task: that is the `logbuy-feedback` skill.

## When NOT to use

- Local use: that is the CLI skill, or `logbuy mcp` with no server.
- Anyone else's account, or hosting for other people: out of scope until the plugin decides to publish.
