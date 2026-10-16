# Deploy on Railway

Run from `plugins/logbuy/skills/logbuy/`, with the Railway CLI logged in (`railway login`). Written against 5.63. Run `railway <command> --help` if a flag differs on your version. `<service-id>` is the service's ID from step 1.

There is no Railway config file in the folder. Railway ignores its JSON config file for every service created today (Config as Code is closed to new services), and its replacement, an IaC file, needs an npm package and owns the whole project. Railway's defaults cover the rest: it always builds a `Dockerfile` at the folder's root, runs one replica and restarts on failure. The health check is step 5.

1. A project and a service: `railway init --name logbuy`, then `railway add --service logbuy`. If the account has several workspaces, add `--workspace <name>` to `railway init`. For an existing project use `railway link` instead. Run `railway status` and note the line "service ID" (it also shows the project ID and environment ID, which Railway's MCP tools in step 5 need). Pass that ID, not the name, to every command below: some subcommands refuse or crash on the name.
2. A volume on `/data`: `railway volume --service <service-id> add --mount-path /data`. The service comes before `add`.
3. The password variable, with the value on stdin so the shell leaves it alone (a hash holds `$`): `printf '%s' '<hash>' | railway variable set OWNER_PASSWORD_HASH --stdin --service <service-id> --skip-deploys`. `--skip-deploys` is only because the first deploy comes later. To rotate it later, see "Later on Railway". A plain `OWNER_PASSWORD` is set by the Owner in the dashboard's Variables tab.
4. A public address: `railway domain --service <service-id>`. Its output ends with `Next: railway domain status <domain-id>`; run that, and it prints `URL: https://<name>.up.railway.app`. `PUBLIC_URL` follows from the domain by itself. If the domain is added or changed after a deploy, redeploy (`railway redeploy --service <service-id> --yes`) or set `PUBLIC_URL` yourself: Railway gives `RAILWAY_PUBLIC_DOMAIN` only to deployments made after the domain exists.
5. The health check (recommended): set it now, so the first deploy already uses it and a bad password variable fails the deploy visibly instead of crash-looping. `railway environment edit` cannot set it (it always answers "No changes to apply"). Two ways:
   - With Railway's MCP server (Railway's Claude Code plugin, `railway@railway-skills`; sign in through `/mcp`): call its `update-service` tool with `healthcheckPath: "/healthz"` and `healthcheckTimeout: 60`. Check with `describe-service`: `deploy.healthcheckPath` reads `/healthz`.
   - Without it, the Owner sets it in the dashboard: the service, Settings, Deploy, Healthcheck Path `/healthz`.

   Set later, on a running service, it applies on the next deployment: `railway redeploy --service <service-id> --yes`.
6. Deploy: `railway up --service <service-id> --ci` uploads this folder, builds the Dockerfile and streams the build. It ends with "Deploy complete". The first build takes a few minutes.
7. Check `https://<domain>/healthz` until it answers `{"ok":true,...}` (the new deployment can take a minute to go live), then open `https://<domain>/setup`. `<domain>` is the host from step 4.

A failed deploy usually means a missing or invalid password variable, or `PUBLIC_URL`. The server's start-up error names the variable: `railway logs --deployment --service <service-id>`. A failed build: `railway logs --build --service <service-id>`.

## Later on Railway

- A new plugin version: `git pull`, then `railway up --service <service-id> --ci` from the same folder. The volume keeps the Session and the sign-ins.
- Rotate the Owner password: make a new hash (the Deploy skill's "The Owner password"), then `printf '%s' '<new hash>' | railway variable set OWNER_PASSWORD_HASH --stdin --service <service-id>`, without `--skip-deploys`, so Railway redeploys. Every client is signed out and signs in again.
- Logs: `railway logs --deployment --service <service-id>`.

Railway's own Claude Code plugin (`railway@railway-skills`) and its MCP server can run these steps; the order and the remote-mode specifics stay as written here.
