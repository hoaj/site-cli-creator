# logbuy

Find deals on Visma LogBuy (mylogbuy.com): search products, show a deal, browse categories.

A plugin for coding agents (Claude Code, Cursor, GitHub Copilot CLI). Each CLI skill in `skills/` wraps one site with a small compiled CLI that your agent runs for you. It notices when the site changes (Drift) and, once you agree, reports it so it gets fixed.

**Maintainer:** [@hoaj](https://github.com/hoaj). Generated with [site-cli-creator](../site-cli-creator). It lives in [`hoaj/skills`](https://github.com/hoaj/skills) and ships through its `hoaj-skills` marketplace.

## Requirements

- [GitHub CLI](https://cli.github.com), logged in (`gh auth login`) with read access to [`hoaj/skills`](https://github.com/hoaj/skills). The CLI binaries are downloaded from that repo's `logbuy-v<version>` releases with your own `gh`.
- [Google Chrome](https://www.google.com/chrome/), for CLI skills that sign in to a site or have write commands. The skill tells you when it needs it.
- macOS (Apple silicon or Intel), Linux (x64 or arm64) or Windows x64. On Windows the install step runs in Git Bash.

## Install

Add the `hoaj-skills` marketplace, then install the plugin from it.

### Claude Code

```
/plugin marketplace add hoaj/skills
/plugin install logbuy@hoaj-skills
```

### Cursor

Settings → Plugins → Add marketplace → `hoaj/skills`, then install **logbuy**.

### GitHub Copilot CLI

```
copilot plugin marketplace add hoaj/skills
copilot plugin install logbuy
```

There is no setup step. The first time your agent uses a CLI skill, it runs that skill's `install.sh`, which downloads the binary matching the skill's version into the skill's `bin/` folder. Skills that need a login open Chrome once for you to sign in.

## Update

Update the plugin in your agent's plugin manager (Claude Code: `/plugin update logbuy`). A new version lands in a new folder, so the agent downloads the matching binary on first use. Right after a release, the binary can take a few minutes to build; `install.sh` says so when it is not there yet.

## Report a problem

Ask your agent to "report this". The `logbuy-feedback` skill drafts a GitHub issue on `hoaj/skills`, labelled `logbuy`, from the CLI's error output (shapes and type names, never your data), shows it to you, and files it only when you say yes. It also files requests for things the plugin cannot do yet.

To check whether the site changed or the problem is on your side, ask your agent to run the skill's `check` command.

## Maintaining

Changes are made with the site-cli-creator generator (`add-skill`, `add-task`, `fix`), with `plugins/logbuy` as the plugin root and `hoaj/skills` as its repo. Every change bumps the version (`cd plugins/logbuy && bun run bump <patch|minor|major>`); merging it to `main` builds and publishes the release `logbuy-vX.Y.Z` (`.github/workflows/logbuy-release.yml`). CI for the plugin is `.github/workflows/logbuy-ci.yml`; both run only when `plugins/logbuy/` changes.

Issues for this plugin are the ones labelled `logbuy`: `gh issue list --repo hoaj/skills --label logbuy`.
