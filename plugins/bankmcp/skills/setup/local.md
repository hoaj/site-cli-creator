# Local path

BankMCP runs as a child process of Claude Code and keeps its state in `~/.bankmcp`. Its browser side (setup page and the bank's redirect) runs on `https://localhost:8080` with a certificate it makes for itself, because Enable Banking only accepts https redirect addresses.

## 1. Register the server

```
claude mcp add --scope user bankmcp -- npx -y bankmcp@VERSION
```

If port 8080 is taken, add `-e PORT=8085` before `--`.

Tell the user you will carry on after a restart, then have them exit Claude Code and run `claude -c`, which continues this conversation.

Done when `claude mcp list` shows `bankmcp … ✔ Connected` and the bankmcp tools are available.

## 2. Open the setup page

Call `list_accounts`. On a fresh install it answers with the local address (`https://localhost:8080`). Give it to the user and warn them that the browser flags the certificate once: in Chrome, "Advanced", then "Proceed to localhost"; in Safari, "Show Details", then "visit this website". It is the server they just started.

## 3. Register the Enable Banking application

On the page the user enters their email (their Enable Banking account, or the address to create one with), chooses **Production** and presses **Send me the sign-in link**. They click the link in the email on this computer. It returns to localhost and creates the application, its key and the settings in one go.

Done when the page shows "Key and id accepted" and `list_accounts` no longer says the server is not set up. It may say "not active" instead, which Step 3 handles.

Continue with Step 3 in [SKILL.md](SKILL.md).
