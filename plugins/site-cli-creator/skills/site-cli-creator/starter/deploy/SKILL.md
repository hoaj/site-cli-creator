---
name: __PLUGIN__-deploy
description: Deploys one of the __PLUGIN__ plugin's CLI skills as a remote MCP server on a host the user controls (Railway first), so claude.ai and the phone can use it, and walks the user through the Owner password, the Session upload and the connector. Use when the user wants __PLUGIN__ on claude.ai or on their phone, asks to deploy, host or put a __PLUGIN__ CLI skill online, or has trouble with its remote server, its Setup page or an expired Session there. Not for using __PLUGIN__ on the user's own computer (that is the CLI skill itself, or its local `mcp`), for anyone else's account, or for hosting it for other people.
---
<!-- version: 0.1.0 -->

# __PLUGIN__ deploy

Runs one of this plugin's CLI skills in remote mode (`<skill> mcp --http`) on a host the Owner controls, so claude.ai and the phone reach the same Tasks as tools. The Owner is the one person this is for: they deploy from their own checkout of `__REPO__`, and the server serves their account only. One CLI skill per server. A site whose Sessions are short or that blocks bots suits remote mode poorly: the server cannot sign in again by itself, so the Owner uploads a new Session each time. For those, use local mode (`<skill> mcp`) instead.

## Pick the CLI skill

The folders under `skills/` that have a `cli/` folder. Ask the Owner which one if there are several. Everything below runs from `skills/<skill>/`, which holds the `Dockerfile` and `railway.json`.

## The contract

Any container host works. The image is built from `skills/<skill>/Dockerfile`, with that folder as the build context.

- `OWNER_PASSWORD` (12+ characters) **or** `OWNER_PASSWORD_HASH`. Without one the server refuses to start.
- `PUBLIC_URL`: the https address clients use. On Railway a generated domain is used automatically.
- Optional: `PORT` (default 8080), `TRUST_PROXY` (default 1, for one https proxy in front), `EXTRA_REDIRECT_URIS` (more client callbacks than claude.ai's).
- A persistent volume mounted on `/data`. All state lives there; without it every deploy loses the Session and every client's sign-in.
- Exactly one replica. Health check: `GET /healthz`.

## The Owner password

Offer to generate it; the Owner may choose their own instead (12+ characters).

1. Generate it with a CSPRNG and hash it in one command, so the password passes through the chat only once (run `bash install.sh` first if `bin/<skill>` is missing): `pw=$(openssl rand -base64 24) && printf 'Owner password: %s\n' "$pw" && printf '%s' "$pw" | bin/<skill> mcp --hash-password`. It prints the password, then `{"OWNER_PASSWORD_HASH": "..."}`. Never make one up from your own text.
2. Show the password to the Owner **once**, and ask them to store it in their password manager before going on. Do not repeat it or type it into a later command.
3. Set `OWNER_PASSWORD_HASH` on the host (recommended: the plain password never sits in the host's variables). If the Owner wants the plain `OWNER_PASSWORD` instead, they paste it into the host's variables themselves.
4. An Owner who picks their own password runs `bin/<skill> mcp --hash-password` in their own terminal (type it, then Ctrl-D) and gives you only the hash.
5. Never write the password into a file in the repo, a commit, a log, or the chat beyond that one display.

It is the sign-in page's password when connecting claude.ai or the phone, and the password of every Setup page action. To rotate it, set a new value and restart the server: every client is signed out and signs in again.

## Railway

From `skills/<skill>/`, with the Railway CLI logged in (`railway login`). Run `railway <command> --help` if a flag differs on your version (written against 5.63).

1. A project and a service: `railway init --name <plugin>-<skill>`, then `railway add --service <skill>`. For an existing project use `railway link` instead.
2. A volume on `/data`: `railway volume add --service <skill> --mount-path /data`.
3. The password variable, with the value on stdin so the shell leaves it alone (a hash holds `$`): `printf '%s' '<hash>' | railway variable set OWNER_PASSWORD_HASH --stdin --service <skill> --skip-deploys`. A plain password the Owner sets in their own terminal (`railway variable set OWNER_PASSWORD --stdin --service <skill> --skip-deploys`, type it, then Ctrl-D) or in the dashboard's Variables.
4. A public address: `railway domain --service <skill>` prints `https://<name>.up.railway.app`. `PUBLIC_URL` follows from it by itself.
5. Deploy: `railway up --service <skill>` uploads this folder and builds the Dockerfile; `railway.json` is read from the folder's root. The first build takes a few minutes. `--detach` returns at once; then watch `railway logs --build --service <skill>`.
6. Check `https://<domain>/healthz` (it answers `{"ok":true,...}`), then open `https://<domain>/setup`.

If Railway's own Claude Code plugin is installed (`railway@railway-skills`), its skill can run these steps; this skill still owns the order and the remote-mode specifics.

## Give the server a Session

Skills whose Tasks need a sign-in only; the others skip this. On the Owner's computer run `bin/<skill> login`, then upload the `session.json` from the CLI skill's state dir (`~/.__PLUGIN__/` when the skill is named `__PLUGIN__`, else `~/.__PLUGIN__-<skill>/`) on `https://<domain>/setup` with the Owner password. The page says "Session stored and checked" when it works. The Session is never shown again; the Owner uploads a fresh one when it expires. Do not read or print the file yourself.

## Connect claude.ai and the phone

Add a custom connector in claude.ai with the URL `https://<domain>/mcp`, and sign in with the Owner password on the page that opens. The phone uses the same account, so it has the connector too. Claude Code can add it as well: `claude mcp add --transport http <name> https://<domain>/mcp`.

## Later

- A new plugin version: `git pull`, then `railway up --service <skill>` again from the same folder. The volume keeps the Session and the sign-ins.
- An expired Session: the tools say so and point at `/setup`. Upload a new one.
- A new password: as above. Logs: `railway logs --service <skill>`.
- Drift or a bug in a Task: that is the `__PLUGIN__-feedback` skill.

## When NOT to use

- Local use: that is the CLI skill, or `<skill> mcp` with no server.
- Anyone else's account, or hosting for other people: out of scope until the plugin decides to publish.
