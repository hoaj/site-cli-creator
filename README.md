# logbuy

Find deals on Visma LogBuy (mylogbuy.com): search products, show a deal, browse categories.

A plugin for coding agents (Claude Code, Cursor, Codex, GitHub Copilot CLI). Each CLI skill in `skills/` wraps one site with a small compiled CLI that your agent runs for you. It notices when the site changes (Drift) and, once you agree, reports it here so it gets fixed.

**Maintainer:** [@hoaj](https://github.com/hoaj). Generated with [site-cli-creator](https://github.com/hoaj/skills/tree/main/plugins/site-cli-creator).

## Requirements

- [GitHub CLI](https://cli.github.com), logged in (`gh auth login`) with read access to [`hoaj/logbuy-plugin`](https://github.com/hoaj/logbuy-plugin). The CLI binaries are downloaded from this repo's releases with your own `gh`.
- [Google Chrome](https://www.google.com/chrome/), for CLI skills that sign in to a site or have write commands. The skill tells you when it needs it.
- macOS (Apple silicon or Intel), Linux (x64 or arm64) or Windows x64. On Windows the install step runs in Git Bash.

## Install

This repo is its own plugin marketplace, named `logbuy`: add the marketplace, then install the plugin from it.

### Claude Code

```
/plugin marketplace add hoaj/logbuy-plugin
/plugin install logbuy@logbuy
```

### Cursor

Settings → Plugins → Add marketplace → `hoaj/logbuy-plugin`, then install **logbuy**.

### Codex

```
codex plugin marketplace add hoaj/logbuy-plugin
codex plugin install logbuy
```

### GitHub Copilot CLI

```
copilot plugin marketplace add hoaj/logbuy-plugin
copilot plugin install logbuy@logbuy
```

There is no setup step. The first time your agent uses a CLI skill, it runs that skill's `install.sh`, which downloads the binary matching the skill's version into the skill's `bin/` folder. Skills that need a login open Chrome once for you to sign in.

## Update

Update the plugin in your agent's plugin manager (Claude Code: `/plugin update logbuy`). A new version lands in a new folder, so the agent downloads the matching binary on first use. Right after a release, the binary can take a few minutes to build; `install.sh` says so when it is not there yet.

## Report a problem

Ask your agent to "report this". The `logbuy-feedback` skill drafts a GitHub issue on `hoaj/logbuy-plugin` from the CLI's error output (shapes and type names, never your data), shows it to you, and files it only when you say yes. It also files requests for things the plugin cannot do yet.

To check whether the site changed or the problem is on your side, ask your agent to run the skill's `check` command.

## Maintaining

Changes are made with the site-cli-creator generator (`add-skill`, `add-task`, `fix`). Every change bumps the version (`bun run bump <patch|minor|major>`); merging it to `main` builds and publishes the release.
