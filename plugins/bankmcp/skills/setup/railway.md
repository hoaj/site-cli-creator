# Railway path

BankMCP runs on Railway with a volume at `/data` and a public https domain. The admin password goes in **before the first deploy**. A fresh server without one shows its setup page to whoever opens the URL first, and that visitor gets to choose the password. Keep this order: domain, then password, then deploy.

## 1. Railway CLI and account

Run `railway whoami`. If the CLI is missing: `brew install railway` (or `npm i -g @railway/cli`). If the user isn't signed in: `railway login`, which opens their browser and creates an account if needed.

Done when `railway whoami` prints their account.

## 2. Get the pinned code

```
git clone --depth 1 --branch vVERSION https://github.com/noskillish/bankmcp ~/bankmcp
```

Run every `railway` command below from `~/bankmcp`. The folder is also how they redeploy later.

## 3. Project, service, volume and domain, without deploying yet

```
cd ~/bankmcp
railway init --name bankmcp
railway add --service bankmcp
railway service link bankmcp
railway volume add --mount-path /data
railway domain --port 8080 --service bankmcp --json
```

`railway init` asks for a workspace when there are several. Record the domain as BASE (`https://….up.railway.app`). The domain has to exist before the first deploy, because the server reads its own address from Railway when it boots.

Done when `railway volume list` shows one volume at `/data` and BASE is known.

## 4. Password

On macOS, generate it straight into the Keychain so it never appears in the chat:

```
PW=$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-28)
security add-generic-password -U -a bankmcp -s "BankMCP Railway" -w "$PW"
HASH=$(cd ~ && npx -y bankmcp@VERSION hash-password "$PW")
unset PW
railway variable set "ADMIN_PASSWORD_HASH=$HASH" --service bankmcp >/dev/null
unset HASH
```

Run `npx` from `~`: inside a bankmcp checkout it resolves the local package and fails with `bankmcp: command not found`. The user copies the password later with `security find-generic-password -s "BankMCP Railway" -w | pbcopy`.

On other systems, the user creates a password of 24+ characters in their password manager and runs `! cd ~ && npx -y bankmcp@VERSION hash-password`, which asks for it without echoing. Set the printed hash with the same `railway variable set` line.

Done when `railway variable list --service bankmcp --json` has `ADMIN_PASSWORD_HASH` starting with `scrypt$`. Check the prefix only; keep the value off the screen.

## 5. Deploy

```
railway up --service bankmcp --detach -m "BankMCP vVERSION"
```

Poll `railway deployment list --service bankmcp --json` until this deployment is `SUCCESS`. On `FAILED` or `CRASHED`, read `railway logs --service bankmcp --lines 100`.

Done when `curl -s BASE/healthz` returns `"ok":true` and `"configured":false`.

## 6. Register the Enable Banking application, right away

The user opens BASE, enters their email, chooses **Production** and presses **Send me the sign-in link**. On a hosted server the link can't finish on its own: they copy the link from the email (or, if they already clicked it, the address in the browser bar) and paste it into the page.

Done when `curl -s BASE/healthz` shows `"configured":true` and `curl -s -o /dev/null -w '%{http_code}' -X POST BASE/setup` returns `404`, meaning setup is closed.

## 7. Connectors

The connector URL is `BASE/mcp`. Connect Claude Code first, so you can finish the setup from here, then the apps the user asked for.

- **Claude Code**: `claude mcp add --transport http --scope user bankmcp BASE/mcp`. The user restarts (`claude -c`), then runs `/mcp`, selects bankmcp, chooses Authenticate and pastes the password.
- **claude.ai, Claude Desktop and the phone app**: Settings, Connectors, Add custom connector, paste the URL, Connect, password. On Team and Enterprise plans only owners can add custom connectors.
- **ChatGPT**: Settings, Apps & Connectors, Create (turn on Developer mode under Advanced if Create is missing), paste the URL, choose OAuth, password.

Done when the bankmcp tools are available in this session and `railway logs --service bankmcp --lines 200 | grep "sign-in from"` shows only the user's own sign-ins.

Continue with Step 3 in [SKILL.md](SKILL.md).

## Later

- **Update**: `git -C ~/bankmcp fetch --depth 1 origin tag vNEW && git -C ~/bankmcp checkout vNEW`, then `railway up --service bankmcp` from `~/bankmcp`.
- **Sign-in alerts**: set `NOTIFY_WEBHOOK_URL` on the service (a Slack incoming webhook or any https URL that accepts a JSON POST). Every sign-in then sends a message.
