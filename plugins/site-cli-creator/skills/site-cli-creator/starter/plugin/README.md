# __PLUGIN__

__DESCRIPTION__

A plugin for coding agents (Claude Code, Cursor, Codex, GitHub Copilot CLI). Each CLI skill in `skills/` wraps one site with a small compiled CLI that your agent runs for you. It notices when the site changes (Drift) and, once you agree, reports it here so it gets fixed.

**Maintainer:** [@__MAINTAINER__](https://github.com/__MAINTAINER__). Generated with [site-cli-creator](https://github.com/hoaj/skills/tree/main/plugins/site-cli-creator).

## Requirements

- [GitHub CLI](https://cli.github.com), logged in (`gh auth login`) with read access to [`__REPO__`](https://github.com/__REPO__). The CLI binaries are downloaded from this repo's releases with your own `gh`.
- [Google Chrome](https://www.google.com/chrome/), for CLI skills that sign in to a site or have write commands. The skill tells you when it needs it.
- macOS (Apple silicon or Intel), Linux (x64 or arm64) or Windows x64. On Windows the install step runs in Git Bash.

## Install

This repo is its own plugin marketplace, named `__PLUGIN__`: add the marketplace, then install the plugin from it.

### Claude Code

```
/plugin marketplace add __REPO__
/plugin install __PLUGIN__@__PLUGIN__
```

### Cursor

Settings → Plugins → Add marketplace → `__REPO__`, then install **__PLUGIN__**.

### Codex

```
codex plugin marketplace add __REPO__
codex plugin install __PLUGIN__
```

### GitHub Copilot CLI

```
copilot plugin marketplace add __REPO__
copilot plugin install __PLUGIN__@__PLUGIN__
```

There is no setup step. The first time your agent uses a CLI skill, it runs that skill's `install.sh`, which downloads the binary matching the skill's version into the skill's `bin/` folder. Skills that need a login open Chrome once for you to sign in.

### Any MCP client (Claude Desktop, Cursor, …)

Every CLI skill's binary is also an MCP server: `skills/<skill>/bin/<skill> mcp` serves the same Tasks as tools over stdio, with the same login, Drift checks and dry runs for writes. Clone this repo, get the binary once with `bash skills/<skill>/install.sh`, then add it to your client:

```json
{ "mcpServers": { "<skill>": { "command": "/path/to/__PLUGIN__/skills/<skill>/bin/<skill>", "args": ["mcp"] } } }
```

Claude Code: `claude mcp add <skill> -- /path/to/__PLUGIN__/skills/<skill>/bin/<skill> mcp` (the plugin above is the better fit there: it also brings the skills' guidance). Your session stays on your machine, in the same state dir the CLI uses.

### Remote mode (claude.ai and the phone)

To use a CLI skill from claude.ai or your phone, it has to run on a server you control. Ask your agent to deploy it: the `__PLUGIN__-deploy` skill walks through Railway, one server per CLI skill. You choose an Owner password that signs your clients in (the skill can generate one), give the server your Session on its Setup page (`/setup`), and add the server's `/mcp` address as a custom connector. It is for your own account only. A connector added in claude.ai also shows up in Claude Code; if you run the CLI skill's local `mcp` there too, turn the claude.ai one off with `/mcp`, or all claude.ai connectors with `"disableClaudeAiConnectors": true` in `~/.claude/settings.json`.

## Update

Update the plugin in your agent's plugin manager (Claude Code: `/plugin update __PLUGIN__`). A new version lands in a new folder, so the agent downloads the matching binary on first use. Right after a release, the binary can take a few minutes to build; `install.sh` says so when it is not there yet.

## Report a problem

Ask your agent to "report this". The `__PLUGIN__-feedback` skill drafts a GitHub issue on `__REPO__` from the CLI's error output (shapes and type names, never your data), shows it to you, and files it only when you say yes. It also files requests for things the plugin cannot do yet.

To check whether the site changed or the problem is on your side, ask your agent to run the skill's `check` command.

## Maintaining

Changes are made with the site-cli-creator generator (`add-skill`, `add-task`, `fix`). Every change bumps the version (`bun run bump <patch|minor|major>`); merging it to `main` builds and publishes the release.
