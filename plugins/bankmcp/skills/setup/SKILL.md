---
name: setup
description: Use when the user wants to set up BankMCP, the self-hosted read-only MCP server that lets Claude or ChatGPT read their own bank accounts through Enable Banking (PSD2), either on this computer or hosted on Railway. Triggers "set up bankmcp", "connect my bank to Claude", "host bankmcp on Railway", or a bankmcp tool answering that the server is not set up or the Enable Banking application is not active.
---

# BankMCP setup

Take one person from nothing to "list my accounts" answering from their own BankMCP server. There are two paths: **local** (on this computer, for Claude Code) and **Railway** (hosted, for claude.ai, the Claude phone app, ChatGPT and Claude Code on any computer).

You run the commands. The user does what needs their browser, their email or their bank: the Enable Banking sign-in, the bank login (MitID in Denmark) and the connector settings in their apps. Passwords and bank logins are typed only into the user's browser, never into the chat.

## Step 1: Preflight

- `node --version` must be 24 or newer. If not, ask the user to install the current LTS from https://nodejs.org and wait.
- `npm view bankmcp version` gives the current release; call it VERSION. Pin every install to it (`bankmcp@VERSION`, git tag `vVERSION`) so the code only changes when the user decides to update.
- Tell the user in two sentences what they are agreeing to: the server is read-only and has no payment tools, and their balances and transactions pass through Enable Banking (a licensed provider in Finland) and show up in the chats where they ask about them. It takes about 15 minutes and two bank logins.

Done when Node is 24+ and VERSION is known.

## Step 2: Pick the path

Ask one question: which apps will they use it from?

- Only Claude Code on this computer: follow [local.md](local.md).
- claude.ai, the phone app, ChatGPT or several computers: follow [railway.md](railway.md). Railway is a paid host (its Hobby plan) and needs an account.

Done when the path file's last step is done: the Enable Banking application is registered and the bankmcp tools are available in this session.

## Step 3: Activate the Enable Banking application

A new production application starts **Inactive**, and until it is activated every bank call fails with "application is not active". Ask the user to open https://enablebanking.com/cp/applications, pick the BankMCP application whose Redirect URL is this server's `/callback` address (ignore any others), press **Activate by linking accounts**, choose their bank and log in.

Done when `list_banks` for their country returns banks instead of the "not active" error.

## Step 4: Connect the bank

Call `list_banks` with their country and a search term, then `start_consent` with the exact bank name. Give the user the URL; they log in at the bank, approve read access and land on a "Bank connected" page.

Done when `list_accounts` lists their accounts. Show them as a table, then offer names with `set_account_label` (their own words, e.g. "Forbrug", "Faste udgifter").

## Step 5: Hand-over

Tell the user the three things worth keeping:

- Bank access lasts up to 180 days; renew it by saying "connect my bank".
- Kill switch: local, delete `~/.bankmcp`; Railway, set a new `ADMIN_PASSWORD_HASH`, which logs out every device.
- To cut the bank off completely, delete the application in the Enable Banking Control Panel.

## Troubleshooting

- **Tools missing right after `claude mcp add`**: Claude Code loads MCP servers when it starts, and `/mcp` only reconnects servers it already knows. The user exits and runs `claude -c`, which continues this conversation.
- **"Needs authentication"** (Railway): `/mcp`, select bankmcp, Authenticate. Or call the server's `authenticate` tool and give the user its URL. The sign-in page names the host it returns to, and for Claude Code that is localhost.
- **`/mcp` lists the server under "User" or "Local"**: that is where the setting is stored, not where the server runs. An http server with an `https://…railway.app` URL is the hosted one.
- **Enable Banking refuses to create the application (401)**: a brand-new Enable Banking account has to accept their terms first. The user signs in at enablebanking.com once, accepts, and starts again from the setup page.
- **Sign-in link rejected**: each link works once and within 30 minutes. Request a new one from the setup page.
- **A tool says the consent is no longer valid**: run `start_consent` again; nothing else is lost.
